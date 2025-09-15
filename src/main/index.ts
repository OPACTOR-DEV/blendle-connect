import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { ToolId, StatusUpdate } from './types';
import { CLI_CONFIGS } from './config/cli-configs';
import { ToolInstaller } from './services/tool-installer';
import { AuthManager } from './services/auth-manager';
import { PrerequisiteChecker } from './services/prerequisite-checker';
import { logger } from './utils/logger';

let mainWindow: BrowserWindow | null = null;
let toolInstaller: ToolInstaller | null = null;
let authManager: AuthManager | null = null;
let prerequisiteChecker: PrerequisiteChecker | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1b26',
    icon: path.join(__dirname, '../../assets/icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '../../src/renderer/index.html'));

  // Open DevTools in development mode
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  toolInstaller = new ToolInstaller(mainWindow);
  authManager = new AuthManager(mainWindow);
  prerequisiteChecker = new PrerequisiteChecker(mainWindow);

  // Check prerequisites on startup
  setTimeout(async () => {
    const prereqsOk = await prerequisiteChecker?.checkAndInstallPrerequisites();
    if (prereqsOk) {
      mainWindow?.webContents.send('prerequisites-ready');
    }
  }, 1000);

  mainWindow.on('closed', () => {
    if (authManager) {
      authManager.closeCallbackServers();
    }
    mainWindow = null;
    toolInstaller = null;
    authManager = null;
    prerequisiteChecker = null;
    logger.close();
  });
}

app.whenReady().then(() => {
  logger.info('App', 'Blendle Connect starting');
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// IPC Handlers
ipcMain.handle('check-tool', async (_event, toolId: ToolId) => {
  if (!toolInstaller) return false;
  return await toolInstaller.checkToolInstalled(toolId);
});

ipcMain.handle('check-authenticated', async (_event, toolId: ToolId) => {
  if (!authManager) return false;
  return await authManager.checkAuthenticated(toolId);
});

ipcMain.handle('logout-tool', async (_event, toolId: ToolId) => {
  if (!authManager) return { success: false, message: 'Auth manager not initialized' };
  return await authManager.logoutTool(toolId);
});

ipcMain.handle('install-tool', async (_event, toolId: ToolId) => {
  if (!toolInstaller) return { success: false, error: 'Tool installer not initialized' };

  try {
    await toolInstaller.installTool(toolId);
    return { success: true };
  } catch (error: any) {
    logger.error('IPC', `Failed to install ${toolId}`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('login-tool', async (_event, toolId: ToolId) => {
  if (!authManager) return { success: false, error: 'Auth manager not initialized' };

  try {
    await authManager.performLogin(toolId);
    return { success: true };
  } catch (error: any) {
    logger.error('IPC', `Failed to login ${toolId}`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('extract-credentials', async (_event, toolId: ToolId) => {
  if (!authManager) return { success: false, error: 'Auth manager not initialized' };

  try {
    const credentials = await authManager.extractCredentials(toolId);
    return { success: true, credentials };
  } catch (error: any) {
    logger.error('IPC', `Failed to extract credentials for ${toolId}`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('connect-tool', async (_event, toolId: ToolId) => {
  if (!mainWindow || !toolInstaller || !authManager) {
    return { success: false, error: 'Application not initialized' };
  }

  try {
    const sendStatus = (status: StatusUpdate['status'], message: string) => {
      mainWindow!.webContents.send('status-update', {
        toolId,
        status,
        message
      });
    };

    sendStatus('checking', `Checking ${CLI_CONFIGS[toolId].name}...`);

    const isInstalled = await toolInstaller.checkToolInstalled(toolId);

    if (!isInstalled) {
      sendStatus('installing', `Installing ${CLI_CONFIGS[toolId].name}...`);
      await toolInstaller.installTool(toolId);
    }

    const isAuthenticated = await authManager.checkAuthenticated(toolId);

    if (isAuthenticated) {
      mainWindow.webContents.send('log', {
        toolId,
        message: `${CLI_CONFIGS[toolId].name} is already authenticated!`
      });

      sendStatus('extracting', `Verifying existing credentials...`);

      const credentials = await authManager.extractCredentials(toolId);

      sendStatus('completed', `${CLI_CONFIGS[toolId].name} connected successfully!`);

      return { success: true, credentials };
    }

    sendStatus('authenticating', `Authenticating ${CLI_CONFIGS[toolId].name}...`);

    await authManager.performLogin(toolId);

    sendStatus('extracting', `Extracting credentials...`);

    const credentials = await authManager.extractCredentials(toolId);

    sendStatus('completed', `${CLI_CONFIGS[toolId].name} connected successfully!`);

    return { success: true, credentials };
  } catch (error: any) {
    logger.error('IPC', `Failed to connect ${toolId}`, error);

    mainWindow.webContents.send('status-update', {
      toolId,
      status: 'error',
      message: error.message
    });

    return { success: false, error: error.message };
  }
});