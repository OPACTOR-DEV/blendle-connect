import { spawn, execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, shell } from 'electron';
import { logger } from '../utils/logger';
import { EnvironmentManager } from '../utils/environment';
import { OAuthWindow } from './oauth-window';
import { CLI_CONFIGS } from '../config/cli-configs';

interface ClaudeLoginOptions {
  mainWindow: BrowserWindow;
  onLog: (message: string) => void;
  onAuthComplete: () => void;
}

export class ClaudeService {

  static async performAutoLogin(options: ClaudeLoginOptions): Promise<void> {
    const { onLog, onAuthComplete } = options;

    logger.debug('ClaudeService', 'Starting Claude auto-login process using expect script');
    onLog('Starting Claude authentication process...');

    return new Promise(async (resolve, reject) => {
      const spawnEnv = EnvironmentManager.getSpawnEnv();

      // Check if expect is installed
      try {
        execSync('which expect', {
          stdio: 'ignore',
          env: spawnEnv
        });
      } catch (error) {
        logger.error('ClaudeService', 'expect is not installed');
        onLog('Error: expect is required but not installed. Please install it first.');
        reject(new Error('expect is not installed. Please install it with: brew install expect'));
        return;
      }

      const claudeBinary = this.resolveClaudeBinary(spawnEnv);
      logger.info('ClaudeService', `Using Claude binary: ${claudeBinary}`);

      // Determine writable directory for the expect script
      const scriptsDir = app.isPackaged
        ? path.join(app.getPath('userData'), 'scripts')
        : path.join(__dirname, '..', 'scripts');

      // Get the path to the expect script
      const scriptPath = path.join(scriptsDir, 'claude-login.exp');

      const scriptContent = `#!/usr/bin/expect -f

# Claude Code Automated Login Script
set timeout 90

# Clean up existing auth first
catch {exec pkill -f claude}
catch {exec security delete-generic-password -s "Claude Code-credentials"}

# Start Claude
set claude_path $env(CLAUDE_BIN)
if { $claude_path eq "" } {
    set claude_path "claude"
}
puts "LOGIN_INFO:Using Claude binary $claude_path"
spawn $claude_path

set login_sent 0
set url_found 0

while { $url_found == 0 } {
    expect {
        timeout {
            puts "LOGIN_FAILED:Timeout waiting for login flow"
            catch {send "\\003"}
            exit 1
        }
        eof {
            break
        }
        -re {Do you trust the files in this folder\?} {
            after 200
            send "1\\r"
            exp_continue
        }
        -re {Yes, proceed} {
            after 200
            send "1\\r"
            exp_continue
        }
        -re {Enter to confirm} {
            after 200
            send "\\r"
            exp_continue
        }
        -re {Choose the text style} {
            send "\\r"
            exp_continue
        }
        -re {Tips for getting started} {
            exp_continue
        }
        -re {Welcome to Claude Code} {
            if { $login_sent == 0 } {
                after 500
                send "/login\\r"
                after 300
                send "\\r"
                set login_sent 1
            }
            exp_continue
        }
        -re {Missing API key} {
            if { $login_sent == 0 } {
                after 500
                send "/login\\r"
                after 300
                send "\\r"
                set login_sent 1
            }
            exp_continue
        }
        -re {Run /login} {
            if { $login_sent == 0 } {
                after 500
                send "/login\\r"
                after 300
                send "\\r"
                set login_sent 1
            }
            exp_continue
        }
        -re {Sign in with your Anthropic account} {
            after 200
            send "\\r"
            exp_continue
        }
        -re {Select login method} {
            after 200
            send "\\r"
            exp_continue
        }
        -re {\\\[1\\\].*Anthropic} {
            after 200
            send "\\r"
            exp_continue
        }
        -re {(https://[^\\s\\)\\]]+)} {
            set url $expect_out(1,string)
            if {$url_found == 1} {
                exp_continue
            }
            set url_found 1
            puts "AUTH_URL:$url"
            # Don't open URL here, let Electron handle it
            puts "LOGIN_SUCCESS"
            after 2000
            catch {send "\\003"}
            break
        }
    }
}

expect eof`;

      // Create scripts directory if it doesn't exist
      if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
      }

      let shouldWriteScript = true;
      if (fs.existsSync(scriptPath)) {
        try {
          const existingContent = fs.readFileSync(scriptPath, 'utf-8');
          if (existingContent === scriptContent) {
            shouldWriteScript = false;
          }
        } catch (error) {
          logger.warn('ClaudeService', 'Failed to read existing expect script, rewriting it', error);
        }
      }

      if (shouldWriteScript) {
        fs.writeFileSync(scriptPath, scriptContent);
        logger.debug('ClaudeService', 'Wrote expect script at:', scriptPath);
      }

      // Make script executable
      try {
        fs.chmodSync(scriptPath, '755');
      } catch (error) {
        logger.error('ClaudeService', 'Failed to make script executable:', error);
      }

      // Clean up existing auth first
      onLog('Cleaning up existing authentication...');
      if (process.platform === 'darwin') {
        try {
          execSync('security delete-generic-password -s "Claude Code-credentials" 2>/dev/null');
          logger.debug('ClaudeService', 'Removed Claude credentials from macOS Keychain');
        } catch {
          // Credentials don't exist, that's fine
        }
      }

      // Run the expect script
      logger.info('ClaudeService', 'Running expect script:', scriptPath);
      const expectProcess = spawn('expect', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...spawnEnv,
          CLAUDE_BIN: claudeBinary
        }
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
          logger.info('ClaudeService', `Expect output: ${cleanOutput}`);
        }

        // Check for authentication URL
        if (text.includes('AUTH_URL:')) {
          const urlMatch = text.match(/AUTH_URL:(.+)/);
          if (urlMatch) {
            authUrl = urlMatch[1].trim();
            logger.debug('ClaudeService', 'Authentication URL captured:', authUrl);
            onLog('Opening authentication page in OAuth window...');

            // Use OAuth window to intercept redirects
            const config = CLI_CONFIGS['claude'];
            const oauthWindow = new OAuthWindow('claude', config.port);
            oauthWindow.open(authUrl).then(() => {
              logger.info('ClaudeService', 'Claude OAuth window closed');
              onAuthComplete();
              if (!resolved) {
                resolved = true;
                resolve();
              }
            }).catch(err => {
              logger.error('ClaudeService', 'Claude OAuth window error:', err);
              // Fallback to opening in default browser
              shell.openExternal(authUrl);
            });
          }
        }

        // Check for success indicator
        if (text.includes('LOGIN_SUCCESS')) {
          logger.debug('ClaudeService', 'Login flow completed successfully');
          onLog('Browser opened successfully. Please complete authentication in your browser.');

          // Wait a bit then check if authenticated
          setTimeout(() => {
            this.checkAuthenticated().then(isAuth => {
              if (isAuth) {
                onAuthComplete();
                if (!resolved) {
                  resolved = true;
                  resolve();
                }
              }
            });
          }, 2000);
        }

        // Check for failure
        if (text.includes('LOGIN_FAILED')) {
          const reason = text.match(/LOGIN_FAILED:(.+)/);
          const errorMsg = reason ? reason[1] : 'Unknown reason';
          logger.error('ClaudeService', 'Login failed:', errorMsg);
          onLog(`Login failed: ${errorMsg}`);
          if (!resolved) {
            resolved = true;
            reject(new Error(`Login failed: ${errorMsg}`));
          }
        }
      });

      expectProcess.stderr?.on('data', (data) => {
        const error = data.toString();
        logger.error('ClaudeService', 'Expect error:', error);
      });

      expectProcess.on('error', (error) => {
        logger.error('ClaudeService', 'Expect process error:', error);
        if (!resolved) {
          resolved = true;
          reject(new Error(`Expect process error: ${error.message}`));
        }
      });

      // Check for auth creation periodically
      const configCheck = setInterval(() => {
        if (process.platform === 'darwin') {
          try {
            const result = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
              encoding: 'utf-8'
            });
            if (result && result.trim().length > 0 && !resolved) {
              logger.info('ClaudeService', 'Detected Claude credentials in macOS Keychain');
              clearInterval(configCheck);
              onAuthComplete();
              resolved = true;
              resolve();
            }
          } catch {
            // Not found yet, keep checking
          }
        }
      }, 1000);

      expectProcess.on('close', (code) => {
        logger.info('ClaudeService', `Expect process exited with code ${code}`);
        clearInterval(configCheck);

        if (!resolved) {
          // Check one more time if authenticated
          setTimeout(() => {
            this.checkAuthenticated().then(isAuth => {
              if (!resolved) {
                resolved = true;
                if (isAuth) {
                  onAuthComplete();
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

      // Timeout after 60 seconds
      setTimeout(() => {
        clearInterval(configCheck);
        if (!resolved) {
          resolved = true;
          expectProcess.kill();
          reject(new Error('Claude login process timed out'));
        }
      }, 60000);
    });
  }

  static async checkAuthenticated(): Promise<boolean> {
    // On macOS, Claude stores auth info in Keychain
    if (process.platform === 'darwin') {
      try {
        const result = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
          encoding: 'utf-8'
        });
        if (result && result.trim().length > 0) {
          logger.debug('ClaudeService', 'Found Claude credentials in macOS Keychain');
          return true;
        }
      } catch {
        logger.debug('ClaudeService', 'No Claude credentials found in macOS Keychain');
      }
    } else {
      // For other platforms, check for .claude.json file
      const authPath = path.join(os.homedir(), '.claude.json');
      try {
        await fs.promises.access(authPath);
        logger.debug('ClaudeService', 'Found existing .claude.json auth file');
        return true;
      } catch {
        logger.debug('ClaudeService', 'No .claude.json auth file found');
      }
    }

    // Also check if claude is authenticated by running a simple command
    const env = EnvironmentManager.getSpawnEnv();
    const claudeBinary = this.resolveClaudeBinary(env);

    return new Promise((resolve) => {
      const checkProcess = spawn(claudeBinary, [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = '';
      let timeout: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timeout);
        checkProcess.kill();
      };

      checkProcess.stdout?.on('data', (data) => {
        output += data.toString();
        // If we see the welcome message, Claude is authenticated
        if (output.includes('Welcome to Claude')) {
          cleanup();
          resolve(true);
        }
      });

      checkProcess.on('error', () => {
        logger.error('ClaudeService', 'Failed to run claude during authentication check');
        cleanup();
        resolve(false);
      });

      // Send exit command after a short delay
      setTimeout(() => {
        checkProcess.stdin?.write('/exit\n');
      }, 500);

      // Timeout after 2 seconds
      timeout = setTimeout(() => {
        cleanup();
        // If we got some output but no error, assume authenticated
        resolve(output.length > 0);
      }, 2000);
    });
  }

  static async logout(): Promise<{ success: boolean; message: string }> {
    const credentialRemovalPromise = this.removeStoredCredentials();
    const cliLogoutPromise = this.runCliLogout();

    const [cliSuccess, credentialsDeleted] = await Promise.all([cliLogoutPromise, credentialRemovalPromise]);

    if (!cliSuccess) {
      return {
        success: false,
        message: credentialsDeleted ? 'Logout command failed, but credentials were removed' : 'Failed to logout from Claude'
      };
    }

    return {
      success: true,
      message: credentialsDeleted ? 'Claude logged out and credentials removed' : 'Claude logged out successfully'
    };
  }

  private static runCliLogout(): Promise<boolean> {
    return new Promise((resolve) => {
      const env = EnvironmentManager.getSpawnEnv();
      const claudeBinary = this.resolveClaudeBinary(env);

      const logoutProcess = spawn(claudeBinary, [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let resolved = false;
      let timeout: NodeJS.Timeout;

      const finish = (success: boolean) => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(timeout);

        if (logoutProcess.exitCode === null) {
          try {
            logoutProcess.kill();
          } catch {
            // ignore errors on kill
          }
        }

        resolve(success);
      };

      setTimeout(() => {
        logger.debug('ClaudeService', 'Sending /logout command');
        logoutProcess.stdin?.write('/logout\n');
      }, 500);

      setTimeout(() => {
        logoutProcess.stdin?.write('/exit\n');
      }, 1500);

      logoutProcess.on('close', () => finish(true));
      logoutProcess.on('error', (err) => {
        logger.error('ClaudeService', 'Failed to spawn claude for logout', err);
        finish(false);
      });

      timeout = setTimeout(() => finish(true), 3000);
    });
  }

  private static removeStoredCredentials(): Promise<boolean> {
    if (process.platform === 'darwin') {
      return new Promise((resolve) => {
        const securityProcess = spawn('security', ['delete-generic-password', '-s', 'Claude Code-credentials'], {
          stdio: 'ignore'
        });

        securityProcess.on('close', (code) => {
          if (code === 0) {
            logger.debug('ClaudeService', 'Deleted Claude credentials from macOS Keychain');
            resolve(true);
          } else {
            logger.debug('ClaudeService', 'No Claude credentials to delete from Keychain');
            resolve(false);
          }
        });

        securityProcess.on('error', (error) => {
          logger.error('ClaudeService', 'Failed to delete Claude credentials from macOS Keychain', error);
          resolve(false);
        });
      });
    }

    const authPath = path.join(os.homedir(), '.claude.json');
    return fs.promises.unlink(authPath)
      .then(() => {
        logger.debug('ClaudeService', `Deleted Claude auth file: ${authPath}`);
        return true;
      })
      .catch(() => {
        logger.debug('ClaudeService', 'No .claude.json file to delete');
        return false;
      });
  }

  private static resolveClaudeBinary(env: NodeJS.ProcessEnv): string {
    try {
      const result = execSync('which claude', {
        env,
        encoding: 'utf-8'
      }).trim();

      if (result.length > 0) {
        return result;
      }
    } catch (error) {
      logger.warn('ClaudeService', 'Unable to resolve Claude binary via which command', error);
    }

    logger.info('ClaudeService', 'Falling back to claude from PATH');
    return 'claude';
  }

  static async extractCredentials(): Promise<any> {
    await new Promise(r => setTimeout(r, 1000));

    if (process.platform === 'darwin') {
      // On macOS, credentials are in Keychain
      try {
        const result = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
          encoding: 'utf-8'
        });
        if (result && result.trim().length > 0) {
          logger.debug('ClaudeService', 'Claude credentials found in macOS Keychain');

          // Try to parse the stored credential
          let credentialInfo: any = {
            status: 'authenticated',
            message: 'Claude Code authenticated successfully',
            storage: 'macOS Keychain',
            service: 'Claude Code-credentials',
            copyable: false // Keychain items are not directly copyable
          };

          try {
            const parsed = JSON.parse(result.trim());
            if (parsed.api_key || parsed.apiKey) {
              credentialInfo.apiKey = parsed.api_key || parsed.apiKey;
              credentialInfo.copyable = true;
            }
          } catch {
            // Not JSON format, might be raw token
            if (result.trim().length > 20) {
              credentialInfo.hasToken = true;
            }
          }

          return credentialInfo;
        }
      } catch {
        // Fall through to default response
      }
    } else {
      // For other platforms, check .claude.json file
      const authPath = path.join(os.homedir(), '.claude.json');
      try {
        await fs.promises.access(authPath);
        const stats = await fs.promises.stat(authPath);
        const authData = await fs.promises.readFile(authPath, 'utf-8');

        logger.debug('ClaudeService', `Claude credentials found at: ${authPath} (${stats.size} bytes)`);

        let credentialInfo: any = {
          status: 'authenticated',
          message: 'Claude Code authenticated successfully',
          path: authPath,
          format: 'json',
          size: stats.size,
          copyable: false
        };

        try {
          const parsed = JSON.parse(authData);
          if (parsed.api_key || parsed.apiKey) {
            credentialInfo.apiKey = parsed.api_key || parsed.apiKey;
            credentialInfo.copyable = true;
          }
        } catch {
          // Unable to parse, just note the file exists
        }

        return credentialInfo;
      } catch {
        // Fall through to default response
      }
    }

    return {
      status: 'authenticated',
      message: 'Claude Code authenticated (verification skipped)',
      storage: 'unknown',
      copyable: false
    };
  }
}
