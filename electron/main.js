const { app, BrowserWindow, WebContentsView, ipcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const pty = require('node-pty');
const state = require('./state');

// Load persisted state before anything else — window geometry + sidebar
// width/visibility come out of here on boot.
const persisted = state.load();

// --- Window + sidebar state ---

let mainWindow;
let sidebarWidth = persisted.sidebar.width;
let sidebarVisible = persisted.sidebar.visible;

// Height of the HTML chrome above the sidebar web view (sidebar tab strip
// + nav bar). MUST stay in sync with #sidebar-chrome in src/styles.css.
const SIDEBAR_CHROME_HEIGHT = 66;

const sidebarTabs = new Map(); // id -> WebContentsView
let activeSidebarTabId = null;
let nextSidebarId = 1;

const ptys = new Map();

// Per-tab activity state — emits 'running' on first byte after quiet,
// 'idle' 500ms after the last byte. Renderer turns these into tab badges.
const tabIdleTimers = new Map(); // id -> NodeJS.Timeout | null
const TAB_IDLE_DELAY_MS = 500;

function markTabActivity(webContents, id) {
  const prev = tabIdleTimers.get(id);
  if (!prev && !webContents.isDestroyed()) {
    webContents.send('tab:state', { id, state: 'running' });
  }
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    tabIdleTimers.set(id, null);
    if (!webContents.isDestroyed()) {
      webContents.send('tab:state', { id, state: 'idle' });
    }
  }, TAB_IDLE_DELAY_MS);
  tabIdleTimers.set(id, timer);
}

function clearTabActivity(id) {
  const t = tabIdleTimers.get(id);
  if (t) clearTimeout(t);
  tabIdleTimers.delete(id);
}

// --- Sidebar layout ---

function layoutSidebar() {
  if (!mainWindow) return;
  const [w, h] = mainWindow.getContentSize();
  for (const [id, view] of sidebarTabs) {
    if (!sidebarVisible || id !== activeSidebarTabId) {
      // Hidden tabs get zero bounds but stay attached so audio/video keep
      // playing across switches.
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    } else {
      view.setBounds({
        x: w - sidebarWidth,
        y: SIDEBAR_CHROME_HEIGHT,
        width: sidebarWidth,
        height: Math.max(0, h - SIDEBAR_CHROME_HEIGHT),
      });
    }
  }
}

function getActiveSidebarView() {
  return activeSidebarTabId != null ? sidebarTabs.get(activeSidebarTabId) : null;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function tabInfo(id) {
  const view = sidebarTabs.get(id);
  if (!view) return null;
  return {
    id,
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
    active: id === activeSidebarTabId,
  };
}

function createSidebarTab(url) {
  const id = nextSidebarId++;
  const view = new WebContentsView();
  mainWindow.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  view.webContents.loadURL(url || 'https://www.youtube.com');

  const emit = () => {
    sendToRenderer('sidebar:did-navigate', tabInfo(id));
    persistSidebar();
  };
  view.webContents.on('did-navigate', emit);
  view.webContents.on('did-navigate-in-page', emit);
  view.webContents.on('page-title-updated', emit);

  sidebarTabs.set(id, view);
  persistSidebar();
  return id;
}

// Mirror live sidebar-tab state into the persisted store. Debounced
// inside state module, so calling this on every nav is cheap.
function persistSidebar() {
  const ordered = [...sidebarTabs.keys()];
  state.update((s) => {
    s.sidebar.width = sidebarWidth;
    s.sidebar.visible = sidebarVisible;
    s.sidebar.tabs = ordered.map((id) => ({
      url: sidebarTabs.get(id)?.webContents.getURL() || '',
    }));
    s.sidebar.activeIndex = Math.max(0, ordered.indexOf(activeSidebarTabId));
  });
}

function setActiveSidebarTab(id) {
  if (!sidebarTabs.has(id)) return;
  activeSidebarTabId = id;
  layoutSidebar();
  sendToRenderer('sidebar:active-changed', tabInfo(id));
  persistSidebar();
}

function closeSidebarTab(id) {
  const view = sidebarTabs.get(id);
  if (!view) return;
  try { mainWindow.contentView.removeChildView(view); } catch {}
  sidebarTabs.delete(id);
  sendToRenderer('sidebar:tab-closed', { id });
  if (activeSidebarTabId === id) {
    const remaining = [...sidebarTabs.keys()];
    const next = remaining[remaining.length - 1] ?? null;
    activeSidebarTabId = next;
    layoutSidebar();
    if (next != null) sendToRenderer('sidebar:active-changed', tabInfo(next));
    else sendToRenderer('sidebar:active-changed', { id: null, url: '', title: '' });
  }
  persistSidebar();
}

// --- Window ---

function pickWindowBounds() {
  const saved = persisted.window;
  const base = { width: 1440, height: 900 };
  if (!saved) return base;

  // Sanity: make sure saved position is still on an attached display.
  // If the external monitor is gone, fall back to the primary display
  // so the window doesn't land off-screen.
  try {
    const displays = screen.getAllDisplays();
    const onScreen = displays.some((d) => {
      const b = d.bounds;
      return (
        saved.x >= b.x && saved.x < b.x + b.width &&
        saved.y >= b.y && saved.y < b.y + b.height
      );
    });
    if (!onScreen) return base;
  } catch {
    return base;
  }
  return {
    x: saved.x,
    y: saved.y,
    width: Number.isFinite(saved.width) ? saved.width : 1440,
    height: Number.isFinite(saved.height) ? saved.height : 900,
  };
}

function persistWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const maximized = mainWindow.isMaximized();
  state.update((s) => {
    s.window = { ...bounds, maximized };
  });
}

function createWindow() {
  const bounds = pickWindowBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (persisted.window?.maximized) {
    try { mainWindow.maximize(); } catch {}
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // Restore sidebar tabs from persisted state. If there was nothing
  // saved (first launch, or state reset), fall back to one YouTube tab
  // so the sidebar isn't empty.
  const savedTabs = persisted.sidebar.tabs.length
    ? persisted.sidebar.tabs
    : [{ url: 'https://www.youtube.com' }];
  const ids = savedTabs.map((t) => createSidebarTab(t.url));
  const desired = persisted.sidebar.activeIndex;
  activeSidebarTabId = ids[desired] ?? ids[0];
  layoutSidebar();

  // Persist geometry changes — resize / move / maximize / unmaximize.
  // Use `once`-per-burst semantics by piggybacking on the state module's
  // internal debounce.
  mainWindow.on('resize', () => { layoutSidebar(); persistWindow(); });
  mainWindow.on('move', persistWindow);
  mainWindow.on('maximize', persistWindow);
  mainWindow.on('unmaximize', persistWindow);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// --- IPC: sidebar ---

ipcMain.handle('sidebar:set-width', (_, width) => {
  sidebarWidth = Math.max(260, Math.min(1000, Math.round(width)));
  layoutSidebar();
  persistSidebar();
  return sidebarWidth;
});

ipcMain.handle('sidebar:toggle', () => {
  sidebarVisible = !sidebarVisible;
  layoutSidebar();
  persistSidebar();
  return sidebarVisible;
});

ipcMain.handle('sidebar:navigate', (_, url) => {
  const view = getActiveSidebarView();
  if (!view) return;
  try {
    const u = new URL(url);
    view.webContents.loadURL(u.toString());
  } catch {
    // Treat as search query
    const q = encodeURIComponent(url);
    view.webContents.loadURL(`https://www.google.com/search?q=${q}`);
  }
});

ipcMain.handle('sidebar:back', () => {
  const view = getActiveSidebarView();
  if (view?.webContents.canGoBack()) view.webContents.goBack();
});

ipcMain.handle('sidebar:forward', () => {
  const view = getActiveSidebarView();
  if (view?.webContents.canGoForward()) view.webContents.goForward();
});

ipcMain.handle('sidebar:reload', () => {
  getActiveSidebarView()?.webContents.reload();
});

ipcMain.handle('sidebar:new-tab', (_, url) => {
  const id = createSidebarTab(url);
  setActiveSidebarTab(id);
  return tabInfo(id);
});

ipcMain.handle('sidebar:close-tab', (_, id) => {
  closeSidebarTab(id);
});

ipcMain.handle('sidebar:activate-tab', (_, id) => {
  setActiveSidebarTab(id);
});

ipcMain.handle('sidebar:list-tabs', () => {
  return [...sidebarTabs.keys()].map((id) => tabInfo(id));
});

// --- IPC: terminal-tab recovery ---
//
// Renderer asks for the list of terminal tabs to recreate on boot. If
// we have saved tabs, it rebuilds them (fresh zsh processes, but labels
// and cwd restored); if not, it creates a single default tab.
//
// Renderer also reports label/close/active changes so we can keep the
// persisted list in sync for the next launch.

ipcMain.handle('state:get-initial-terminals', () => {
  return {
    tabs: persisted.terminals.tabs,
    activeIndex: persisted.terminals.activeIndex,
  };
});

ipcMain.on('state:set-terminals', (_, payload) => {
  if (!payload || !Array.isArray(payload.tabs)) return;
  state.update((s) => {
    s.terminals.tabs = payload.tabs
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({
        label: typeof t.label === 'string' ? t.label : 'zsh',
        cwd: typeof t.cwd === 'string' ? t.cwd : undefined,
      }));
    s.terminals.activeIndex = Number.isInteger(payload.activeIndex)
      ? payload.activeIndex
      : 0;
  });
});

// --- IPC: pty ---

ipcMain.handle('pty:spawn', (event, opts) => {
  const { id, cols, rows, shell, args, cwd } = opts;
  const p = pty.spawn(shell || process.env.SHELL || '/bin/zsh', args || [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || os.homedir(),
    env: process.env,
  });
  ptys.set(id, p);
  p.onData((data) => {
    markTabActivity(event.sender, id);
    if (!event.sender.isDestroyed()) {
      event.sender.send(`pty:data:${id}`, data);
    }
  });
  p.onExit(({ exitCode }) => {
    clearTabActivity(id);
    if (!event.sender.isDestroyed()) {
      event.sender.send(`pty:exit:${id}`, exitCode);
    }
    ptys.delete(id);
  });
  return true;
});

ipcMain.on('pty:write', (_, { id, data }) => {
  ptys.get(id)?.write(data);
});

ipcMain.on('pty:resize', (_, { id, cols, rows }) => {
  try { ptys.get(id)?.resize(cols, rows); } catch {}
});

ipcMain.on('pty:kill', (_, { id }) => {
  try { ptys.get(id)?.kill(); } catch {}
  ptys.delete(id);
  clearTabActivity(id);
});

// --- Lifecycle ---

app.whenReady().then(createWindow);

// Final state flush right before we tear everything down. `before-quit`
// fires for every exit path (cmd-Q, window-all-closed, SIGTERM from
// `npm run stop`), so we only need one place to make sure the state
// file is up to date.
app.on('before-quit', () => {
  try {
    // Capture current window geometry one last time so the next launch
    // opens in the same spot even if the user quit via cmd-Q (which
    // doesn't fire `move`/`resize`).
    if (mainWindow && !mainWindow.isDestroyed()) {
      persistWindow();
    }
  } catch {}
  state.flushSync();
});

app.on('window-all-closed', () => {
  for (const p of ptys.values()) { try { p.kill(); } catch {} }
  ptys.clear();
  for (const t of tabIdleTimers.values()) { if (t) clearTimeout(t); }
  tabIdleTimers.clear();
  state.flushSync();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
