#!/usr/bin/env node
/**
 * Installs zencli's Claude Code Stop hook into ~/.claude/settings.json.
 *
 * The hook runs `printf '\033]1337;done\a'` every time Claude finishes a
 * response. zencli catches that OSC 1337 sequence in the renderer and flips
 * the tab's "waiting for input" color — much more precise than our 500ms
 * idle heuristic.
 *
 * Idempotent: run it as many times as you like. Won't duplicate the hook,
 * won't clobber other hooks, won't touch the file if we can't parse it as
 * plain JSON.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_COMMAND = "printf '\\033]1337;done\\a'";
const HOOK_ENTRY = {
  matcher: '',
  hooks: [{ type: 'command', command: HOOK_COMMAND }],
};

// Tag so we can recognize a zencli-installed hook later (for idempotency and
// future uninstall). Kept inside the command string as a trailing shell
// no-op comment so Claude Code's command runner ignores it.
const ZENCLI_TAG = '# zencli:claude-stop-hook';
const TAGGED_COMMAND = `${HOOK_COMMAND} ${ZENCLI_TAG}`;

function log(msg) {
  // Prefix so output is obvious when buried in npm install noise.
  process.stdout.write(`[zencli] ${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`[zencli] ${msg}\n`);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return { settings: {}, existed: false };
  }

  const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');

  // If the file is empty or whitespace, treat as empty settings.
  if (!raw.trim()) {
    return { settings: {}, existed: true, raw };
  }

  // settings.json may be JSONC in some setups (comments). JSON.parse rejects
  // comments. Detect them and bail out with a clear message rather than
  // silently lose the user's comments on rewrite.
  if (/^\s*\/\//m.test(raw) || /\/\*[\s\S]*?\*\//.test(raw)) {
    throw new Error(
      'settings.json contains comments (JSONC). Refusing to rewrite to avoid losing them. Add the hook manually — see README.'
    );
  }

  try {
    return { settings: JSON.parse(raw), existed: true, raw };
  } catch (err) {
    throw new Error(`settings.json is not valid JSON: ${err.message}`);
  }
}

function hookAlreadyInstalled(settings) {
  const stop = settings?.hooks?.Stop;
  if (!Array.isArray(stop)) return false;

  for (const entry of stop) {
    const hooks = entry?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      if (typeof h?.command !== 'string') continue;
      // Match either the tagged or plain OSC 1337 command — don't re-install
      // if a user hand-rolled it from the README snippet.
      if (h.command.includes("\\033]1337;done") || h.command.includes('\u001b]1337;done')) {
        return true;
      }
    }
  }
  return false;
}

function installHook(settings) {
  const next = { ...settings };
  next.hooks = { ...(settings.hooks || {}) };
  const existingStop = Array.isArray(next.hooks.Stop) ? next.hooks.Stop : [];
  next.hooks.Stop = [
    ...existingStop,
    {
      matcher: '',
      hooks: [{ type: 'command', command: TAGGED_COMMAND }],
    },
  ];
  return next;
}

function main() {
  let existed = false;
  let settings = {};

  try {
    const read = readSettings();
    settings = read.settings;
    existed = read.existed;
  } catch (err) {
    warn(err.message);
    warn('Skipping auto-install. zencli will still work — the tab will use');
    warn('the 500ms idle heuristic instead of the precise Stop hook.');
    return;
  }

  if (hookAlreadyInstalled(settings)) {
    log('Claude Code Stop hook already installed. Nothing to do.');
    return;
  }

  const next = installHook(settings);
  ensureDir(SETTINGS_PATH);
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');

  if (existed) {
    log(`Added Stop hook to ${SETTINGS_PATH}`);
  } else {
    log(`Created ${SETTINGS_PATH} with Stop hook`);
  }
  log('Claude will now emit OSC 1337 on every response — zencli tabs will');
  log('flip to "waiting" color the instant Claude finishes.');
}

main();
