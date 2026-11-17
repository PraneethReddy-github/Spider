import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '@spider/server';
import { BrowserWindow, Menu, type MenuItemConstructorOptions, app, dialog, ipcMain, shell } from 'electron';
import updater from 'electron-updater';

/**
 * Spider desktop: runs the Spider server inside the app on a random local port and shows the web app in a
 * window. Analysis stays on this machine; graphs live in ~/.spider (shared with the `spider` CLI). Updates come
 * from GitHub Releases through electron-updater (Windows installer and Linux AppImage).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = updater;

let win: BrowserWindow | undefined;
let baseUrl = '';

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

/** The built web app: next to main.js in the packaged app, `packages/web/dist` in a checkout. */
function webDir(): string | undefined {
  return [path.join(app.getAppPath(), 'web'), path.resolve(here, '../../web/dist')].find((d) =>
    existsSync(path.join(d, 'index.html')),
  );
}

async function startServer(): Promise<string> {
  const server = await createServer({ webDir: webDir(), home: process.env.SPIDER_HOME });
  // 127.0.0.1 only, random free port: nothing outside this machine can reach it
  await server.listen({ port: 0, host: '127.0.0.1' });
  app.on('will-quit', () => void server.close());
  return `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Spider',
    backgroundColor: '#101012',
    show: false,
    icon: path.join(app.getAppPath(), 'resources', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(here, 'preload.cjs'),
    },
  });
  win.once('ready-to-show', () => win?.show());
  // links leave the app: web pages in the browser, editor links (vscode://, idea://…) in the editor
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(baseUrl)) void shell.openExternal(url);
    return { action: url.startsWith(baseUrl) ? 'allow' : 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(baseUrl)) return;
    e.preventDefault();
    void shell.openExternal(url);
  });
  void win.loadURL(baseUrl);
  win.on('closed', () => {
    win = undefined;
  });
}

/* ---------- updates ---------- */

let manualCheck = false;

function setupUpdates(): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', async (info) => {
    manualCheck = false;
    const r = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `Spider ${info.version} is available.`,
      detail: `You have ${app.getVersion()}. Download it now? Spider installs it when you quit.`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) void autoUpdater.downloadUpdate();
  });
  autoUpdater.on('update-not-available', () => {
    if (manualCheck)
      void dialog.showMessageBox({
        type: 'info',
        title: 'Spider',
        message: `Spider ${app.getVersion()} is up to date.`,
      });
    manualCheck = false;
  });
  autoUpdater.on('download-progress', (p) => win?.setProgressBar(p.percent / 100));
  autoUpdater.on('update-downloaded', async (info) => {
    win?.setProgressBar(-1);
    const r = await dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: `Spider ${info.version} is ready to install.`,
      detail: 'Restart now, or it installs the next time you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => {
    win?.setProgressBar(-1);
    if (manualCheck)
      void dialog.showMessageBox({ type: 'error', title: 'Update failed', message: String(err?.message ?? err) });
    manualCheck = false;
  });
  // shortly after start, then every 6 hours
  setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), 5_000);
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 6 * 3_600_000);
}

function checkNow(): void {
  if (!app.isPackaged) {
    void dialog.showMessageBox({
      type: 'info',
      title: 'Spider',
      message: 'Updates are checked in installed builds only.',
    });
    return;
  }
  manualCheck = true;
  void autoUpdater.checkForUpdates().catch(() => {});
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Repositories', accelerator: 'CmdOrCtrl+Shift+H', click: () => void win?.loadURL(baseUrl) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for updates…', click: checkNow },
        {
          label: 'Documentation',
          click: () => void shell.openExternal('https://github.com/PraneethReddy-github/Spider#readme'),
        },
        {
          label: 'Report an issue',
          click: () => void shell.openExternal('https://github.com/PraneethReddy-github/Spider/issues'),
        },
        { type: 'separator' },
        { label: `Spider ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  try {
    baseUrl = await startServer();
  } catch (err) {
    dialog.showErrorBox('Spider could not start', String((err as Error)?.stack ?? err));
    app.exit(1);
    return;
  }
  ipcMain.handle('spider:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Choose a repository folder',
      properties: ['openDirectory'],
    });
    return r.canceled ? undefined : r.filePaths[0];
  });
  buildMenu();
  createWindow();
  setupUpdates();
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
