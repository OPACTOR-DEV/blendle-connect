import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { ToolId, Credentials } from '../types';
import { CLI_CONFIGS } from '../config/cli-configs';
import { EnvironmentManager } from '../utils/environment';
import { logger } from '../utils/logger';
import { CallbackServer } from './callback-server';
import { ClaudeService } from './claude-service';
import { OAuthWindow } from './oauth-window';
import { ApiClient, StoreTokenRequest } from './api-client';


export class AuthManager {
  private mainWindow: BrowserWindow;
  private callbackServer: CallbackServer;
  private apiClient: ApiClient;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    this.callbackServer = new CallbackServer(mainWindow);
    this.apiClient = new ApiClient();
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

    // Codex uses its own local server on port 1455, so don't start callback server
    if (toolId !== 'codex') {
      await this.callbackServer.setupCallbackServer(toolId);
      await new Promise(r => setTimeout(r, 500));
    }

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
        // Show in-app success notification
        this.mainWindow.webContents.send('show-success-screen', {
          toolId: 'claude',
          toolName: 'Claude Code'
        });
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
            clearInterval(credPoll);
            logger.info('AuthManager', 'Detected Gemini OAuth credentials on disk');
            this.sendLog(toolId, 'Detected Gemini OAuth credentials on disk');
            if (!authCompleted) {
              authCompleted = true;
              this.mainWindow.webContents.send('show-success-screen', {
                toolId,
                toolName: 'Gemini CLI'
              });
            }
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
        if (!authCompleted) {
          authCompleted = true;
          // Show in-app success notification
          this.mainWindow.webContents.send('show-success-screen', {
            toolId,
            toolName: 'Gemini CLI'
          });
        }
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
    logger.debug('AuthManager', 'Codex re-authentication using expect script');

    await this.logoutCodex();

    return new Promise(async (resolve, reject) => {
      const spawnEnv = EnvironmentManager.getSpawnEnv();

      // Check if expect is installed
      try {
        execSync('which expect', {
          stdio: 'ignore',
          env: spawnEnv
        });
      } catch (error) {
        logger.error('AuthManager', 'expect is not installed');
        this.sendLog(toolId, 'Error: expect is required but not installed. Please install it first.');
        reject(new Error('expect is not installed. Please install it with: brew install expect'));
        return;
      }

      // Use the existing standalone expect script
      const packagedScriptPath = path.join(__dirname, '..', 'scripts', 'codex-login.exp');

      if (!fs.existsSync(packagedScriptPath)) {
        logger.error('AuthManager', 'Codex expect script not found at:', packagedScriptPath);
        reject(new Error(`Expect script not found at ${packagedScriptPath}`));
        return;
      }

      let scriptPath = packagedScriptPath;

      if (app.isPackaged) {
        try {
          const userScriptsDir = path.join(app.getPath('userData'), 'scripts');
          fs.mkdirSync(userScriptsDir, { recursive: true });
          const extractedScriptPath = path.join(userScriptsDir, 'codex-login.exp');
          fs.copyFileSync(packagedScriptPath, extractedScriptPath);
          scriptPath = extractedScriptPath;
        } catch (copyError) {
          logger.error('AuthManager', 'Failed to extract Codex expect script:', copyError);
          reject(new Error('Failed to prepare automation script for Codex login.'));
          return;
        }
      }

      // Make sure script is executable
      try {
        fs.chmodSync(scriptPath, '755');
      } catch (error) {
        logger.error('AuthManager', 'Failed to make Codex script executable:', error);
      }

      logger.info('AuthManager', 'Running Codex expect script:', scriptPath);
      const expectProcess = spawn('expect', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv
      });

      let output = '';
      let authUrl = '';
      let resolved = false;

      expectProcess.stdout?.on('data', (data) => {
        const text = data.toString();
        output += text;

        // Clean output for logging
        const cleanOutput = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (cleanOutput) {
          logger.info('AuthManager', `Codex expect output: ${cleanOutput}`);
        }

        // Check for authentication URL
        if (text.includes('AUTH_URL:')) {
          const urlMatch = text.match(/AUTH_URL:(.+)/);
          if (urlMatch) {
            authUrl = urlMatch[1].trim();
            logger.debug('AuthManager', 'Codex authentication URL captured:', authUrl);
            this.sendLog(toolId, 'Browser should open automatically for authentication...');

            // Don't open browser manually - codex login already opens it
            // Just log that we detected the URL for user information
          }
        }

        // Log meaningful output to UI
        if (text.includes('LOGIN_INFO:')) {
          const infoMatch = text.match(/LOGIN_INFO:(.+)/);
          if (infoMatch) {
            this.sendLog(toolId, infoMatch[1].trim());
          }
        }

        // Check for success indicator
        if (text.includes('LOGIN_SUCCESS')) {
          logger.debug('AuthManager', 'Codex login flow completed successfully');
          this.sendLog(toolId, 'Authentication completed successfully!');

          // Show in-app success notification
          this.mainWindow.webContents.send('show-success-screen', {
            toolId,
            toolName: 'Codex CLI'
          });

          // Wait a bit then check if authenticated
          setTimeout(() => {
            this.checkAuthenticated(toolId).then(isAuth => {
              if (isAuth && !resolved) {
                resolved = true;
                resolve();
              }
            });
          }, 2000);
        }

        // Check for failure
        if (text.includes('LOGIN_FAILED')) {
          const reason = text.match(/LOGIN_FAILED:(.+)/);
          const errorMsg = reason ? reason[1] : 'Unknown reason';
          logger.error('AuthManager', 'Codex login failed:', errorMsg);
          this.sendLog(toolId, `Login failed: ${errorMsg}`);
          if (!resolved) {
            resolved = true;
            reject(new Error(`Login failed: ${errorMsg}`));
          }
        }
      });

      expectProcess.stderr?.on('data', (data) => {
        const error = data.toString();
        // Only log meaningful errors (not expect's minor warnings)
        if (!error.includes('spawn id') && !error.includes('not open')) {
          logger.error('AuthManager', 'Codex expect error:', error);
        }
      });

      expectProcess.on('error', (error) => {
        logger.error('AuthManager', 'Codex expect process error:', error);
        if (!resolved) {
          resolved = true;
          reject(new Error(`Expect process error: ${error.message}`));
        }
      });

      // Check for auth file creation periodically (less frequent to avoid race with expect script)
      const configCheck = setInterval(() => {
        const authPath = path.join(os.homedir(), '.codex', 'auth.json');
        const configPath = path.join(os.homedir(), '.codex', 'config.toml');
        try {
          if ((fs.existsSync(authPath) || fs.existsSync(configPath)) && !resolved) {
            logger.info('AuthManager', 'Detected Codex auth file on disk');
            clearInterval(configCheck);
            resolved = true;
            resolve();
          }
        } catch {
          // Not found yet, keep checking
        }
      }, 3000);

      expectProcess.on('close', (code) => {
        logger.info('AuthManager', `Codex expect process exited with code ${code}`);
        clearInterval(configCheck);

        if (!resolved) {
          // Check one more time if authenticated
          setTimeout(() => {
            this.checkAuthenticated(toolId).then(isAuth => {
              if (!resolved) {
                resolved = true;
                if (isAuth) {
                  resolve();
                } else if (code === 0) {
                  resolve(); // Script completed successfully
                } else {
                  reject(new Error(`Expect script failed with code ${code}`));
                }
              }
            });
          }, 1000);
        }
      });

      // Timeout after 10 minutes
      setTimeout(() => {
        clearInterval(configCheck);
        if (!resolved) {
          resolved = true;
          expectProcess.kill();
          reject(new Error('Codex login process timed out'));
        }
      }, 10 * 60 * 1000);
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
        this.sendLog(toolId, 'Opening authentication page in OAuth window...');

        // Use OAuth window to intercept redirects
        const config = CLI_CONFIGS[toolId];
        const oauthWindow = new OAuthWindow(toolId, config.port);
        oauthWindow.open(authUrl).then(() => {
          logger.info('AuthManager', 'Gemini OAuth window closed');
          onAuthComplete();
        }).catch(err => {
          logger.error('AuthManager', 'Gemini OAuth window error:', err);
          // Fallback to opening in default browser
          shell.openExternal(authUrl);
        });
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
      'authentication success',
      'logged in as',
      'authentication complete',
      'login successful',
      'authenticated successfully',
      'login completed',
      'loaded cached credentials',
      'already authenticated',
      'credentials loaded',
      'auth_success'
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
      // Store credentials to backend
      await this.storeCredentialsToBackend(toolId, credentials);
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
          // Store credentials to backend
          await this.storeCredentialsToBackend(toolId, credentials);
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
      // Store credentials to backend
      await this.storeCredentialsToBackend(toolId, credentials);
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

    // Also run codex logout command first to ensure complete logout
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

    // Remove entire .codex directory
    try {
      if (fs.existsSync(codexDir)) {
        await fsPromises.rm(codexDir, { recursive: true, force: true });
        logger.debug('AuthManager', `Deleted entire Codex directory: ${codexDir}`);
        return { success: true, message: 'Codex logged out successfully' };
      } else {
        logger.debug('AuthManager', `No Codex directory found at ${codexDir}`);
        return { success: true, message: 'No Codex credentials to remove' };
      }
    } catch (error: any) {
      logger.error('AuthManager', `Error removing Codex directory: ${error.message}`);
      return { success: false, message: `Error removing Codex credentials: ${error.message}` };
    }
  }

  private async logoutGemini(): Promise<{ success: boolean; message: string }> {
    const geminiDir = path.join(os.homedir(), '.gemini');

    // Remove entire .gemini directory
    try {
      if (fs.existsSync(geminiDir)) {
        await fsPromises.rm(geminiDir, { recursive: true, force: true });
        logger.debug('AuthManager', `Deleted entire Gemini directory: ${geminiDir}`);
        return { success: true, message: 'Gemini logged out successfully' };
      } else {
        logger.debug('AuthManager', `No Gemini directory found at ${geminiDir}`);
        return { success: true, message: 'No Gemini credentials to remove' };
      }
    } catch (error: any) {
      logger.error('AuthManager', `Error removing Gemini directory: ${error.message}`);
      return { success: false, message: `Error removing Gemini credentials: ${error.message}` };
    }
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

  private async storeCredentialsToBackend(toolId: ToolId, credentials: any): Promise<void> {
    try {
      // Use dummy user ID for now - in production, this should come from actual user authentication
      const userId = 'dummy-user-id';

      // Convert toolId to provider format expected by backend
      let provider: 'claude' | 'codex' | 'gemini';
      switch (toolId) {
        case 'claude':
          provider = 'claude';
          break;
        case 'codex':
          provider = 'codex';
          break;
        case 'gemini':
          provider = 'gemini';
          break;
        default:
          logger.warn('AuthManager', `Unknown toolId for backend storage: ${toolId}`);
          return;
      }

      // Prepare token data
      let tokenData: string;
      let originalPath: string | undefined;
      let format: string = 'json';
      let metadata: any = {};

      if (toolId === 'claude') {
        // For Claude, we might have the raw credentials or need to read from keychain
        if (typeof credentials === 'object') {
          tokenData = JSON.stringify(credentials);
        } else {
          tokenData = credentials;
        }
        originalPath = path.join(os.homedir(), '.claude.json');
        metadata = {
          provider: 'claude',
          storage: credentials.storage || 'keychain',
          extractedAt: new Date().toISOString(),
        };
      } else if (toolId === 'codex') {
        // For Codex, use the raw data and path information
        if (credentials.raw) {
          tokenData = credentials.raw;
        } else {
          tokenData = JSON.stringify(credentials);
        }
        originalPath = credentials.path;
        format = credentials.format || 'json';
        metadata = {
          provider: 'codex',
          apiKey: credentials.apiKey ? '***' : undefined,
          extractedAt: new Date().toISOString(),
        };
      } else if (toolId === 'gemini') {
        // For Gemini, store the OAuth credentials
        if (credentials.oauth) {
          tokenData = JSON.stringify(credentials.oauth);
          originalPath = credentials.oauth.path;
        } else {
          tokenData = JSON.stringify(credentials);
        }
        metadata = {
          provider: 'gemini',
          storage: credentials.storage || 'oauth',
          extractedAt: new Date().toISOString(),
        };
      } else {
        logger.warn('AuthManager', `Unsupported toolId for backend storage: ${toolId}`);
        return;
      }

      const storeRequest: StoreTokenRequest = {
        provider,
        userId,
        tokenData,
        originalPath,
        format,
        metadata,
      };

      logger.info('AuthManager', `Storing credentials for ${provider} to backend...`);
      this.sendLog(toolId, `Storing credentials to backend API...`);

      const result = await this.apiClient.storeToken(storeRequest);

      if (result.success) {
        logger.info('AuthManager', `Successfully stored ${provider} credentials to backend`);
        this.sendLog(toolId, `Credentials stored to backend successfully`);
      } else {
        logger.error('AuthManager', `Failed to store ${provider} credentials:`, result.message);
        this.sendLog(toolId, `Failed to store credentials to backend: ${result.message}`);
      }
    } catch (error: any) {
      logger.error('AuthManager', `Error storing credentials to backend for ${toolId}:`, error.message);
      this.sendLog(toolId, `Error storing credentials to backend: ${error.message}`);
    }
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
