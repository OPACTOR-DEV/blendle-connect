import { spawn } from 'child_process';
import { BrowserWindow } from 'electron';
import { ToolId } from '../types';
import { CLI_CONFIGS } from '../config/cli-configs';
import { EnvironmentManager } from '../utils/environment';
import { logger } from '../utils/logger';

export class ToolInstaller {
  private mainWindow: BrowserWindow;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  async checkNodeInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      const checkCmd = process.platform === 'win32' ? 'where' : 'which';
      const env = EnvironmentManager.getSpawnEnv();

      const check = spawn(checkCmd, ['node'], { env });

      check.on('close', (code) => {
        if (code === 0) {
          const npmCheck = spawn(checkCmd, ['npm'], { env });

          npmCheck.on('close', (npmCode) => {
            resolve(npmCode === 0);
          });

          npmCheck.on('error', () => {
            resolve(false);
          });
        } else {
          resolve(false);
        }
      });

      check.on('error', () => {
        resolve(false);
      });
    });
  }

  async checkToolInstalled(toolId: ToolId): Promise<boolean> {
    const config = CLI_CONFIGS[toolId];
    return new Promise((resolve) => {
      const checkCmd = process.platform === 'win32' ? 'where' : 'which';
      const env = EnvironmentManager.getSpawnEnv();

      const check = spawn(checkCmd, [config.checkCmd], { env });

      check.on('close', (code) => {
        const isInstalled = code === 0;
        logger.debug('ToolInstaller', `Tool ${toolId} installed: ${isInstalled}`);
        resolve(isInstalled);
      });

      check.on('error', (error) => {
        logger.error('ToolInstaller', `Error checking tool ${toolId}`, error);
        resolve(false);
      });
    });
  }

  async installNodeAutomatically(): Promise<boolean> {
    const platform = process.platform;

    this.sendLog('system', 'Installing Node.js...');
    logger.info('ToolInstaller', 'Starting Node.js installation', { platform });

    try {
      if (platform === 'darwin') {
        const hasHomebrew = await new Promise<boolean>((resolve) => {
          const check = spawn('which', ['brew']);
          check.on('close', (code) => resolve(code === 0));
          check.on('error', () => resolve(false));
        });

        if (hasHomebrew) {
          return new Promise((resolve, reject) => {
            const install = spawn('brew', ['install', 'node'], {
              shell: true
            });

            install.stdout.on('data', (data) => {
              this.sendLog('system', data.toString());
            });

            install.on('close', (code) => {
              if (code === 0) {
                logger.info('ToolInstaller', 'Node.js installed successfully via Homebrew');
                resolve(true);
              } else {
                logger.error('ToolInstaller', 'Failed to install Node.js via Homebrew', { code });
                reject(new Error('Failed to install Node.js'));
              }
            });
          });
        }
      }

      this.sendLog('system', 'Please install Node.js manually from https://nodejs.org');
      const { shell } = require('electron');
      shell.openExternal('https://nodejs.org/en/download/');
      return false;
    } catch (error) {
      logger.error('ToolInstaller', 'Failed to install Node.js', error);
      return false;
    }
  }

  async installTool(toolId: ToolId): Promise<void> {
    const config = CLI_CONFIGS[toolId];

    logger.info('ToolInstaller', `Installing ${config.name}`, { toolId });

    let nodeInstalled = await this.checkNodeInstalled();

    if (!nodeInstalled) {
      this.sendLog(toolId, 'Node.js not found. Installing...');

      try {
        await this.installNodeAutomatically();
        await new Promise(r => setTimeout(r, 3000));
        nodeInstalled = await this.checkNodeInstalled();

        if (!nodeInstalled) {
          throw new Error('Node.js installation failed. Please install manually.');
        }
      } catch (error) {
        logger.error('ToolInstaller', 'Node.js installation failed', error);
        throw error;
      }
    }

    this.sendLog(toolId, `Installing ${config.name}...`);
    await this.installViaNode(toolId, config);
  }


  private async installViaNode(toolId: ToolId, config: typeof CLI_CONFIGS[ToolId]): Promise<void> {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = config.installCmd;
      const env = EnvironmentManager.getSpawnEnv();

      const install = spawn(cmd, args, {
        shell: true,
        env
      });

      install.stdout.on('data', (data) => {
        this.sendLog(toolId, data.toString());
      });

      install.stderr.on('data', (data) => {
        this.sendLog(toolId, data.toString());
      });

      install.on('close', (code) => {
        if (code === 0) {
          logger.info('ToolInstaller', `${config.name} installed successfully via npm`);
          this.sendLog(toolId, `${config.name} installed successfully!`);
          resolve();
        } else {
          logger.error('ToolInstaller', `Installation failed for ${toolId}`, { code });
          reject(new Error(`Installation failed with code ${code}`));
        }
      });
    });
  }

  private sendLog(toolId: ToolId | 'system', message: string): void {
    this.mainWindow.webContents.send('log', { toolId, message });
  }
}