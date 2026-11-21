// Desktop shell: starts the bundled Python backend on a free local port, shows the charts in a window,
// and stops the backend when the app quits. TWS / IB Gateway still runs separately.
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const isMac = process.platform === 'darwin';
let backend = null;
let win = null;
let port = 0;
let quitting = false;
const logLines = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function dataDir() {
  const d = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function startBackend() {
  const repo = path.resolve(__dirname, '..');
  const env = { ...process.env, TV_PORT: String(port), TV_DATA_DIR: dataDir(), PYTHONUNBUFFERED: '1', TV_WATCH_STDIN: '1' };
  let cmd, args, cwd;
  if (app.isPackaged) {
    const res = process.resourcesPath;
    cmd = path.join(res, 'backend', isMac || process.platform === 'linux' ? 'tv-backend' : 'tv-backend.exe');
    args = [String(port)];
    cwd = path.join(res, 'backend');
    env.TV_FRONTEND_DIR = path.join(res, 'frontend');
  } else {
    // development: use the repo's backend virtualenv and built front end
    const venvPy = path.join(repo, 'backend', '.venv', isMac || process.platform === 'linux' ? 'bin/python' : 'Scripts/python.exe');
    cmd = fs.existsSync(venvPy) ? venvPy : (process.platform === 'win32' ? 'python' : 'python3');
    args = ['run.py', String(port)];
    cwd = path.join(repo, 'backend');
    env.TV_FRONTEND_DIR = path.join(repo, 'frontend', 'dist');
  }
  backend = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const keep = (b) => { logLines.push(...b.toString().split(/\r?\n/).filter(Boolean)); logLines.splice(0, Math.max(0, logLines.length - 200)); };
  backend.stdout.on('data', keep);
  backend.stderr.on('data', keep);
  backend.on('exit', (code) => {
    backend = null;
    if (!quitting) {
      dialog.showErrorBox('Charts stopped', `The charts server stopped (code ${code}).\n\n${logLines.slice(-15).join('\n')}`);
      app.quit();
    }
  });
}

function waitReady(timeoutMs = 60000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(); else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); });
    };
    const retry = () => {
      if (!backend) return reject(new Error('The charts server did not start.'));
      if (Date.now() - t0 > timeoutMs) return reject(new Error('The charts server took too long to start.'));
      setTimeout(tryOnce, 300);
    };
    tryOnce();
  });
}

function stopBackend() {
  if (!backend) return;
  try { backend.stdin.end(); } catch { /* ignore */ } // the server exits when its stdin closes
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { windowsHide: true });
    else backend.kill('SIGTERM');
  } catch { /* already gone */ }
}

// ---------- window ----------
const boundsFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() { try { return JSON.parse(fs.readFileSync(boundsFile(), 'utf8')); } catch { return { width: 1500, height: 900 }; } }
function saveBounds() {
  if (!win) return;
  try { fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* ignore */ }
}

async function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    ...b, minWidth: 900, minHeight: 600, backgroundColor: '#000000', title: 'IBKR Charts', show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (b.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'loading.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', saveBounds);
  win.on('closed', () => { win = null; });
  // links (news, help) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}`)) { e.preventDefault(); shell.openExternal(url); } });
  try {
    await waitReady();
    win?.loadURL(`http://127.0.0.1:${port}/`);
  } catch (e) {
    dialog.showErrorBox('Charts could not start', `${e.message}\n\n${logLines.slice(-15).join('\n')}`);
    app.quit();
  }
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open data folder', click: () => shell.openPath(dataDir()) },
      { label: 'Show server log', click: () => dialog.showMessageBox({ message: 'Server log (last lines)', detail: logLines.slice(-40).join('\n') || '(empty)' }) },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    port = await freePort();
    buildMenu();
    startBackend();
    await createWindow();
    app.on('activate', () => { if (!win && backend) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit()); // closing the window quits, on Mac too: no hidden server
  app.on('before-quit', () => { quitting = true; saveBounds(); stopBackend(); });
  app.on('will-quit', stopBackend);
}
