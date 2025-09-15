import { spawn, execSync } from 'child_process';
import { BrowserWindow } from 'electron';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../utils/logger';

export class PrerequisiteChecker {
  private mainWindow: BrowserWindow;
  private nodeVersion = 'v20.10.0'; // LTS version

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  async checkAndInstallPrerequisites(): Promise<boolean> {
    try {
      logger.info('PrerequisiteChecker', 'Checking system prerequisites...');
      this.sendStatus('Checking system requirements...');

      // Check if Node.js is installed
      const nodeInstalled = await this.checkNodeInstalled();

      if (!nodeInstalled) {
        logger.info('PrerequisiteChecker', 'Node.js not found, installing...');
        this.sendStatus('Installing Node.js...');

        const success = await this.installNode();
        if (!success) {
          this.sendError('Failed to install Node.js. Please install it manually from nodejs.org');
          return false;
        }
      } else {
        logger.info('PrerequisiteChecker', 'Node.js is already installed');
      }

      // Verify npm is available
      const npmAvailable = await this.checkNpmInstalled();
      if (!npmAvailable) {
        this.sendError('npm is not available. Please reinstall Node.js from nodejs.org');
        return false;
      }

      this.sendStatus('All prerequisites are installed');
      logger.info('PrerequisiteChecker', 'All prerequisites verified');
      return true;

    } catch (error: any) {
      logger.error('PrerequisiteChecker', 'Error checking prerequisites', error);
      this.sendError(`Error checking prerequisites: ${error.message}`);
      return false;
    }
  }

  private async checkNodeInstalled(): Promise<boolean> {
    try {
      execSync('node --version', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private async checkNpmInstalled(): Promise<boolean> {
    try {
      execSync('npm --version', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private async installNode(): Promise<boolean> {
    const platform = process.platform;

    try {
      if (platform === 'darwin') {
        return await this.installNodeMac();
      } else if (platform === 'win32') {
        return await this.installNodeWindows();
      } else if (platform === 'linux') {
        return await this.installNodeLinux();
      } else {
        logger.error('PrerequisiteChecker', `Unsupported platform: ${platform}`);
        return false;
      }
    } catch (error: any) {
      logger.error('PrerequisiteChecker', 'Failed to install Node.js', error);
      return false;
    }
  }

  private async installNodeMac(): Promise<boolean> {
    // Check if Homebrew is installed
    const hasHomebrew = await this.checkCommand('brew --version');

    if (hasHomebrew) {
      this.sendStatus('Installing Node.js via Homebrew...');
      return await this.runInstallCommand('brew install node');
    }

    // Try to install via curl
    this.sendStatus('Downloading Node.js installer...');
    const installerUrl = `https://nodejs.org/dist/${this.nodeVersion}/node-${this.nodeVersion}.pkg`;
    const installerPath = path.join(os.tmpdir(), 'node-installer.pkg');

    try {
      // Download installer
      execSync(`curl -L -o "${installerPath}" "${installerUrl}"`, { stdio: 'pipe' });

      // Run installer
      this.sendStatus('Running Node.js installer (may require admin password)...');
      execSync(`open "${installerPath}"`, { stdio: 'pipe' });

      // Wait for user to complete installation
      this.sendStatus('Please complete the Node.js installation in the opened installer');

      // Poll for Node.js installation
      return await this.waitForNodeInstallation();
    } catch (error: any) {
      logger.error('PrerequisiteChecker', 'Failed to install Node.js on macOS', error);
      return false;
    }
  }

  private async installNodeWindows(): Promise<boolean> {
    this.sendStatus('Downloading Node.js installer for Windows...');

    const arch = os.arch() === 'x64' ? 'x64' : 'x86';
    const installerUrl = `https://nodejs.org/dist/${this.nodeVersion}/node-${this.nodeVersion}-${arch}.msi`;
    const installerPath = path.join(os.tmpdir(), 'node-installer.msi');

    try {
      // Download using PowerShell
      execSync(
        `powershell -Command "Invoke-WebRequest -Uri '${installerUrl}' -OutFile '${installerPath}'"`,
        { stdio: 'pipe' }
      );

      // Run installer
      this.sendStatus('Running Node.js installer (may require admin permission)...');
      execSync(`msiexec /i "${installerPath}" /qn`, { stdio: 'pipe' });

      // Add Node to PATH
      const nodePath = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs');
      process.env.PATH = `${nodePath};${process.env.PATH}`;

      return await this.waitForNodeInstallation();
    } catch (error: any) {
      logger.error('PrerequisiteChecker', 'Failed to install Node.js on Windows', error);
      return false;
    }
  }

  private async installNodeLinux(): Promise<boolean> {
    // Try different package managers
    const packageManagers = [
      { check: 'apt-get --version', install: 'sudo apt-get update && sudo apt-get install -y nodejs npm' },
      { check: 'yum --version', install: 'sudo yum install -y nodejs npm' },
      { check: 'dnf --version', install: 'sudo dnf install -y nodejs npm' },
      { check: 'pacman --version', install: 'sudo pacman -S --noconfirm nodejs npm' },
      { check: 'zypper --version', install: 'sudo zypper install -y nodejs npm' }
    ];

    for (const pm of packageManagers) {
      const hasPackageManager = await this.checkCommand(pm.check);
      if (hasPackageManager) {
        this.sendStatus('Installing Node.js via system package manager...');
        const success = await this.runInstallCommand(pm.install);
        if (success) return true;
      }
    }

    // Fallback to NodeSource repository
    this.sendStatus('Installing Node.js from NodeSource repository...');
    try {
      execSync('curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -', { stdio: 'pipe' });
      execSync('sudo apt-get install -y nodejs', { stdio: 'pipe' });
      return await this.checkNodeInstalled();
    } catch {
      return false;
    }
  }

  private async checkCommand(command: string): Promise<boolean> {
    try {
      execSync(command, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private async runInstallCommand(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const install = spawn('sh', ['-c', command], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      install.stdout?.on('data', (data) => {
        const output = data.toString();
        logger.debug('PrerequisiteChecker', output);
      });

      install.stderr?.on('data', (data) => {
        const error = data.toString();
        logger.error('PrerequisiteChecker', error);
      });

      install.on('close', (code) => {
        resolve(code === 0);
      });

      install.on('error', () => {
        resolve(false);
      });
    });
  }

  private async waitForNodeInstallation(maxAttempts = 60): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      if (await this.checkNodeInstalled()) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return false;
  }

  private sendStatus(message: string): void {
    this.mainWindow.webContents.send('prerequisite-status', {
      status: 'checking',
      message
    });
  }

  private sendError(message: string): void {
    this.mainWindow.webContents.send('prerequisite-status', {
      status: 'error',
      message
    });
  }
}