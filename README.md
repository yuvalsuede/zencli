# zencli

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#install)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

Electron-based terminal for Claude Code with a persistent mini-browser
sidebar. Multiple terminal tabs on the left, multiple browser tabs on the
right. Audio and video in inactive sidebar tabs keep playing — each browser
tab is its own native `WebContentsView` attached to the window.

## Install

Requires Node 20+ and macOS (tested path).

```bash
cd zencli
npm install           # also rebuilds node-pty against Electron's Node
npm start             # launches detached — command returns immediately
npm run stop          # graceful SIGTERM, falls back to SIGKILL after 3s
```

`npm start` runs zencli fully detached from the launching terminal via
`nohup` + `disown`, so closing the terminal or Ctrl-C-ing your shell
won't kill your Claude sessions. Logs land in `/tmp/zencli.log`, pidfile
in `/tmp/zencli.pid`. The launcher is idempotent — running `npm start`
twice won't spawn a second instance.

Override the log / pidfile paths:

```bash
ZENCLI_LOG=~/zencli.log ZENCLI_PID=~/.zencli.pid npm start
```

If you want the old foreground behavior (inline logs, Ctrl-C kills it —
useful for debugging the Electron main process itself):

```bash
npm run start:fg
```

If node-pty complains at runtime about a native module version mismatch, run:

```bash
npm run rebuild
```

## Layout

```
+-------------------------------------+-------------------+
|  [term 1] [term 2] [+]              | [yt] [docs] [+]   |
|                                     | ‹ › ↻  [url]    ⇥ |
+-------------------------------------+-------------------+
|                                     |                   |
|   xterm.js terminal (active tab)    |   Active sidebar  |
|                                     |   tab's website   |
|                                     |   — inactive tabs |
|                                     |   keep playing    |
+-------------------------------------+-------------------+
                                      ^ drag to resize
```

## Tab recovery

State is persisted to `~/.zencli/state.json` — atomic writes, debounced
500ms, flushed synchronously on quit. If zencli crashes, gets force-
killed, or the machine reboots, the next launch restores:

- Window size and position (clamped to an attached display, so
  disconnecting an external monitor doesn't strand the window off-screen)
- Sidebar width and visible/hidden state
- Sidebar browser tabs — full recovery, URLs reload cleanly
- Active sidebar tab
- Terminal tab count, order, labels, and last-known cwd
- Active terminal tab

**Honest limit:** terminal *process* state cannot survive zencli exiting.
When zencli dies, the ptys die, and so does everything inside them —
zsh, Claude, whatever. The tabs come back with the right labels and in
the right working directory, but they're fresh zsh processes. For
Claude sessions, `claude --continue` inside the restored cwd resumes
that project's most recent session, so you lose ~one turn of context
in the worst case, not the whole conversation.

For true process persistence (Claude keeps running while zencli is
closed), the right tool is `tmux` — zencli would attach/detach rather
than own the shells. That's a much bigger change; if you want it, say
so and we'll do it as a follow-up.

### cwd tracking

zencli listens for OSC 7 (`\033]7;file://host/path\a`), which macOS's
default zsh emits on every directory change. If your shell emits OSC 7,
each tab's cwd stays up to date live. If it doesn't, the saved cwd is
whatever the tab was spawned in (homedir for new tabs). To wire it up
manually in zsh, add to `~/.zshrc`:

```zsh
function chpwd_osc7 { printf '\033]7;file://%s%s\a' "$HOST" "$PWD" }
chpwd_functions+=(chpwd_osc7)
chpwd_osc7
```

## Shortcuts

- `⌘T` new terminal tab (zsh)
- `⌘W` close current terminal tab
- `⌘1`…`⌘9` jump to terminal tab N
- `⌘⇧T` new sidebar tab
- `⌘⇧B` toggle sidebar
- Drag the thin divider to resize the sidebar

## First terminal tab

Plain interactive zsh — acts exactly like opening Terminal.app. Type
`claude` to start Claude Code; exit claude and you're back at your shell
prompt. The first-tab boot command lives in the `newTab('zsh')` call near
the bottom of `src/renderer.js`.

## Activity indicators

Tab decorations reflect Claude Code state on **inactive** tabs only.
The tab you're currently looking at stays neutral — you can see what's
happening in the terminal itself, so the tab bar doesn't need to shout.
Plain shell work (zsh, ls, cd, etc.) leaves the tab neutral regardless.

- **gray + spinner** — Claude is thinking / producing output.
- **green** — Claude finished responding and is waiting for your input.
  Set by an explicit signal (terminal bell or the OSC 1337 Stop hook),
  never by the 500ms idle heuristic — so you don't see flashes between
  tool calls or during thinking pauses.
- **neutral (dark)** — active tab, plain shell, or a fresh tab.

### How "in Claude Code" is detected

A tab is in Claude mode when its terminal title contains **"claude"**
(Claude Code sets the title via `OSC 0/2` — typically to "Claude Code"
or "* Claude Code"). Plain shell tabs leave the title alone, so they
stay neutral.

**Known caveat:** Claude Code does not use the alternate screen buffer
(it renders inline so terminal scrollback works), and zsh does not reset
the terminal title on its own. So after you exit a Claude session, the
title — and therefore the colors — can linger on the tab until you close
it or another program overwrites the title. Mentioned here so you know
it's a known limitation, not a bug.

### Two things flip an in-Claude tab to green ("done")

Whichever fires first:

1. Terminal bell (`\a`) — Claude rings it with notifications enabled.
2. OSC 1337 — explicit escape a script can emit:
   `printf '\033]1337;done\a'`. The Stop hook auto-installed by
   `npm install` emits exactly this on every Claude response finish.

The 500ms idle heuristic used to be a third signal but was removed — it
caused the tab to blink green/gray every time Claude paused mid-response
for a tool call or thinking block. The spinner is now the single source
of "still working," and the bell / OSC 1337 are the single source of
"done."

Tab labels also auto-update from the terminal title (`OSC 0` / `OSC 2`
escape sequences). Programs like `claude` set this, so the first tab's
label will flip from "zsh" to whatever claude writes (e.g. the model
name or a session hint).

### Claude Code notifications

`npm install` auto-wires a `Stop` hook into `~/.claude/settings.json` so
Claude Code emits OSC 1337 the instant it finishes a response — zencli
catches it and flips the tab color to "waiting" with zero lag. Much more
precise than the 500ms idle heuristic.

The installer (`scripts/install-claude-hook.js`) is idempotent:

- Run it any number of times; it won't duplicate the hook.
- Won't clobber other `Stop` hooks you've configured.
- Refuses to rewrite `settings.json` if it contains comments (JSONC) —
  it'd have to parse-and-serialize and would lose your comments.
- Re-run manually any time with: `npm run install-hook`

If auto-install bails (JSONC, malformed JSON, etc.) add this entry to
`~/.claude/settings.json` by hand — the bell-based fallback still works
if Claude Code notifications are enabled, but this is the precise path:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "printf '\\033]1337;done\\a'" }
        ]
      }
    ]
  }
}
```

## Sidebar tabs

- Click `+` in the sidebar tab strip (or `⌘⇧T`) to open a new tab.
- Click a tab to switch to it. Inactive tabs keep running in the
  background — if you open YouTube in tab 1 and something else in tab 2,
  YouTube audio keeps playing after you switch.
- Click `×` on a tab to close it. The last tab can be closed too; the
  sidebar chrome stays visible and you can open a new tab with `+`.
- The URL bar, back / forward / reload all act on the currently active
  sidebar tab.
- New sidebar tabs start on YouTube. Change the default in
  `electron/main.js` (see `createSidebarTab` and `sidebar:new-tab`
  handler).

## Customize

- **Default starting page** — `createSidebarTab` default in
  `electron/main.js` (currently https://www.youtube.com).
- **First-tab command** — last line of `src/renderer.js`.
- **New-tab command** — the `newTabBtn` click handler and the `⌘T`
  shortcut in `src/renderer.js` both call `newTab('zsh')`.
- **Theme** — `src/styles.css` and the xterm `theme` block in
  `src/renderer.js`.

## How it works

- Each sidebar tab is its own `WebContentsView` attached to
  `mainWindow.contentView`. Inactive tabs get `setBounds({0,0,0,0})` — still
  attached (audio keeps playing), but take no screen space.
- Each terminal tab owns its own `node-pty` child + xterm.js instance.
  Switching tabs only toggles `display:none` on the inactive terminal's DOM
  node — the pty keeps running and buffering.
- URL bar / tab titles update from `did-navigate` / `did-navigate-in-page`
  / `page-title-updated` events forwarded through IPC — no polling.
- The HTML `#sidebar` is a layout placeholder; the actual browser pixels
  come from the native view layered on top of `#sidebar-webview-slot`,
  positioned by main to match its bounds. The chrome (tab strip + nav
  row) is plain HTML — the view sits at `y: SIDEBAR_CHROME_HEIGHT`
  so the chrome is clickable.

## Extending

Good next steps:

1. **Richer activity states via Claude Code hooks.** Today the dot is
   running / unread / idle. Additional hooks (`PreToolUse`, `PostToolUse`,
   `Notification`) could emit distinct OSC sequences so the tab can
   distinguish "running tool X" from "waiting for your input".
2. **Prompt-pattern detection.** ANSI-buffer scanning for a stable prompt
   shape would give a generic "idle at prompt" state for non-claude CLIs
   that don't ring the bell.
3. **Pinned / pip.** Pop the YouTube view out of the window into its own
   always-on-top mini window.
4. **Pair a terminal tab with a sidebar tab.** Switching terminal tabs
   auto-switches to the associated sidebar tab.

## Known gotchas

- `node-pty` is a native module — it MUST be rebuilt for Electron's Node
  version. The `postinstall` hook handles this, but CI or fresh clones may
  need `npm run rebuild`.
- `WebContentsView` requires Electron 30+. Older versions use the
  (deprecated) `BrowserView` API with a similar shape.
- `SIDEBAR_CHROME_HEIGHT` in `electron/main.js` and the combined height of
  the tab strip (30px) + nav row (36px) in `src/styles.css` must stay in
  sync, or the native view will either cover part of the chrome or leave
  a blank band below it.

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, the
project layout, and what's in/out of scope.

Quick start for hacking: `npm install && npm run start:fg` — foreground
mode makes Electron main crashes visible instead of hiding them in the
detached log.

## License

[MIT](./LICENSE) © yuval suede

Third-party notices: zencli bundles Electron, node-pty, and xterm.js —
each under its own license. See their respective `LICENSE` files under
`node_modules/` once installed.
