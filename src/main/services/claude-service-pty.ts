import { spawn, execSync } from 'child_process';
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

    logger.debug('ClaudeService', 'Starting Claude auto-login process with script command');
    onLog('Starting Claude authentication process...');

    return new Promise(async (resolve, reject) => {
      // First, ensure we're logged out by removing credentials
      if (process.platform === 'darwin') {
        try {
          execSync('security delete-generic-password -s "Claude Code-credentials" 2>/dev/null');
          logger.debug('ClaudeService', 'Removed Claude credentials from macOS Keychain');
          onLog('Removed existing authentication from Keychain...');
        } catch {
          // Credentials don't exist, that's fine
        }
      }

      // Create a temporary script file for the login process
      const scriptPath = path.join(os.tmpdir(), `claude-login-${Date.now()}.sh`);
      const scriptContent = `#!/bin/bash
sleep 2
echo "/login"
sleep 1
echo "1"
sleep 30
`;

      await fs.promises.writeFile(scriptPath, scriptContent, { mode: 0o755 });

      // Use script command to provide TTY
      const env = EnvironmentManager.getSpawnEnv();
      const scriptCmd = spawn('script', ['-q', '/dev/null', 'bash', '-c', `cat ${scriptPath} | claude`], {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let authCompleted = false;
      let resolved = false;

      const handleData = (data: Buffer) => {
        const output = data.toString();
        this.buffer += output;

        // Clean output for logging
        const cleanOutput = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();

        // Log meaningful output
        if (cleanOutput && cleanOutput.length > 0) {
          logger.debug('ClaudeService', `Output: ${cleanOutput.substring(0, 200)}`);

          if (cleanOutput.includes('login') || cleanOutput.includes('Login') ||
              cleanOutput.includes('account') || cleanOutput.includes('Anthropic')) {
            onLog(cleanOutput.substring(0, 200));
          }
        }

        // Check for browser opening
        const urlMatch = this.buffer.match(/(https?:\/\/[^\s\)\]]+)/);
        if (urlMatch) {
          const authUrl = urlMatch[1].replace(/[)\]'"]*$/, '');
          logger.debug('ClaudeService', `Found Claude auth URL: ${authUrl}`);
          onLog('Opening authentication page in browser...');
          shell.openExternal(authUrl);
          this.buffer = '';
          authCompleted = true;
          onAuthComplete();
        }

        // Check for authentication success
        const successPatterns = [
          /successfully signed in/i,
          /authentication successful/i,
          /logged in as/i,
          /Welcome to Claude/i
        ];

        if (successPatterns.some(pattern => pattern.test(this.buffer))) {
          logger.debug('ClaudeService', 'Authentication might already be complete');
        }
      };

      scriptCmd.stdout?.on('data', handleData);
      scriptCmd.stderr?.on('data', handleData);

      // Check for auth file creation
      const configCheck = setInterval(() => {
        if (process.platform === 'darwin') {
          try {
            const result = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
              encoding: 'utf-8'
            });
            if (result && result.trim().length > 0 && !authCompleted) {
              logger.info('ClaudeService', 'Detected Claude credentials in macOS Keychain');
              authCompleted = true;
              clearInterval(configCheck);
              onAuthComplete();
            }
          } catch {
            // Not found yet, keep checking
          }
        }
      }, 500);

      // Timeout
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          clearInterval(configCheck);
          scriptCmd.kill();
          fs.promises.unlink(scriptPath).catch(() => {});
          reject(new Error('Claude login process timed out'));
        }
      }, 60000); // 1 minute timeout

      // Monitor completion
      const authMonitor = setInterval(() => {
        if (authCompleted && !resolved) {
          resolved = true;
          clearInterval(authMonitor);
          clearInterval(configCheck);
          clearTimeout(timeout);

          setTimeout(() => {
            scriptCmd.kill();
            fs.promises.unlink(scriptPath).catch(() => {});
            resolve();
          }, 1000);
        }
      }, 100);

      scriptCmd.on('exit', (code) => {
        clearInterval(authMonitor);
        clearInterval(configCheck);
        clearTimeout(timeout);
        fs.promises.unlink(scriptPath).catch(() => {});

        logger.debug('ClaudeService', `Script process exited with code ${code}`);

        if (!resolved) {
          resolved = true;
          if (authCompleted || code === 0) {
            resolve();
          } else {
            reject(new Error(`Claude login process failed with code ${code}`));
          }
        }
      });

      scriptCmd.on('error', (error) => {
        clearInterval(authMonitor);
        clearInterval(configCheck);
        clearTimeout(timeout);
        fs.promises.unlink(scriptPath).catch(() => {});

        if (!resolved) {
          resolved = true;
          reject(new Error(`Failed to start Claude process: ${error.message}`));
        }
      });
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
    }
    return false;
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
    }

    return {
      success: true,
      message: credentialsDeleted ? 'Claude logged out and credentials removed' : 'Claude logged out successfully'
    };
  }

  static async extractCredentials(): Promise<any> {
    await new Promise(r => setTimeout(r, 1000));

    if (process.platform === 'darwin') {
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
        // Fall through
      }
    }

    return {
      status: 'authenticated',
      message: 'Claude Code authenticated (verification skipped)',
      storage: 'unknown'
    };
  }
}