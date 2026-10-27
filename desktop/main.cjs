'use strict';
// Electron wrapper for the mycodebox dashboard. The server address is never in the repo: it is asked for on first run.
const { app, BrowserWindow, Menu, shell, ipcMain, session, dialog } = require('electron');
const path = require('node:path');
const { parseServerUrl, sameOrigin, loadConfig, saveConfig, sanitizeBounds } = require('./lib/config.cjs');

let win = null;
let cfgFile;
let cfg = {};
const save = () => saveConfig(cfgFile, cfg);

function showSetup() { win?.loadFile(path.join(__dirname, 'pages', 'setup.html')); }
function loadDashboard() { return cfg.serverUrl ? win.loadURL(cfg.serverUrl) : showSetup(); }

function createWindow() {
  win = new BrowserWindow({
    ...sanitizeBounds(cfg.bounds),
    backgroundColor: '#0f1014',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (cfg.maximized) win.maximize();
  let t;
  const remember = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      cfg.maximized = win.isMaximized();
      if (!cfg.maximized && !win.isFullScreen()) cfg.bounds = win.getBounds();
      save();
    }, 400);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, remember);
  win.on('closed', () => { win = null; });

  // Links to other origins open in the default browser; the window stays on the dashboard.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (cfg.serverUrl && sameOrigin(url, cfg.serverUrl)) return { action: 'allow' };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    if (cfg.serverUrl && sameOrigin(url, cfg.serverUrl)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    const msg = `Could not load ${url}\n${desc}\n\nCheck that Tailscale is connected and the address is right.`;
    dialog.showMessageBox(win, { type: 'warning', message: 'Cannot reach the server', detail: msg, buttons: ['Retry', 'Change address…'] })
      .then((r) => (r.response === 0 ? loadDashboard() : showSetup()));
  });
  loadDashboard();
}

ipcMain.handle('server:get', (e) => (e.senderFrame.url.startsWith('file:') ? cfg.serverUrl || '' : ''));
ipcMain.handle('server:set', (e, address) => {
  if (!e.senderFrame.url.startsWith('file:')) return { error: 'not allowed' };
  const p = parseServerUrl(address);
  if (!p) return { error: 'Enter a valid address, for example https://host:7443' };
  cfg.serverUrl = p.url;
  save();
  loadDashboard();
  return { ok: true };
});

// Trust a self-signed / tailnet certificate for the stored server's origin only.
app.on('certificate-error', (e, _wc, url, _err, _cert, callback) => {
  if (cfg.serverUrl && sameOrigin(url, cfg.serverUrl)) { e.preventDefault(); callback(true); } else callback(false);
});

function wirePermissions() {
  const ok = new Set(['notifications', 'clipboard-sanitized-write', 'media', 'fullscreen']);
  const fromServer = (wc) => cfg.serverUrl && wc && sameOrigin(wc.getURL(), cfg.serverUrl);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ok.has(perm) && fromServer(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => ok.has(perm) && !!fromServer(wc));
}

function buildMenu() {
  const t = [
    { label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Change server address…', accelerator: 'Cmd+,', click: showSetup },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' } ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'Cmd+R', click: () => win?.webContents.reload() },
      { label: 'Force Reload', accelerator: 'Cmd+Shift+R', click: () => win?.webContents.reloadIgnoringCache() },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' } ] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

app.whenReady().then(() => {
  cfgFile = path.join(app.getPath('userData'), 'config.json');
  cfg = loadConfig(cfgFile);
  wirePermissions();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
