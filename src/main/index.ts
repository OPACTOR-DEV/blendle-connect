import { app, BrowserWindow, ipcMain, clipboard } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { ToolId, StatusUpdate } from './types';
import { CLI_CONFIGS } from './config/cli-configs';
import { ToolInstaller } from './services/tool-installer';
import { AuthManager } from './services/auth-manager';
// import { PrerequisiteChecker } from './services/prerequisite-checker';
import { logger } from './utils/logger';

let mainWindow: BrowserWindow | null = null;
let toolInstaller: ToolInstaller | null = null;
let authManager: AuthManager | null = null;
// let prerequisiteChecker: PrerequisiteChecker | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'Freerider Connect',
    backgroundColor: '#f5f5f5',
    icon: path.join(__dirname, '../../assets/icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Open DevTools in development mode
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  toolInstaller = new ToolInstaller(mainWindow);
  authManager = new AuthManager(mainWindow);
  // prerequisiteChecker = new PrerequisiteChecker(mainWindow);

  // Skip Node.js prerequisite check - Electron includes its own Node runtime
  // Directly send prerequisites-ready signal
  setTimeout(() => {
    mainWindow?.webContents.send('prerequisites-ready');
  }, 1000);

  mainWindow.on('closed', () => {
    if (authManager) {
      authManager.closeCallbackServers();
    }
    mainWindow = null;
    toolInstaller = null;
    authManager = null;
    // prerequisiteChecker = null;
    logger.close();
  });
}

app.whenReady().then(() => {
  logger.info('App', 'Freerider Connect starting');
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

ipcMain.handle('copy-credentials', async (_event, toolId: ToolId) => {
  if (!authManager) return { success: false, error: 'Auth manager not initialized' };

  try {
    const credentials = await authManager.getCopyableCredentials(toolId);
    if (!credentials || !credentials.copyText) {
      return { success: false, error: 'No copyable credentials found' };
    }

    clipboard.writeText(credentials.copyText);
    return { success: true, message: credentials.message || 'Credentials copied to clipboard' };
  } catch (error: any) {
    logger.error('IPC', `Failed to copy credentials for ${toolId}`, error);
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

      // Send connection status update to renderer
      mainWindow.webContents.send('tool-connected', {
        toolId,
        credentials
      });

      return { success: true, credentials };
    }

    sendStatus('authenticating', `Authenticating ${CLI_CONFIGS[toolId].name}...`);

    await authManager.performLogin(toolId);

    sendStatus('extracting', `Extracting credentials...`);

    const credentials = await authManager.extractCredentials(toolId);

    sendStatus('completed', `${CLI_CONFIGS[toolId].name} connected successfully!`);

    // Send connection status update to renderer
    mainWindow.webContents.send('tool-connected', {
      toolId,
      credentials
    });

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

// Handle user info request
ipcMain.handle('get-user-info', async () => {
  try {
    // Method 1: Extract user info from executable path/name
    const execPath = process.execPath;
    const execName = path.basename(execPath);

    // Check if executable name contains encoded user info
    const userInfo = extractUserInfoFromFilename(execName);
    if (userInfo) {
      return userInfo;
    }

    // Method 2: Check for command line arguments
    const args = process.argv;
    const userEmailArg = args.find(arg => arg.startsWith('--user-email='));
    const userNameArg = args.find(arg => arg.startsWith('--user-name='));
    const userIdArg = args.find(arg => arg.startsWith('--user-id='));

    if (userEmailArg && userNameArg && userIdArg) {
      return {
        email: userEmailArg.split('=')[1],
        name: userNameArg.split('=')[1],
        userId: userIdArg.split('=')[1],
        downloadedAt: new Date().toISOString(),
        source: 'command-line'
      };
    }

    // Method 3: Check for user info config file
    const appPath = app.getAppPath();
    const userConfigPath = path.join(path.dirname(appPath), 'user-config.json');
    const devConfigPath = path.join(appPath, 'user-config.json');

    let configPath = userConfigPath;
    if (!fs.existsSync(userConfigPath) && fs.existsSync(devConfigPath)) {
      configPath = devConfigPath;
    }

    if (fs.existsSync(configPath)) {
      const userInfoData = fs.readFileSync(configPath, 'utf8');
      const userInfo = JSON.parse(userInfoData);
      return userInfo;
    }

    // Return null if no user config found
    return null;
  } catch (error: any) {
    logger.error('UserInfo', 'Failed to load user info', error);
    return null;
  }
});

// Extract user info from filename
function extractUserInfoFromFilename(filename: string): any {
  try {
    // Look for pattern: freerider-connect-{platform}-{base64-encoded-user-info}.{ext}
    const match = filename.match(/freerider-connect-(\w+)-([A-Za-z0-9\-_]+)/);
    if (match) {
      let encodedUserInfo = match[2];

      // Restore base64 padding and characters
      encodedUserInfo = encodedUserInfo
        .replace(/-/g, '+')  // Restore + from -
        .replace(/_/g, '/'); // Restore / from _

      // Add padding if needed
      while (encodedUserInfo.length % 4) {
        encodedUserInfo += '=';
      }

      const decodedUserInfo = Buffer.from(encodedUserInfo, 'base64').toString('utf8');
      const userInfo = JSON.parse(decodedUserInfo);

      logger.info('UserInfo', `Extracted user info from filename: ${userInfo.email}`);

      return {
        ...userInfo,
        source: 'filename'
      };
    }

    return null;
  } catch (error) {
    logger.error('UserInfo', 'Failed to extract user info from filename', error);
    return null;
  }
}
