import { spawn, execSync, exec } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow, shell } from 'electron';
import { logger } from '../utils/logger';
import { EnvironmentManager } from '../utils/environment';

interface ClaudeLoginOptions {
  mainWindow: BrowserWindow;
  onLog: (message: string) => void;
  onAuthComplete: () => void;
}

export class ClaudeService {
  private static buffer = '';

  static async performAutoLogin(options: ClaudeLoginOptions): Promise<void> {
    const { onLog, onAuthComplete } = options;

    logger.debug('ClaudeService', 'Starting Claude auto-login process using expect script');
    onLog('Starting Claude authentication process...');

    return new Promise(async (resolve, reject) => {
      // Check if expect is installed
      try {
        execSync('which expect', { stdio: 'ignore' });
      } catch (error) {
        logger.error('ClaudeService', 'expect is not installed');
        onLog('Error: expect is required but not installed. Please install it first.');
        reject(new Error('expect is not installed. Please install it with: brew install expect'));
        return;
      }

      // Get the path to the expect script
      const scriptPath = path.join(__dirname, '..', 'scripts', 'claude-login.exp');

      // Create the script if it doesn't exist
      if (!fs.existsSync(scriptPath)) {
        const scriptContent = `#!/usr/bin/expect -f

# Claude Code Automated Login Script
set timeout 60

# Clean up existing auth first
catch {exec pkill -f claude}
catch {exec security delete-generic-password -s "Claude Code-credentials"}

# Start Claude
spawn claude

# Handle initial interaction
expect {
    "Choose the text style" {
        send "\\r"
        exp_continue
    }
    "Select login method" {
        # Select option 1 (Anthropic account)
        send "\\r"

        # Wait for browser URL
        expect {
            -re {(https://[^\\s\\)\\]]+)} {
                set url $expect_out(1,string)
                puts "AUTH_URL:$url"

                # Open browser
                catch {exec open "$url"}

                # Success indicator
                puts "LOGIN_SUCCESS"

                # Wait a moment for browser to open
                sleep 3
                send "\\003"
            }
            timeout {
                puts "LOGIN_FAILED:No URL detected"
                send "\\003"
            }
        }
    }
    timeout {
        puts "LOGIN_FAILED:Initial timeout"
    }
}

expect eof`;

        // Create scripts directory if it doesn't exist
        const scriptsDir = path.dirname(scriptPath);
        if (!fs.existsSync(scriptsDir)) {
          fs.mkdirSync(scriptsDir, { recursive: true });
        }

        fs.writeFileSync(scriptPath, scriptContent);
        logger.debug('ClaudeService', 'Created expect script at:', scriptPath);
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
      logger.debug('ClaudeService', 'Running expect script:', scriptPath);
      const expectProcess = spawn('expect', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe']
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
          logger.debug('ClaudeService', 'Expect output:', cleanOutput);
        }

        // Check for authentication URL
        if (text.includes('AUTH_URL:')) {
          const urlMatch = text.match(/AUTH_URL:(.+)/);
          if (urlMatch) {
            authUrl = urlMatch[1].trim();
            logger.debug('ClaudeService', 'Authentication URL captured:', authUrl);
            onLog('Opening authentication page in browser...');
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
        clearInterval(configCheck);
        logger.debug('ClaudeService', `Expect process exited with code ${code}`);

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
    return new Promise((resolve) => {
      const checkProcess = spawn('claude', [], {
        env: EnvironmentManager.getSpawnEnv(),
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
    let credentialsDeleted = false;

    // On macOS, delete from Keychain
    if (process.platform === 'darwin') {
      try {
        execSync('security delete-generic-password -s "Claude Code-credentials" 2>/dev/null');
        logger.debug('ClaudeService', 'Deleted Claude credentials from macOS Keychain');
        credentialsDeleted = true;
      } catch {
        logger.debug('ClaudeService', 'No Claude credentials to delete from Keychain');
      }
    } else {
      // For other platforms, delete .claude.json file
      const authPath = path.join(os.homedir(), '.claude.json');
      try {
        await fs.promises.unlink(authPath);
        logger.debug('ClaudeService', `Deleted Claude auth file: ${authPath}`);
        credentialsDeleted = true;
      } catch {
        logger.debug('ClaudeService', 'No .claude.json file to delete');
      }
    }

    // Then also try to logout via CLI command
    return new Promise((resolve) => {
      const logoutProcess = spawn('claude', [], {
        env: EnvironmentManager.getSpawnEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let timeout: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timeout);
        logoutProcess.kill();
      };

      // Send /logout command
      setTimeout(() => {
        logger.debug('ClaudeService', 'Sending /logout command');
        logoutProcess.stdin?.write('/logout\n');
      }, 500);

      // Wait a bit then exit
      setTimeout(() => {
        logoutProcess.stdin?.write('/exit\n');
      }, 1500);

      logoutProcess.on('close', () => {
        cleanup();
        resolve({ success: true, message: credentialsDeleted ? 'Claude logged out and credentials removed' : 'Claude logged out successfully' });
      });

      logoutProcess.on('error', () => {
        cleanup();
        resolve({ success: false, message: 'Failed to logout from Claude' });
      });

      // Timeout after 3 seconds
      timeout = setTimeout(() => {
        cleanup();
        resolve({ success: true, message: 'Claude logout completed' });
      }, 3000);
    });
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
          return {
            status: 'authenticated',
            message: 'Claude Code authenticated successfully',
            storage: 'macOS Keychain',
            service: 'Claude Code-credentials'
          };
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

        logger.debug('ClaudeService', `Claude credentials found at: ${authPath} (${stats.size} bytes)`);

        return {
          status: 'authenticated',
          message: 'Claude Code authenticated successfully',
          path: authPath,
          format: 'json',
          size: stats.size
        };
      } catch {
        // Fall through to default response
      }
    }

    return {
      status: 'authenticated',
      message: 'Claude Code authenticated (verification skipped)',
      storage: 'unknown'
    };
  }
}