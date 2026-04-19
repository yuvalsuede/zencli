/**
 * Persistent state for zencli — window geometry, sidebar state, and the
 * list of open tabs. Written to ~/.zencli/state.json.
 *
 * What's recovered on next launch:
 *   - Window size/position (so it opens where you left it)
 *   - Sidebar width, visible/hidden
 *   - Sidebar browser tabs (URLs reload cleanly — browsers are stateless
 *     from our perspective)
 *   - Active sidebar tab index
 *   - Terminal tab count + labels + last-known cwd + active index
 *
 * What's NOT recovered (honest about the limit):
 *   - Terminal process state. zsh / claude / anything running inside a
 *     terminal tab dies when zencli dies. The tab comes back empty;
 *     inside a Claude project, `claude --continue` resumes the last
 *     session for that cwd.
 *
 * Write strategy:
 *   - Debounced 500ms — avoids fsync storm on rapid events
 *   - Atomic via write-tmp-then-rename
 *   - Flushed synchronously on before-quit
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.zencli');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const TMP_PATH = path.join(STATE_DIR, 'state.json.tmp');
const SCHEMA_VERSION = 1;

const DEFAULT_STATE = Object.freeze({
  version: SCHEMA_VERSION,
  window: null, // { x, y, width, height, maximized } — null = use defaults
  sidebar: {
    width: 440,
    visible: true,
    tabs: [{ url: 'https://www.youtube.com' }],
    activeIndex: 0,
  },
  terminals: {
    tabs: [], // [{ label, cwd, labelSource }] — labelSource: 'folder' | 'user'
    activeIndex: 0,
  },
});

let current = clone(DEFAULT_STATE);
let dirty = false;
let flushTimer = null;

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function load() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      current = clone(DEFAULT_STATE);
      return current;
    }
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Future-proof: if schema version bumps, prefer defaults over a
    // confused half-migration.
    if (parsed?.version !== SCHEMA_VERSION) {
      current = clone(DEFAULT_STATE);
      return current;
    }
    // Merge defensively — any missing fields fall back to defaults so
    // we don't crash on partial writes from a past version.
    current = {
      version: SCHEMA_VERSION,
      window: parsed.window ?? null,
      sidebar: {
        width: Number.isFinite(parsed.sidebar?.width)
          ? parsed.sidebar.width
          : DEFAULT_STATE.sidebar.width,
        visible: typeof parsed.sidebar?.visible === 'boolean'
          ? parsed.sidebar.visible
          : DEFAULT_STATE.sidebar.visible,
        tabs: Array.isArray(parsed.sidebar?.tabs) && parsed.sidebar.tabs.length
          ? parsed.sidebar.tabs.filter((t) => t && typeof t.url === 'string')
          : clone(DEFAULT_STATE.sidebar.tabs),
        activeIndex: Number.isInteger(parsed.sidebar?.activeIndex)
          ? parsed.sidebar.activeIndex
          : 0,
      },
      terminals: {
        tabs: Array.isArray(parsed.terminals?.tabs)
          ? parsed.terminals.tabs.filter((t) => t && typeof t === 'object')
          : [],
        activeIndex: Number.isInteger(parsed.terminals?.activeIndex)
          ? parsed.terminals.activeIndex
          : 0,
      },
    };
    return current;
  } catch (err) {
    // Corrupt state file — back it up so the user can inspect, then
    // start fresh. Don't throw: recovery should never prevent launch.
    try {
      const backup = STATE_PATH + '.corrupt-' + Date.now();
      fs.renameSync(STATE_PATH, backup);
      process.stderr.write(`[zencli] state.json was corrupt, moved to ${backup}\n`);
    } catch {}
    current = clone(DEFAULT_STATE);
    return current;
  }
}

function get() {
  return current;
}

function update(mutator) {
  mutator(current);
  dirty = true;
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 500);
}

function flush() {
  if (!dirty) return;
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    fs.writeFileSync(TMP_PATH, JSON.stringify(current, null, 2), 'utf8');
    fs.renameSync(TMP_PATH, STATE_PATH);
    dirty = false;
  } catch (err) {
    // Best-effort — next flush will try again. Log but don't crash the app.
    process.stderr.write(`[zencli] failed to write state.json: ${err.message}\n`);
  }
}

function flushSync() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush();
}

module.exports = {
  load,
  get,
  update,
  flushSync,
  STATE_PATH,
};
