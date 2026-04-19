# Contributing to zencli

Thanks for your interest. zencli is small on purpose — a focused wrapper
around Claude Code with a browser sidebar. PRs are welcome; the goal is
to keep the surface area tight and the code honest about its limits.

## Dev setup

```bash
git clone https://github.com/yuvalsuede/zencli.git
cd zencli
npm install        # also rebuilds node-pty against Electron's Node
npm run start:fg   # foreground mode — logs inline, Ctrl-C kills it
```

Use `start:fg` while hacking on Electron main — it's much easier to see
crashes and stack traces than the detached `npm start`.

If `node-pty` complains about a native module version mismatch after an
Electron upgrade:

```bash
npm run rebuild
```

## Project layout

```
electron/
  main.js        # Electron main — window, sidebar views, pty IPC, state wiring
  preload.js     # contextBridge — the only renderer ↔ main surface
  state.js       # ~/.zencli/state.json persistence (atomic writes, debounced)
src/
  index.html     # shell of the window
  renderer.js    # terminal tabs + sidebar controls, xterm.js
  styles.css     # the whole UI
scripts/
  start-bg.sh            # detached launcher (nohup + disown)
  stop.sh                # SIGTERM → SIGKILL fallback
  install-claude-hook.js # idempotent installer for the Claude Code Stop hook
```

## Style

- Small, readable diffs. If a change needs a long explanation, prefer
  splitting it.
- Comments explain **why**, not **what**. The code shows what.
- Be honest about limits in docs and commit messages. If something only
  works on macOS, say so. If a heuristic has known false positives, say
  so. "Never lie" is the one hard project rule.
- Prefer plain JS over build tooling. No TypeScript, no bundler. Keep
  the dev loop zero-config.

## Running the Stop-hook installer

`npm install` auto-wires the Claude Code Stop hook into
`~/.claude/settings.json` so zencli can flip tab colors to "done" with
zero lag. The installer is idempotent — safe to re-run:

```bash
npm run install-hook
```

It refuses to modify `settings.json` if the file contains comments
(JSONC). If it bails, the README shows the manual entry to paste in.

## Filing issues

Helpful bug reports include:

1. macOS version + `electron --version` + `node --version`
2. Contents of `/tmp/zencli.log` (or wherever `ZENCLI_LOG` points)
3. Whether you're in `npm start` (detached) or `npm run start:fg`
4. Whether the issue reproduces with a fresh `~/.zencli/state.json`
   (rename the old one, relaunch)

## PRs

- One concern per PR. If you're fixing a bug and also refactoring, two
  PRs.
- Run `node --check electron/*.js src/renderer.js` before pushing.
- If you change the UI, a before/after screenshot in the PR description
  goes a long way.
- If your change affects the persisted state schema in
  `electron/state.js`, bump `SCHEMA_VERSION` and note the migration path
  in the PR description.

## Scope

Things I'm happy to merge:
- Bug fixes, perf wins, readability cleanups
- Linux support (I only test on macOS)
- Better Claude Code hook integration (PreToolUse, Notification, etc.)
- Sidebar features (pinned tabs, pop-out, bookmarks) that don't bloat
  the core terminal UX
- tmux-backed terminal sessions for true process persistence

Things I'm likely to decline:
- Big framework migrations (TypeScript, React, etc.) without a clear
  reason tied to a user-visible problem
- Features that require a config file. Prefer sensible defaults and a
  code change for power users.

## License

By contributing, you agree that your contributions will be licensed
under the [MIT License](./LICENSE).
