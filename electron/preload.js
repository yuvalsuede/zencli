const { contextBridge, ipcRenderer } = require('electron');

function sub(channel, cb) {
  const listener = (_, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  pty: {
    spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    write: (id, data) => ipcRenderer.send('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('pty:kill', { id }),
    onData: (id, cb) => {
      const ch = `pty:data:${id}`;
      const listener = (_, data) => cb(data);
      ipcRenderer.on(ch, listener);
      return () => ipcRenderer.removeListener(ch, listener);
    },
    onExit: (id, cb) => {
      const ch = `pty:exit:${id}`;
      const listener = (_, code) => cb(code);
      ipcRenderer.on(ch, listener);
      return () => ipcRenderer.removeListener(ch, listener);
    },
    // Global (not per-id) — fires for every tab's state transition.
    onState: (cb) => sub('tab:state', cb),
  },
  state: {
    // Main sends back the list of terminal tabs to recreate on boot.
    // Empty list → first launch, renderer creates a default zsh tab.
    getInitialTerminals: () => ipcRenderer.invoke('state:get-initial-terminals'),
    // Renderer pushes the current terminal-tab snapshot after any
    // create/close/label/activate. Main debounces the write.
    setTerminals: (payload) => ipcRenderer.send('state:set-terminals', payload),
  },
  sidebar: {
    // Layout
    setWidth: (w) => ipcRenderer.invoke('sidebar:set-width', w),
    toggle: () => ipcRenderer.invoke('sidebar:toggle'),
    // Nav (acts on active tab)
    navigate: (url) => ipcRenderer.invoke('sidebar:navigate', url),
    back: () => ipcRenderer.invoke('sidebar:back'),
    forward: () => ipcRenderer.invoke('sidebar:forward'),
    reload: () => ipcRenderer.invoke('sidebar:reload'),
    // Tabs
    newTab: (url) => ipcRenderer.invoke('sidebar:new-tab', url),
    closeTab: (id) => ipcRenderer.invoke('sidebar:close-tab', id),
    activateTab: (id) => ipcRenderer.invoke('sidebar:activate-tab', id),
    listTabs: () => ipcRenderer.invoke('sidebar:list-tabs'),
    // Events from main
    onDidNavigate: (cb) => sub('sidebar:did-navigate', cb),
    onActiveChanged: (cb) => sub('sidebar:active-changed', cb),
    onTabClosed: (cb) => sub('sidebar:tab-closed', cb),
  },
});
