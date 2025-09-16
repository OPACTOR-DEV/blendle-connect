import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { BrowserWindow, ipcMain, shell } from 'electron';
import { ToolId, Credentials } from '../types';
import { CLI_CONFIGS } from '../config/cli-configs';
import { EnvironmentManager } from '../utils/environment';
import { logger } from '../utils/logger';
import { CallbackServer } from './callback-server';
import { ClaudeService } from './claude-service';


export class AuthManager {
  private mainWindow: BrowserWindow;
  private callbackServer: CallbackServer;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    this.callbackServer = new CallbackServer(mainWindow);
  }

  async checkAuthenticated(toolId: ToolId): Promise<boolean> {
    logger.debug('AuthManager', `Checking authentication for ${toolId}`);

    if (toolId === 'claude') {
      return await ClaudeService.checkAuthenticated();
    } else if (toolId === 'codex') {
      // Check both auth.json and config.toml for Codex authentication
      const authPath = path.join(os.homedir(), '.codex', 'auth.json');
      const configPath = path.join(os.homedir(), '.codex', 'config.toml');

      try {
        await fsPromises.access(authPath);
        logger.debug('AuthManager', 'Found existing Codex auth.json');
        return true;
      } catch {
        // auth.json not found, check config.toml
        try {
          await fsPromises.access(configPath);
          logger.debug('AuthManager', 'Found existing Codex config.toml');
          return true;
        } catch {
          return false;
        }
      }
    } else if (toolId === 'gemini') {
      const credsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
      try {
        await fsPromises.access(credsPath);
        logger.debug('AuthManager', 'Found existing Gemini oauth_creds.json');
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  async performLogin(toolId: ToolId): Promise<void> {
    const config = CLI_CONFIGS[toolId];

    logger.info('AuthManager', `Starting ${config.name} login process`);
    this.sendLog(toolId, `Starting ${config.name} login process...`);


    await this.callbackServer.setupCallbackServer(toolId);
    await new Promise(r => setTimeout(r, 500));

    if (toolId === 'claude') {
      logger.debug('AuthManager', 'Performing Claude login...');
      await this.performClaudeLogin(toolId);
    } else if (toolId === 'gemini') {
      await this.performGeminiLogin(toolId);
    } else if (toolId === 'codex') {
      await this.performCodexLogin(toolId);
    } else {
      await this.performStandardLogin(toolId);
    }
  }

  private async performClaudeLogin(toolId: ToolId): Promise<void> {
    logger.debug('AuthManager', 'Starting Claude login with node-pty automation');

    return ClaudeService.performAutoLogin({
      mainWindow: this.mainWindow,
      onLog: (message) => this.sendLog(toolId, message),
      onAuthComplete: () => {
        logger.info('AuthManager', 'Claude authentication completed');
      }
    });
  }

  private async performGeminiLogin(toolId: ToolId): Promise<void> {
    logger.debug('AuthManager', 'Gemini re-authentication: clearing credentials');

    await this.clearGeminiCredentials();
    await this.ensureGeminiOAuthSelected();

    return new Promise((resolve, reject) => {
      const env = EnvironmentManager.getSpawnEnv();
      const login = spawn('gemini', ['--prompt', 'Authenticate'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let authCompleted = false;
      let resolved = false;

      const credPoll = setInterval(() => {
        try {
          const credPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
          if (fs.existsSync(credPath)) {
            authCompleted = true;
            clearInterval(credPoll);
            logger.info('AuthManager', 'Detected Gemini OAuth credentials on disk');
            this.sendLog(toolId, 'Detected Gemini OAuth credentials on disk');
            if (!resolved) {
              resolved = true;
              return resolve();
            }
          }
        } catch {}
      }, 500);

      const loginTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          clearInterval(credPoll);
          try { login.kill(); } catch {}
          reject(new Error('Login process timed out'));
        }
      }, 2 * 60 * 1000);

      this.setupGeminiHandlers(login, toolId, () => {
        authCompleted = true;
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      login.on('close', (code) => {
        clearTimeout(loginTimeout);
        clearInterval(credPoll);
        if (!resolved) {
          resolved = true;
          if (code === 0 || authCompleted) {
            resolve();
          } else {
            reject(new Error(`Login process failed with code ${code}`));
          }
        }
      });
    });
  }

  private async performCodexLogin(toolId: ToolId): Promise<void> {
    logger.debug('AuthManager', 'Codex re-authentication: logout first');

    await this.logoutCodex();

    return new Promise((resolve, reject) => {
      const config = CLI_CONFIGS[toolId];
      const [cmd, ...args] = config.loginCmd;
      const env = EnvironmentManager.getSpawnEnv();

      const login = spawn(cmd, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let authCompleted = false;
      let resolved = false;

      const authCompletedHandler = (_event: any, data: any) => {
        if (data.toolId === toolId) {
          logger.debug('AuthManager', `Auth completed signal received for ${toolId}`);
          authCompleted = true;
        }
      };

      ipcMain.once(`auth-completed-${toolId}`, authCompletedHandler);

      // Also check for auth file creation directly for faster detection
      const authFileCheck = setInterval(async () => {
        try {
          const authPath = path.join(os.homedir(), '.codex', 'auth.json');
          const configPath = path.join(os.homedir(), '.codex', 'config.toml');

          // Check if either auth file exists
          const authExists = fs.existsSync(authPath);
          const configExists = fs.existsSync(configPath);

          if ((authExists || configExists) && !authCompleted) {
            logger.info('AuthManager', 'Detected Codex auth file on disk');
            authCompleted = true;
            clearInterval(authFileCheck);
          }
        } catch (error) {
          // Ignore errors in file checking
        }
      }, 250); // Check every 250ms for faster detection

      const loginTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          clearInterval(authFileCheck);
          ipcMain.removeListener(`auth-completed-${toolId}`, authCompletedHandler);
          login.kill();
          reject(new Error('Login process timed out'));
        }
      }, 5 * 60 * 1000);

      this.setupStandardHandlers(login, toolId, () => {
        authCompleted = true;
      });

      const checkAuth = setInterval(async () => {
        if (authCompleted && !resolved) {
          resolved = true;
          clearInterval(checkAuth);
          clearInterval(authFileCheck);
          clearTimeout(loginTimeout);
          ipcMain.removeListener(`auth-completed-${toolId}`, authCompletedHandler);

          // Reduce delay to 500ms for faster response
          setTimeout(() => {
            login.kill('SIGTERM');
            resolve();
          }, 500);
        }
      }, 100); // Check more frequently (every 100ms)

      login.on('exit', (code) => {
        clearInterval(checkAuth);
        clearInterval(authFileCheck);
        clearTimeout(loginTimeout);
        ipcMain.removeListener(`auth-completed-${toolId}`, authCompletedHandler);

        if (!resolved) {
          resolved = true;
          if (authCompleted || code === 0) {
            resolve();
          } else {
            reject(new Error(`Login process failed with code ${code}`));
          }
        }
      });
    });
  }

  private async performStandardLogin(toolId: ToolId): Promise<void> {
    return new Promise((resolve, reject) => {
      const config = CLI_CONFIGS[toolId];
      const [cmd, ...args] = config.loginCmd;
      const env = {
        ...EnvironmentManager.getSpawnEnv(),
        FORCE_TTY: '1',
        TERM: 'xterm-256color',
        COLUMNS: '80',
        LINES: '24'
      };

      const login = spawn(cmd, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let authCompleted = false;
      let resolved = false;

      const authCompletedHandler = (_event: any, data: any) => {
        if (data.toolId === toolId) {
          logger.debug('AuthManager', `Auth completed signal received for ${toolId}`);
          authCompleted = true;
        }
      };

      ipcMain.once(`auth-completed-${toolId}`, authCompletedHandler);

      const loginTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ipcMain.removeListener(`auth-completed-${toolId}`, authCompletedHandler);
          login.kill();
          reject(new Error('Login process timed out'));
        }
      }, 5 * 60 * 1000);

      this.setupStandardHandlers(login, toolId, () => {
        authCompleted = true;
      });

      const checkAuth = setInterval(async () => {
        if (authCompleted && !resolved) {
          resolved = true;
          clearInterval(checkAuth);
          clearTimeout(loginTimeout);
          ipcMain.removeListener(`auth-completed-${toolId}`, authCompletedHandler);

          setTimeout(() => {
            login.kill('SIGTERM');
            resolve();
          }, 3000);
        }
      }, 500);

      login.on('exit', (code) => {
        clearInterval(checkAuth);
        clearTimeout(loginTimeout);
        ipcMain.removeListener(`auth-completed-${toolId}`, authCompletedHandler);

        if (!resolved) {
          resolved = true;
          if (authCompleted || code === 0) {
            resolve();
          } else {
            reject(new Error(`Login process failed with code ${code}`));
          }
        }
      });
    });
  }

  private setupStandardHandlers(
    login: ChildProcess,
    toolId: ToolId,
    onAuthComplete: () => void
  ): void {
    const handleOutput = (data: Buffer) => {
      const output = data.toString();
      const cleanOutput = this.cleanTerminalOutput(output);

      logger.debug('AuthManager', `${toolId} output:`, cleanOutput);

      if (cleanOutput.trim()) {
        this.sendLog(toolId, cleanOutput);
      }

      this.checkForAuthUrl(output, toolId);
      this.checkForAuthSuccess(cleanOutput, onAuthComplete);
    };

    if (login.stdout) login.stdout.on('data', handleOutput);
    if (login.stderr) login.stderr.on('data', (data) => {
      const output = data.toString();
      this.sendLog(toolId, output);
      this.checkForAuthSuccess(output.toLowerCase(), onAuthComplete);
    });
  }

  private setupGeminiHandlers(
    login: ChildProcess,
    toolId: ToolId,
    onAuthComplete: () => void
  ): void {
    const handleOutput = (data: Buffer) => {
      const output = data.toString();
      logger.debug('AuthManager', `Gemini output:`, output);

      const meaningfulPatterns = [
        /Code Assist login required/i,
        /open authentication page/i,
        /Waiting for authentication/i,
        /Loaded cached credentials/i,
        /already authenticated/i,
        /authenticated/i,
        /logged in/i,
        /(https?:\/\/[^\s]+)/i
      ];

      const isMeaningful = meaningfulPatterns.some((re) => re.test(output));
      if (isMeaningful) {
        this.sendLog(toolId, output);
      }

      const urlMatch = output.match(/(https?:\/\/[^\s\)]+)/);
      if (urlMatch) {
        const authUrl = urlMatch[1];
        logger.debug('AuthManager', `Found Gemini auth URL: ${authUrl}`);
        this.sendLog(toolId, 'Opening authentication page in browser...');
        shell.openExternal(authUrl);
      }

      this.checkForAuthSuccess(output, onAuthComplete);
    };

    if (login.stdout) login.stdout.on('data', handleOutput);
    if (login.stderr) login.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.trim()) this.sendLog(toolId, output);
    });
  }

  private checkForAuthUrl(output: string, toolId: ToolId): void {
    const urlPatterns = [
      /(https?:\/\/[^\s\)\]]+)/g,
      /Open.*browser.*?(https?:\/\/[^\s]+)/i,
      /Visit.*?(https?:\/\/[^\s]+)/i,
      /Navigate to.*?(https?:\/\/[^\s]+)/i
    ];

    for (const pattern of urlPatterns) {
      const matches = output.match(pattern);
      if (matches && matches.length > 0) {
        const authUrl = matches[matches.length - 1].replace(/[)\]'"]*$/, '');
        logger.debug('AuthManager', `Found auth URL for ${toolId}:`, authUrl);
        this.sendLog(toolId, 'Opening authentication page in browser...');

        setTimeout(() => {
          logger.debug('AuthManager', `Opening auth URL as fallback for ${toolId}`);
          shell.openExternal(authUrl);
        }, 5000);
        break;
      }
    }
  }

  private checkForAuthSuccess(output: string, onComplete: () => void): void {
    const successPatterns = [
      'successfully signed in',
      'authentication successful',
      'logged in as',
      'authentication complete',
      'login successful',
      'authenticated successfully',
      'login completed',
      'loaded cached credentials',
      'already authenticated',
      'credentials loaded'
    ];

    if (successPatterns.some(pattern => output.toLowerCase().includes(pattern))) {
      logger.debug('AuthManager', `Authentication success detected: ${output}`);
      onComplete();
    }
  }

  async extractCredentials(toolId: ToolId): Promise<Credentials> {
    await new Promise(r => setTimeout(r, 1000));

    if (toolId === 'claude') {
      const credentials = await ClaudeService.extractCredentials();
      // Store credentials for later copy functionality
      await this.storeCredentials(toolId, credentials);
      return credentials;
    } else if (toolId === 'codex') {
      const possiblePaths = [
        path.join(os.homedir(), '.codex', 'auth.json'),
        path.join(os.homedir(), '.codex', 'config.toml')
      ];

      for (const credPath of possiblePaths) {
        try {
          await fsPromises.access(credPath);
          const authData = await fsPromises.readFile(credPath, 'utf-8');

          let credentials: any = {};
          if (credPath.endsWith('.toml')) {
            // Parse TOML for key info
            const apiKeyMatch = authData.match(/api_key\s*=\s*"([^"]+)"/i);
            if (apiKeyMatch) {
              credentials.apiKey = apiKeyMatch[1];
            }
            credentials.path = credPath;
            credentials.format = 'toml';
            credentials.raw = authData;
          } else {
            const parsed = JSON.parse(authData);
            credentials = {
              ...parsed,
              path: credPath,
              format: 'json'
            };
          }

          credentials.status = 'authenticated';
          credentials.message = 'ChatGPT (Codex) authenticated successfully';

          logger.debug('AuthManager', `Codex credentials found at: ${credPath}`);
          this.sendLog(toolId, `Credentials extracted from: ${credPath}`);

          // Store for later copy functionality
          await this.storeCredentials(toolId, credentials);
          return credentials;
        } catch {
          continue;
        }
      }
    } else if (toolId === 'gemini') {
      const geminiDir = path.join(os.homedir(), '.gemini');
      const oauthPath = path.join(geminiDir, 'oauth_creds.json');

      let credentials: any = {
        status: 'authenticated',
        message: 'Gemini CLI authenticated successfully',
        storage: 'local-oauth'
      };

      try {
        await fsPromises.access(oauthPath);
        const oauthData = await fsPromises.readFile(oauthPath, 'utf-8');
        const parsed = JSON.parse(oauthData);

        credentials.oauth = {
          path: oauthPath,
          clientId: parsed.client_id,
          clientSecret: parsed.client_secret ? '***' : undefined,
          refreshToken: parsed.refresh_token ? '***' : undefined,
          accessToken: parsed.access_token ? '***' : undefined
        };

        logger.debug('AuthManager', 'Gemini OAuth credentials found');
        this.sendLog(toolId, 'OAuth credentials verified');
      } catch {
        logger.debug('AuthManager', 'Gemini CLI uses local cache for credentials');
        this.sendLog(toolId, 'Authentication completed (credentials cached locally)');
      }

      // Store for later copy functionality
      await this.storeCredentials(toolId, credentials);
      return credentials;
    }

    return {
      status: 'authenticated',
      message: 'Tool authenticated successfully',
      storage: 'unknown'
    };
  }

  async logoutTool(toolId: ToolId): Promise<{ success: boolean; message: string }> {
    try {
      if (toolId === 'claude') {
        return await ClaudeService.logout();
      } else if (toolId === 'codex') {
        return await this.logoutCodexWithResult();
      } else if (toolId === 'gemini') {
        return await this.logoutGemini();
      }

      return { success: false, message: 'Unknown tool' };
    } catch (error: any) {
      logger.error('AuthManager', `Error logging out ${toolId}`, error);
      return { success: false, message: error.message };
    }
  }

  private async logoutCodex(): Promise<void> {
    const logoutProcess = spawn('codex', ['logout'], {
      env: EnvironmentManager.getSpawnEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return new Promise((resolve) => {
      logoutProcess.on('close', (code) => {
        logger.debug('AuthManager', `Codex logout completed with code ${code}`);
        this.sendLog('codex', 'Logged out from Codex, starting fresh login...');
        resolve();
      });

      logoutProcess.on('error', () => {
        resolve();
      });
    });
  }

  private async logoutCodexWithResult(): Promise<{ success: boolean; message: string }> {
    const codexDir = path.join(os.homedir(), '.codex');
    const authPath = path.join(codexDir, 'auth.json');
    const configPath = path.join(codexDir, 'config.toml');

    let deletedAny = false;

    // Delete auth.json if exists
    try {
      await fsPromises.unlink(authPath);
      logger.debug('AuthManager', `Deleted Codex auth.json: ${authPath}`);
      deletedAny = true;
    } catch {
      logger.debug('AuthManager', `No Codex auth.json found at ${authPath}`);
    }

    // Delete config.toml if exists (contains auth info)
    try {
      await fsPromises.unlink(configPath);
      logger.debug('AuthManager', `Deleted Codex config.toml: ${configPath}`);
      deletedAny = true;
    } catch {
      logger.debug('AuthManager', `No Codex config.toml found at ${configPath}`);
    }

    // Also run codex logout command to ensure complete logout
    try {
      const env = EnvironmentManager.getSpawnEnv();
      execSync('codex logout', {
        env,
        stdio: 'pipe'
      });
      logger.debug('AuthManager', 'Executed codex logout command');
    } catch {
      // Ignore errors from logout command
    }

    if (deletedAny) {
      return { success: true, message: 'Codex logged out successfully' };
    } else {
      return { success: true, message: 'No Codex credentials to remove' };
    }
  }

  private async logoutGemini(): Promise<{ success: boolean; message: string }> {
    const geminiDir = path.join(os.homedir(), '.gemini');
    const filesToDelete = [
      path.join(geminiDir, 'oauth_creds.json'),
      path.join(geminiDir, 'settings.json')
    ];

    if (process.platform === 'win32') {
      const winPath = path.join(process.env.USERPROFILE || os.homedir(), '.gemini');
      filesToDelete.push(
        path.join(winPath, 'oauth_creds.json'),
        path.join(winPath, 'settings.json')
      );
    }

    let deletedAny = false;
    for (const file of filesToDelete) {
      try {
        await fsPromises.unlink(file);
        logger.debug('AuthManager', `Deleted Gemini file: ${file}`);
        deletedAny = true;
      } catch {}
    }

    return {
      success: true,
      message: deletedAny ? 'Gemini credentials removed' : 'No Gemini credentials found'
    };
  }

  private async clearGeminiCredentials(): Promise<void> {
    const geminiConfigPath = path.join(os.homedir(), '.gemini');
    try {
      const oauthCredsPath = path.join(geminiConfigPath, 'oauth_creds.json');
      if (fs.existsSync(oauthCredsPath)) {
        fs.unlinkSync(oauthCredsPath);
        logger.debug('AuthManager', 'Deleted Gemini OAuth credentials');
        this.sendLog('gemini', 'Cleared Gemini OAuth credentials');
      }

      const googleAccountsPath = path.join(geminiConfigPath, 'google_accounts.json');
      if (fs.existsSync(googleAccountsPath)) {
        fs.unlinkSync(googleAccountsPath);
        logger.debug('AuthManager', 'Deleted Gemini Google accounts cache');
      }
    } catch (err: any) {
      logger.error('AuthManager', 'Error clearing Gemini credentials', err);
    }
  }

  private async ensureGeminiOAuthSelected(): Promise<boolean> {
    try {
      const geminiDir = path.join(os.homedir(), '.gemini');
      await fsPromises.mkdir(geminiDir, { recursive: true });
      const settingsPath = path.join(geminiDir, 'settings.json');

      let settings: any = {};
      try {
        const raw = await fsPromises.readFile(settingsPath, 'utf-8');
        settings = JSON.parse(raw);
      } catch {}

      settings.security = settings.security || {};
      settings.security.auth = settings.security.auth || {};
      settings.security.auth.selectedType = 'oauth-personal';

      if (settings.security.auth.enforcedType && settings.security.auth.enforcedType !== 'oauth-personal') {
        delete settings.security.auth.enforcedType;
      }

      settings.selectedAuthType = 'oauth-personal';

      await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      return true;
    } catch (e: any) {
      logger.warn('AuthManager', 'Failed to ensure Gemini OAuth selection', e.message);
      return false;
    }
  }

  private cleanTerminalOutput(output: string): string {
    return output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                 .replace(/\[[\?>][0-9]+[a-z]/g, '')
                 .replace(/\[\d+[A-Z]/g, '');
  }

  private sendLog(toolId: ToolId | 'system', message: string): void {
    this.mainWindow.webContents.send('log', { toolId, message });
  }

  closeCallbackServers(): void {
    this.callbackServer.closeAll();
  }

  private async storeCredentials(toolId: ToolId, credentials: any): Promise<void> {
    // Store credentials in memory for copy functionality
    // In a production app, you might want to use a more secure storage method
    const storedCreds = {
      toolId,
      credentials,
      timestamp: new Date().toISOString()
    };

    // Send to renderer for display/copy functionality
    this.mainWindow.webContents.send('credentials-stored', storedCreds);
  }

  async getStoredCredentials(toolId: ToolId): Promise<any> {
    // Re-extract credentials when needed for copy
    if (await this.checkAuthenticated(toolId)) {
      return await this.extractCredentials(toolId);
    }
    return null;
  }

  async getCopyableCredentials(toolId: ToolId): Promise<{ copyText: string; message: string } | null> {
    try {
      if (toolId === 'claude') {
        // For Claude on macOS, try to get the actual credential from keychain
        if (process.platform === 'darwin') {
          try {
            const result = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
              encoding: 'utf-8'
            });
            if (result && result.trim()) {
              // Try to parse and format if it's JSON
              try {
                const parsed = JSON.parse(result.trim());
                return {
                  copyText: JSON.stringify(parsed, null, 2),
                  message: 'Claude credentials copied from Keychain'
                };
              } catch {
                // Not JSON, return as-is
                return {
                  copyText: result.trim(),
                  message: 'Claude credentials copied from Keychain'
                };
              }
            }
          } catch (error) {
            logger.debug('AuthManager', 'Could not read Claude credentials from Keychain, trying file');
          }
        }

        // Try to read from .claude.json file
        const authPath = path.join(os.homedir(), '.claude.json');
        try {
          const content = await fsPromises.readFile(authPath, 'utf-8');
          // Try to format JSON nicely
          try {
            const parsed = JSON.parse(content);
            return {
              copyText: JSON.stringify(parsed, null, 2),
              message: 'Claude credentials (formatted) copied'
            };
          } catch {
            return {
              copyText: content,
              message: 'Claude credentials copied'
            };
          }
        } catch (error) {
          logger.debug('AuthManager', `Claude credentials not found at ${authPath}`);
          return null;
        }
      } else if (toolId === 'codex') {
        // Try auth.json first
        const authJsonPath = path.join(os.homedir(), '.codex', 'auth.json');
        try {
          const content = await fsPromises.readFile(authJsonPath, 'utf-8');
          // Try to format JSON nicely
          try {
            const parsed = JSON.parse(content);
            return {
              copyText: JSON.stringify(parsed, null, 2),
              message: 'ChatGPT auth.json (formatted) copied'
            };
          } catch {
            return {
              copyText: content,
              message: 'ChatGPT auth.json copied'
            };
          }
        } catch {
          // Try config.toml
          const configPath = path.join(os.homedir(), '.codex', 'config.toml');
          try {
            const content = await fsPromises.readFile(configPath, 'utf-8');
            return {
              copyText: content,
              message: 'ChatGPT config.toml copied'
            };
          } catch (error) {
            logger.debug('AuthManager', `Codex credentials not found at ${authJsonPath} or ${configPath}`);
            return null;
          }
        }
      } else if (toolId === 'gemini') {
        const oauthPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
        try {
          const content = await fsPromises.readFile(oauthPath, 'utf-8');
          // Try to format JSON nicely
          try {
            const parsed = JSON.parse(content);
            return {
              copyText: JSON.stringify(parsed, null, 2),
              message: 'Gemini OAuth credentials (formatted) copied'
            };
          } catch {
            return {
              copyText: content,
              message: 'Gemini OAuth credentials copied'
            };
          }
        } catch {
          // Try settings.json as fallback
          const settingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
          try {
            const content = await fsPromises.readFile(settingsPath, 'utf-8');
            // Try to format JSON nicely
            try {
              const parsed = JSON.parse(content);
              return {
                copyText: JSON.stringify(parsed, null, 2),
                message: 'Gemini settings (formatted) copied'
              };
            } catch {
              return {
                copyText: content,
                message: 'Gemini settings copied'
              };
            }
          } catch (error) {
            logger.debug('AuthManager', `Gemini credentials not found at ${oauthPath} or ${settingsPath}`);
            return null;
          }
        }
      }
    } catch (error) {
      logger.error('AuthManager', `Error getting copyable credentials for ${toolId}`, error);
    }
    return null;
  }
}