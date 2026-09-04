const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const packageMetadata = require('../package.json');
const { compareVersions, latestRelease, selectDownloadAsset } = require('./core/updates.cjs');

if (require('electron-squirrel-startup')) app.quit();

const DATA_FILENAME = 'camp-changeover-data.json';
// Keep using the original data directory after the visible app name changes.
// This preserves existing camps, weeks, settings, and distance tables.
app.setPath('userData', path.join(app.getPath('appData'), 'Camp Changeover Planner'));

function dataPath() {
  return path.join(app.getPath('userData'), DATA_FILENAME);
}

async function writeJsonAtomically(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.saving`;
  await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporaryPath, filePath);
}

function writeJsonAtomicallySync(filePath, value) {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.saving`;
  fsSync.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fsSync.renameSync(temporaryPath, filePath);
}

function validateSender(event) {
  const senderUrl = event.senderFrame?.url || '';
  if (!senderUrl.startsWith('file://')) {
    throw new Error('Rejected request from an unexpected page.');
  }
}

async function loadSavedData() {
  try {
    return JSON.parse(await fs.readFile(dataPath(), 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function safeFilenamePart(value, fallback = 'Changeover') {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

async function exportWorkbook(payload, destination) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Changeover Planner';
  workbook.created = new Date();

  const summary = workbook.addWorksheet('Weekly Plan', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  summary.columns = [
    { header: 'Hill', key: 'hill', width: 16 },
    { header: 'Site', key: 'site', width: 14 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Arrival', key: 'arrival', width: 15 },
    { header: 'Current Tents', key: 'currentTents', width: 16 },
    { header: 'Current Cots', key: 'currentCots', width: 15 },
    { header: 'Needed Tents', key: 'neededTents', width: 15 },
    { header: 'Needed Cots', key: 'neededCots', width: 14 },
    { header: 'Tent Delta', key: 'tentDelta', width: 13 },
    { header: 'Cot Delta', key: 'cotDelta', width: 12 },
    { header: 'Floorboards Needed', key: 'floorboards', width: 20 },
    { header: 'Supply Tents', key: 'supplyTents', width: 15 },
    { header: 'Special Request', key: 'note', width: 42 }
  ];
  for (const row of payload.rows || []) summary.addRow(row);
  summary.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17352D' } };
  summary.autoFilter = { from: 'A1', to: 'M1' };

  const commands = workbook.addWorksheet('Commands');
  commands.columns = [
    { header: 'Hill', key: 'hill', width: 18 },
    { header: 'Source', key: 'source', width: 16 },
    { header: 'Destination', key: 'destination', width: 18 },
    { header: 'Instruction', key: 'instruction', width: 80 }
  ];
  for (const row of payload.commands || []) commands.addRow(row);
  commands.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  commands.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17352D' } };

  const inventory = workbook.addWorksheet('Inventory');
  inventory.columns = [
    { header: 'Item', key: 'item', width: 24 },
    { header: 'Amount', key: 'amount', width: 18 }
  ];
  for (const row of payload.inventory || []) {
    inventory.addRow({ item: row.item, amount: safeNumber(row.amount) });
  }
  inventory.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  inventory.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17352D' } };

  await workbook.xlsx.writeFile(destination);
}

function registerIpc() {
  ipcMain.handle('data:load', async (event) => {
    validateSender(event);
    return { data: await loadSavedData(), path: dataPath() };
  });

  ipcMain.handle('data:save', async (event, value) => {
    validateSender(event);
    await writeJsonAtomically(dataPath(), value);
    return { savedAt: new Date().toISOString(), path: dataPath() };
  });

  ipcMain.on('data:save-sync', (event, value) => {
    try {
      validateSender(event);
      writeJsonAtomicallySync(dataPath(), value);
      event.returnValue = { savedAt: new Date().toISOString(), path: dataPath() };
    } catch (error) {
      event.returnValue = { error: error?.message || String(error) };
    }
  });

  ipcMain.handle('backup:export', async (event, value) => {
    validateSender(event);
    const result = await dialog.showSaveDialog({
      title: 'Export complete camp backup',
      defaultPath: `${safeFilenamePart(value?.camps?.find((camp) => camp.id === value?.activeCampId)?.name, 'Camp')}-Complete-Backup.changeover`,
      filters: [{ name: 'Changeover Planner Backup', extensions: ['changeover'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await writeJsonAtomically(result.filePath, value);
    return { canceled: false, path: result.filePath };
  });

  ipcMain.handle('backup:import', async (event) => {
    validateSender(event);
    const result = await dialog.showOpenDialog({
      title: 'Import complete camp backup',
      properties: ['openFile'],
      filters: [{ name: 'Changeover Planner Backup', extensions: ['changeover', 'campplan', 'json'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const imported = JSON.parse(await fs.readFile(result.filePaths[0], 'utf8'));
    return { canceled: false, path: result.filePaths[0], data: imported };
  });

  ipcMain.handle('spreadsheet:export', async (event, payload) => {
    validateSender(event);
    const result = await dialog.showSaveDialog({
      title: 'Export weekly plan to Excel',
      defaultPath: `${payload.campName || 'Camp'}-${payload.weekName || 'Week'}-Changeover.xlsx`,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await exportWorkbook(payload, result.filePath);
    return { canceled: false, path: result.filePath };
  });

  ipcMain.handle('path:reveal', async (event, targetPath) => {
    validateSender(event);
    if (typeof targetPath === 'string') shell.showItemInFolder(targetPath);
  });

  ipcMain.handle('view:set-zoom', async (event, percent) => {
    validateSender(event);
    const safePercent = Math.min(150, Math.max(80, Number(percent) || 100));
    event.sender.setZoomFactor(safePercent / 100);
    return { percent: safePercent };
  });

  ipcMain.handle('updates:check', async (event) => {
    validateSender(event);
    const repository = packageMetadata.changeoverPlanner?.updateRepository || 'nickjbakerz/changeover-planner';
    const releaseUrl = new URL(`https://api.github.com/repos/${repository}/releases`);
    releaseUrl.searchParams.set('per_page', '20');
    releaseUrl.searchParams.set('checked_at', String(Date.now()));
    const response = await fetch(releaseUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'Cache-Control': 'no-cache',
        'User-Agent': `Changeover-Planner/${app.getVersion()}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(response.status === 404 ? 'No public releases are available yet.' : `GitHub could not be reached (status ${response.status}).`);
    const release = latestRelease(await response.json());
    if (!release) return { currentVersion: app.getVersion(), release: null, updateAvailable: false };
    const latestVersion = String(release.tag_name).replace(/^v/i, '');
    const asset = selectDownloadAsset(release, process.platform, process.arch);
    return {
      currentVersion: app.getVersion(),
      latestVersion,
      updateAvailable: compareVersions(latestVersion, app.getVersion()) > 0,
      releaseName: release.name || release.tag_name,
      prerelease: Boolean(release.prerelease),
      releasePageUrl: release.html_url,
      assetName: asset?.name || null,
      downloadUrl: asset?.browser_download_url || release.html_url
    };
  });

  ipcMain.handle('updates:open-download', async (event, targetUrl) => {
    validateSender(event);
    const parsed = new URL(String(targetUrl || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !parsed.pathname.startsWith('/nickjbakerz/changeover-planner/releases/')) {
      throw new Error('The update link was not recognized as an official Changeover Planner release.');
    }
    await shell.openExternal(parsed.href);
    return { opened: true };
  });

  ipcMain.handle('print:open-dialog', async (event, options = {}) => {
    validateSender(event);
    const layout = typeof options === 'string' ? options : options.layout;
    const landscape = layout === 'landscape';
    if (typeof options.title === 'string' && options.title.trim()) event.sender.mainFrame.executeJavaScript(`document.title = ${JSON.stringify(options.title.trim())}`);
    return new Promise((resolve) => {
      event.sender.print({ silent: false, printBackground: true, landscape, pageSize: 'Letter', duplexMode: 'simplex' }, (success, failureReason) => {
        resolve({ success, failureReason: failureReason || null });
      });
    });
  });

  ipcMain.handle('pdf:export', async (event, options = {}) => {
    validateSender(event);
    const filename = `${safeFilenamePart(options.filename, 'Changeover Plan').replace(/\.pdf$/i, '')}.pdf`;
    const result = await dialog.showSaveDialog({
      title: 'Export changeover packet as PDF',
      defaultPath: filename,
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const pdf = await event.sender.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: 'Letter'
    });
    await fs.writeFile(result.filePath, pdf);
    return { canceled: false, path: result.filePath };
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1510,
    height: 980,
    minWidth: 1120,
    minHeight: 720,
    title: 'Changeover Planner',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  window.removeMenu();
  window.loadFile(path.join(__dirname, 'index.html'));
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https:\/\/|mailto:|tel:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
}

function configureAutoUpdates() {
  const settings = packageMetadata.changeoverPlanner || {};
  if (!app.isPackaged || !settings.updatesEnabled) return;
  const { updateElectronApp, UpdateSourceType } = require('update-electron-app');
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: settings.updateRepository
    },
    updateInterval: '1 hour',
    notifyUser: true
  });
}

app.whenReady().then(() => {
  configureAutoUpdates();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
