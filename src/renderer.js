// Depends on global Terminal and FitAddon from xterm UMD builds in index.html
const { Terminal } = window;
const FitAddon = window.FitAddon.FitAddon;

// --- DOM ---

const tabsEl = document.getElementById('tabs');
const termsEl = document.getElementById('terminals');
const newTabBtn = document.getElementById('new-tab');

const sidebarEl = document.getElementById('sidebar');
const divider = document.getElementById('divider');
const urlInput = document.getElementById('sb-url');

const sidebarTabsEl = document.getElementById('sidebar-tabs');
const sbNewTabBtn = document.getElementById('sb-new-tab');

// --- Terminal tabs ---

let nextId = 1;
let activeId = null;
const tabs = new Map(); // id -> { tabEl, labelEl, termEl, term, fit, cleanupData, cleanupExit }

// Per-tab activity state from main process. The tab decorations ONLY
// appear on inactive tabs and ONLY inside Claude Code:
//   running → gray + spinner   (Claude is thinking)
//   unread  → green            (Claude finished responding, waiting for input)
//   neutral → dark              (plain shell, or never ran Claude)
//
// "In Claude Code" is `t.claudeMode`, set by the title-based detector in
// newTab. Outside Claude Code we don't paint anything.
//
// `onState` only toggles `.running`. It deliberately does NOT flip
// running→unread on the 500ms idle heuristic anymore — that caused
// blinking because Claude pauses >500ms between tool calls / thinking
// blocks, and every pause would flash the tab green. `.unread` is set
// by the "done" signals wired in newTab:
//   1. OSC 1337 from our installed Stop hook (precise, latches instantly)
//   2. Bell (\a) when Claude Code notifications are enabled
//   3. Fallback: 3s of zero pty output while in claudeMode — covers the
//      case where the current Claude session predates the hook install
//      (Claude only reads settings.json at session start) or notifications
//      are off.
//
// Grace window: after .unread is set, a transient 'running' event inside
// 1500ms is ignored. Without this, Claude's prompt-box redraw right after
// the Stop hook triggers `running` for a few hundred ms and wipes the
// green we just painted. A later 'running' event (i.e. user/Claude
// actually starting a new turn) clears .unread as expected.
window.api.pty.onState(({ id, state }) => {
  const t = tabs.get(id);
  if (!t) return;
  if (!t.claudeMode) return;
  const running = state === 'running';
  t.tabEl.classList.toggle('running', running);
  if (running && Date.now() - (t.unreadSetAt || 0) > 1500) {
    // Resumed — clear any stale "done" state from the previous turn.
    t.tabEl.classList.remove('unread');
  }
});

// Push current terminal-tab state to main so it can be restored on the
// next launch. Debounced inside main. Called after every create / close /
// activate / title change.
function syncTerminalsToState() {
  const list = [...tabs.entries()].map(([, t]) => ({
    label: t.labelEl?.textContent || 'zsh',
    cwd: t.cwd || undefined,
  }));
  const activeIndex = [...tabs.keys()].indexOf(activeId);
  try {
    window.api.state?.setTerminals({
      tabs: list,
      activeIndex: activeIndex < 0 ? 0 : activeIndex,
    });
  } catch {}
}

async function newTab(label = 'zsh', cmd = null, opts = {}) {
  const id = nextId++;

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  const dotEl = document.createElement('span');
  dotEl.className = 'dot';
  const labelEl = document.createElement('span');
  labelEl.className = 'label';
  labelEl.textContent = label;
  const closeEl = document.createElement('span');
  closeEl.className = 'close';
  closeEl.textContent = '×';
  tabEl.append(dotEl, labelEl, closeEl);
  tabEl.addEventListener('click', () => activate(id));
  closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
  tabsEl.appendChild(tabEl);

  const termEl = document.createElement('div');
  termEl.className = 'term';
  termEl.style.display = 'none';
  termsEl.appendChild(termEl);

  const term = new Terminal({
    fontFamily: 'Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    theme: {
      background: '#1a1a1a',
      foreground: '#eaeaea',
      cursor: '#eaeaea',
      selectionBackground: '#444',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termEl);

  // Measure before spawning the pty so the child process starts with the
  // right $COLUMNS/$LINES. We defer two RAFs so flex layout has actually
  // settled — fitting too early gave us an 80-col pty even when the pane
  // was far wider, which baked 80-column wrap into the first command's
  // output.
  termEl.style.display = 'block';
  termEl.style.visibility = 'hidden';
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try { fit.fit(); } catch {}
  termEl.style.visibility = '';
  termEl.style.display = 'none';

  await window.api.pty.spawn({
    id,
    cols: term.cols || 80,
    rows: term.rows || 24,
    shell: cmd ? '/bin/zsh' : undefined,
    args: cmd ? ['-l', '-c', cmd] : undefined,
    cwd: opts.cwd || undefined,
  });

  // --- Fallback "done" detector ---
  //
  // The hard signals (OSC 1337 from the Stop hook, bell with notifications)
  // fire instantly — but they don't always arrive: the running Claude
  // session may predate the hook install (Claude reads settings.json at
  // session start, so a hook added later won't apply until restart), the
  // user may have notifications off, or the hook's stdout may be piped
  // somewhere that never reaches the pty. This timer is the catch-all:
  // after claude-mode data goes quiet for IDLE_DONE_MS, flip the tab
  // green.
  //
  // IDLE_DONE_MS is tuned longer than Claude's mid-response pauses:
  // thinking blocks and tool calls still emit spinner frames at ~100ms,
  // so 3s of zero output means the stream really has stopped. Shorter
  // values (e.g. 500ms like the original main-side heuristic) caused
  // blinking during thinking pauses.
  const IDLE_DONE_MS = 3000;
  const armIdleDone = () => {
    const t = tabs.get(id);
    if (!t) return;
    if (t.idleTimer) clearTimeout(t.idleTimer);
    t.idleTimer = setTimeout(() => {
      t.idleTimer = null;
      if (!t.claudeMode) return;
      t.unreadSetAt = Date.now();
      tabEl.classList.remove('running');
      tabEl.classList.add('unread');
    }, IDLE_DONE_MS);
  };

  const cleanupData = window.api.pty.onData(id, (data) => {
    term.write(data);
    // Only run the fallback timer inside a Claude session — tab paint
    // is suppressed outside claudeMode anyway, so no need to fire.
    if (tabs.get(id)?.claudeMode) armIdleDone();
  });
  const cleanupExit = window.api.pty.onExit(id, () => closeTab(id));
  term.onData((data) => window.api.pty.write(id, data));
  term.onResize(({ cols, rows }) => window.api.pty.resize(id, cols, rows));

  // --- Claude Code detector ---
  //
  // We only want the spinner / green paint inside a Claude Code session,
  // not while running `ls` in zsh. Claude Code does NOT use the alternate
  // screen buffer (it renders inline so scrollback works), so we can't
  // gate on that. We detect Claude Code by three signals, any of which
  // latches claudeMode on for the tab's lifetime:
  //
  //   1. Title ever contains "claude" (Claude Code usually sets it to
  //      "Claude Code" on launch, then rewrites it to the current task
  //      like "Create a countdown timer" mid-session).
  //   2. Title starts with a Claude spinner prefix — the asterisk/bullet
  //      chars Claude Code uses while thinking. Covers the case where we
  //      never saw the literal word "claude" (e.g. restored session that
  //      came up straight into a task).
  //   3. OSC 1337 arrives. That escape can only come from our auto-
  //      installed Stop hook (see scripts/install-claude-hook.js), so its
  //      presence is a hard positive.
  //
  // Sticky: once claudeMode is true we never flip it off. Claude rewrites
  // the title to the task description mid-session, and the old heuristic
  // flipped claudeMode false on that rewrite — killing the spinner + green
  // until tab close. Known caveat documented in README: the color can
  // linger after exiting claude, since zsh doesn't reset the title.
  //
  // Spinner prefixes Claude Code has been observed to use (frame rotates):
  //   * ✶ ✳ ✺ · ⋆ ❉ ✦ ⦿ ⬥
  const CLAUDE_SPINNER_PREFIX = /^[\*\u2022\u22c6\u2736\u2733\u273a\u2749\u2726\u29bf\u2b25]\s/;

  let lastTitle = '';
  const recomputeClaudeMode = () => {
    const t = tabs.get(id);
    if (!t || t.claudeMode) return; // sticky: never unset
    if (/claude/i.test(lastTitle) || CLAUDE_SPINNER_PREFIX.test(lastTitle)) {
      t.claudeMode = true;
    }
  };

  term.onTitleChange((title) => {
    const trimmed = (title || '').trim();
    if (trimmed) labelEl.textContent = shorten(trimmed);
    lastTitle = trimmed;
    recomputeClaudeMode();
    syncTerminalsToState();
  });

  // OSC 7 — shell emits `\033]7;file://host/<path>\a` on chdir. Not
  // every shell does this by default, but macOS's zsh integration does
  // and it's cheap to handle. Used to keep per-tab cwd up to date so
  // recovery restores each tab into its last working directory.
  try {
    term.parser?.registerOscHandler?.(7, (payload) => {
      try {
        const u = new URL(payload);
        const t = tabs.get(id);
        if (t && u.pathname) {
          t.cwd = decodeURIComponent(u.pathname);
          syncTerminalsToState();
        }
      } catch {}
      return true;
    });
  } catch {}

  // Explicit "I'm done" signals — flip the tab orange immediately, no
  // 500ms wait. Gated on claudeMode so a stray bell from a regular shell
  // command (e.g. tab-completion ping) doesn't paint the tab.
  //
  //   1. Bell (\a) — any program ringing the terminal bell. Claude Code
  //      rings it when notifications are enabled.
  //   2. OSC 1337 — custom escape any script can emit:
  //      `printf '\033]1337;done\a'`. Pairs with a Claude Code `Stop` hook
  //      (see README) for a precise "claude finished responding" ping.
  term.onBell(() => {
    const t = tabs.get(id);
    if (!t?.claudeMode) return;
    if (t.idleTimer) { clearTimeout(t.idleTimer); t.idleTimer = null; }
    t.unreadSetAt = Date.now();
    tabEl.classList.remove('running');
    tabEl.classList.add('unread');
  });
  try {
    term.parser?.registerOscHandler?.(1337, () => {
      const t = tabs.get(id);
      if (!t) return true;
      // OSC 1337 can only come from our installed Claude Stop hook, so
      // treat its arrival as definitive Claude-mode detection and latch.
      t.claudeMode = true;
      if (t.idleTimer) { clearTimeout(t.idleTimer); t.idleTimer = null; }
      t.unreadSetAt = Date.now();
      tabEl.classList.remove('running');
      tabEl.classList.add('unread');
      return true;
    });
  } catch {}

  // Auto-refit whenever the container changes size — covers window resize,
  // sidebar toggle, divider drag, and display:none→block on tab switch.
  // Guard on offsetWidth so we don't fit a hidden (0×0) pane.
  const ro = new ResizeObserver(() => {
    if (termEl.offsetWidth > 0 && termEl.offsetHeight > 0) {
      try { fit.fit(); } catch {}
    }
  });
  ro.observe(termEl);

  tabs.set(id, {
    tabEl,
    labelEl,
    termEl,
    term,
    fit,
    ro,
    cleanupData,
    cleanupExit,
    claudeMode: false,
    cwd: opts.cwd || null,
    // Fallback idle timer handle; see armIdleDone above.
    idleTimer: null,
    // Timestamp of the most recent .unread paint. onState reads this to
    // suppress the prompt-redraw-clears-green race window.
    unreadSetAt: 0,
  });
  activate(id);
  syncTerminalsToState();
}

function activate(id) {
  for (const [tid, t] of tabs) {
    const on = tid === id;
    t.termEl.style.display = on ? 'block' : 'none';
    t.tabEl.classList.toggle('active', on);
  }
  activeId = id;
  const t = tabs.get(id);
  if (t) {
    // Note: we intentionally do NOT clear `.unread` on activate. The orange
    // "idle / waiting for input" state should still be visible after you
    // switch to the tab — that's the whole point. It clears automatically
    // on the next running event (new output from the pty).
    requestAnimationFrame(() => {
      try { t.fit.fit(); } catch {}
      t.term.focus();
    });
  }
  syncTerminalsToState();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  try { t.ro?.disconnect(); } catch {}
  if (t.idleTimer) { clearTimeout(t.idleTimer); t.idleTimer = null; }
  try { t.cleanupData?.(); } catch {}
  try { t.cleanupExit?.(); } catch {}
  window.api.pty.kill(id);
  t.term.dispose();
  t.termEl.remove();
  t.tabEl.remove();
  tabs.delete(id);
  if (activeId === id) {
    const next = [...tabs.keys()].pop();
    if (next != null) activate(next);
    else activeId = null;
  }
  syncTerminalsToState();
}

newTabBtn.addEventListener('click', () => newTab('zsh'));

// --- Divider drag ---

let dragging = false;
divider.addEventListener('mousedown', (e) => {
  dragging = true;
  document.body.style.cursor = 'col-resize';
  e.preventDefault();
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  document.body.style.cursor = '';
});
window.addEventListener('mousemove', async (e) => {
  if (!dragging) return;
  const newWidth = Math.max(260, Math.min(1000, window.innerWidth - e.clientX));
  sidebarEl.style.width = newWidth + 'px';
  await window.api.sidebar.setWidth(newWidth);
  for (const t of tabs.values()) { try { t.fit.fit(); } catch {} }
});

// --- Window resize ---

window.addEventListener('resize', () => {
  for (const t of tabs.values()) { try { t.fit.fit(); } catch {} }
});

// --- Sidebar tabs ---

// id -> { tabEl, labelEl }
const sbTabs = new Map();
let activeSbTabId = null;

function shorten(s, n = 22) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function labelFor(info) {
  return info.title || info.url || 'new tab';
}

function upsertSidebarTab(info) {
  let row = sbTabs.get(info.id);
  if (!row) {
    const tabEl = document.createElement('div');
    tabEl.className = 'sb-tab';
    const labelEl = document.createElement('span');
    labelEl.className = 'label';
    const closeEl = document.createElement('span');
    closeEl.className = 'close';
    closeEl.textContent = '×';
    tabEl.append(labelEl, closeEl);
    tabEl.addEventListener('click', () => window.api.sidebar.activateTab(info.id));
    closeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.sidebar.closeTab(info.id);
    });
    sidebarTabsEl.appendChild(tabEl);
    row = { tabEl, labelEl };
    sbTabs.set(info.id, row);
  }
  row.labelEl.textContent = shorten(labelFor(info));
  row.labelEl.title = info.title || info.url || '';
  row.tabEl.classList.toggle('active', !!info.active);
}

function removeSidebarTab(id) {
  const row = sbTabs.get(id);
  if (row) {
    row.tabEl.remove();
    sbTabs.delete(id);
  }
}

function setActiveSidebarTabUi(id, url) {
  activeSbTabId = id;
  for (const [tid, row] of sbTabs) {
    row.tabEl.classList.toggle('active', tid === id);
  }
  if (document.activeElement !== urlInput) {
    urlInput.value = url ?? '';
  }
}

async function bootSidebarTabs() {
  const list = await window.api.sidebar.listTabs();
  for (const info of list) upsertSidebarTab(info);
  const active = list.find((t) => t.active);
  if (active) setActiveSidebarTabUi(active.id, active.url);
}

sbNewTabBtn.addEventListener('click', () => window.api.sidebar.newTab());

// Event-driven URL/title/active-tab sync from main process
window.api.sidebar.onDidNavigate((info) => {
  upsertSidebarTab({ ...info, active: info.id === activeSbTabId });
  if (info.id === activeSbTabId && document.activeElement !== urlInput) {
    urlInput.value = info.url;
  }
});

window.api.sidebar.onActiveChanged((info) => {
  setActiveSidebarTabUi(info.id, info.url);
});

window.api.sidebar.onTabClosed(({ id }) => {
  removeSidebarTab(id);
});

// --- Sidebar chrome (nav row) ---

document.getElementById('sb-back').onclick = () => window.api.sidebar.back();
document.getElementById('sb-fwd').onclick = () => window.api.sidebar.forward();
document.getElementById('sb-reload').onclick = () => window.api.sidebar.reload();
document.getElementById('sb-toggle').onclick = async () => {
  const visible = await window.api.sidebar.toggle();
  sidebarEl.style.display = visible ? 'flex' : 'none';
  divider.style.display = visible ? 'block' : 'none';
  for (const t of tabs.values()) { try { t.fit.fit(); } catch {} }
};

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    window.api.sidebar.navigate(urlInput.value.trim());
  }
});

// --- Keyboard shortcuts ---

window.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  if (e.key === 't' && !e.shiftKey) {
    e.preventDefault();
    newTab('zsh');
  } else if (e.key === 'T' && e.shiftKey) {
    e.preventDefault();
    window.api.sidebar.newTab();
  } else if (e.key === 'w') {
    e.preventDefault();
    if (activeId != null) closeTab(activeId);
  } else if (e.key === 'B' && e.shiftKey) {
    e.preventDefault();
    document.getElementById('sb-toggle').click();
  } else if (/^[1-9]$/.test(e.key)) {
    const idx = parseInt(e.key, 10) - 1;
    const id = [...tabs.keys()][idx];
    if (id != null) { e.preventDefault(); activate(id); }
  }
});

// --- Boot ---

// Pick up any sidebar tabs the main process created before we booted.
bootSidebarTabs();

// Terminal-tab recovery. Main holds the persisted list; we recreate
// tabs one-at-a-time, preserving labels and (where available) cwd so
// each tab comes back in its previous working directory. Fresh zsh
// processes — session state is gone, but `claude --continue` inside a
// project directory will resume that project's last Claude session.
//
// First launch (or state was reset) → empty list → one default zsh tab.
async function bootTerminalTabs() {
  let initial = { tabs: [], activeIndex: 0 };
  try {
    initial = (await window.api.state?.getInitialTerminals?.()) || initial;
  } catch {}

  if (!Array.isArray(initial.tabs) || initial.tabs.length === 0) {
    await newTab('zsh');
    return;
  }

  // Recreate in order. Track the ids so we can activate the right one
  // after all tabs are up.
  const created = [];
  for (const saved of initial.tabs) {
    const label = typeof saved?.label === 'string' && saved.label.trim()
      ? saved.label
      : 'zsh';
    const opts = saved?.cwd ? { cwd: saved.cwd } : {};
    await newTab(label, null, opts);
    created.push(activeId);
  }

  const targetId = created[initial.activeIndex] ?? created[created.length - 1];
  if (targetId != null) activate(targetId);
}

bootTerminalTabs();
