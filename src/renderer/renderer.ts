import { ToolId, ToolState, LogEntry, StatusUpdate, PrerequisiteStatus } from './types.js';

class RendererApp {
  private connectButtons: NodeListOf<HTMLButtonElement>;
  private disconnectButtons: NodeListOf<HTMLButtonElement>;
  private copyButtons: NodeListOf<HTMLButtonElement>;
  private consoleOutput: HTMLElement | null;
  private debugSection: HTMLElement | null;
  private activityLog: HTMLElement | null;
  private toggleDebugBtn: HTMLElement | null;
  private toggleText: HTMLElement | null;

  private toolStates: Record<ToolId, ToolState> = {
    codex: { connected: false, inProgress: false },
    gemini: { connected: false, inProgress: false },
    claude: { connected: false, inProgress: false }
  };

  private storedCredentials: Record<ToolId, any> = {
    codex: null,
    gemini: null,
    claude: null
  };

  constructor() {
    this.connectButtons = document.querySelectorAll('.connect-btn');
    this.disconnectButtons = document.querySelectorAll('.disconnect-btn');
    this.copyButtons = document.querySelectorAll('.copy-btn');
    this.consoleOutput = document.getElementById('console-output');
    this.debugSection = document.querySelector('.debug-section');
    this.activityLog = document.getElementById('debug-console');
    this.toggleDebugBtn = document.getElementById('toggle-debug');
    this.toggleText = document.getElementById('toggle-text');

    this.initializeEventListeners();
    this.initializeIPCHandlers();
    // Check initial auth status immediately
    setTimeout(() => {
      this.checkInitialAuth();
    }, 500);
  }

  private formatTimestamp(): string {
    const now = new Date();
    return now.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  private addLogEntry(toolId: ToolId | 'system', message: string, isError: boolean = false): void {
    if (!this.consoleOutput) return;

    const entry = document.createElement('div');
    entry.className = `log-entry ${toolId} ${isError ? 'error' : ''}`;

    const timestamp = document.createElement('span');
    timestamp.className = 'log-timestamp';
    timestamp.textContent = `[${this.formatTimestamp()}]`;

    const content = document.createElement('span');
    content.textContent = message;

    entry.appendChild(timestamp);
    entry.appendChild(content);

    this.consoleOutput.appendChild(entry);
    this.consoleOutput.scrollTop = this.consoleOutput.scrollHeight;

    if (this.debugSection && !this.debugSection.classList.contains('expanded')) {
      this.debugSection.classList.add('expanded');
    }
  }

  private updateButtonState(toolId: ToolId, state: 'connecting' | 'connected' | 'error' | 'default' | 'disconnecting'): void {
    const connectBtn = document.querySelector(`#connect-${toolId}`) as HTMLButtonElement;
    const disconnectBtn = document.querySelector(`#logout-${toolId}`) as HTMLButtonElement;
    const card = document.querySelector(`#card-${toolId}`) as HTMLElement;
    const btnText = connectBtn;

    if (!connectBtn || !disconnectBtn) return;

    // Update card classes
    if (card) {
      card.classList.remove('connecting', 'connected', 'error', 'disconnecting');
      if (state === 'connecting') card.classList.add('connecting');
      if (state === 'connected') card.classList.add('connected');
      if (state === 'error') card.classList.add('error');
      if (state === 'disconnecting') card.classList.add('disconnecting');
    }

    switch (state) {
      case 'connecting':
        connectBtn.disabled = true;
        if (btnText) btnText.textContent = 'Connecting...';
        disconnectBtn.style.display = 'none';
        break;

      case 'disconnecting':
        connectBtn.style.display = 'none';
        disconnectBtn.style.display = 'block';
        disconnectBtn.disabled = true;
        disconnectBtn.textContent = 'Disconnecting...';
        break;

      case 'connected':
        connectBtn.style.display = 'none';
        disconnectBtn.style.display = 'block';
        disconnectBtn.disabled = false;
        disconnectBtn.textContent = 'Disconnect';
        break;

      case 'error':
        connectBtn.disabled = false;
        if (btnText) btnText.textContent = 'Retry';
        connectBtn.style.display = 'block';
        disconnectBtn.style.display = 'none';
        break;

      default:
        connectBtn.disabled = false;
        if (btnText) btnText.textContent = 'Connect';
        connectBtn.style.display = 'block';
        disconnectBtn.style.display = 'none';
    }
  }

  private updateStatus(toolId: ToolId, status: StatusUpdate['status'], message: string): void {
    // Status is now handled visually through card classes
    // Keep this method for compatibility but don't display text
    if (message && message.trim() !== '') {
      this.addLogEntry(toolId, message, status === 'error');
    }
  }

  private async connectTool(toolId: ToolId): Promise<void> {
    if (this.toolStates[toolId].connected || this.toolStates[toolId].inProgress) {
      return;
    }

    this.toolStates[toolId].inProgress = true;
    this.updateButtonState(toolId, 'connecting');

    try {
      this.addLogEntry(toolId, `Starting connection process...`);

      const result = await window.api.connectTool(toolId);

      if (result.success) {
        this.toolStates[toolId].connected = true;
        this.toolStates[toolId].inProgress = false;
        this.updateButtonState(toolId, 'connected');

        if (result.credentials) {
          this.storedCredentials[toolId] = result.credentials;
          this.addLogEntry(toolId, `Authentication successful!`);
          this.showCredentialInfo(toolId, result.credentials);
        }
      } else {
        throw new Error(result.error || 'Connection failed');
      }
    } catch (error: any) {
      this.toolStates[toolId].inProgress = false;
      this.updateButtonState(toolId, 'error');
      this.updateStatus(toolId, 'error', `Connection failed: ${error.message}`);
      this.addLogEntry(toolId, `Error: ${error.message}`, true);
    }
  }

  private async logoutTool(toolId: ToolId): Promise<void> {
    // Show disconnect in progress state
    this.updateButtonState(toolId, 'disconnecting');

    try {
      const result = await window.api.logoutTool(toolId);

      if (result.success) {
        this.toolStates[toolId].connected = false;
        this.updateButtonState(toolId, 'default');
        this.updateStatus(toolId, '', '');
        this.addLogEntry(toolId, result.message || 'Logged out successfully');
        this.addLogEntry('system', `${toolId} disconnected successfully`);
      } else {
        throw new Error(result.message || 'Logout failed');
      }
    } catch (error: any) {
      this.addLogEntry(toolId, `Logout error: ${error.message}`, true);
      this.updateStatus(toolId, 'error', `Logout failed`);
      // Restore the connected state if logout failed
      this.updateButtonState(toolId, 'connected');
      setTimeout(() => {
        this.updateStatus(toolId, '', '');
      }, 3000);
    }
  }

  private async checkInitialAuth(): Promise<void> {
    const tools: ToolId[] = ['codex', 'gemini', 'claude'];

    for (const toolId of tools) {
      const isInstalled = await window.api.checkTool(toolId);

      if (isInstalled) {
        const isAuthenticated = await window.api.checkAuthenticated(toolId);

        if (isAuthenticated) {
          this.toolStates[toolId].connected = true;
          this.updateButtonState(toolId, 'connected');
          this.addLogEntry('system', `${toolId} is already authenticated`);
        }
      }
    }
  }

  private initializeEventListeners(): void {
    this.connectButtons.forEach(button => {
      button.addEventListener('click', () => {
        const toolId = button.dataset.tool as ToolId;
        this.connectTool(toolId);
      });
    });

    this.disconnectButtons.forEach(button => {
      button.addEventListener('click', () => {
        const toolId = button.dataset.tool as ToolId;
        this.logoutTool(toolId);
      });
    });

    this.copyButtons.forEach(button => {
      button.addEventListener('click', async () => {
        const toolId = button.dataset.tool as ToolId;
        await this.copyCredentials(toolId);
      });
    });

    if (this.toggleDebugBtn && this.activityLog) {
      this.toggleDebugBtn.addEventListener('click', () => {
        this.activityLog!.classList.toggle('collapsed');
        const isCollapsed = this.activityLog!.classList.contains('collapsed');
        if (this.toggleText) {
          this.toggleText.textContent = isCollapsed ? 'Show Details' : 'Hide Details';
        }
        const svg = this.toggleDebugBtn!.querySelector('svg');
        if (svg) {
          svg.style.transform = isCollapsed ? 'rotate(0deg)' : 'rotate(180deg)';
        }
      });
    }
  }

  private initializeIPCHandlers(): void {
    window.api.onStatusUpdate((data: StatusUpdate) => {
      const { toolId, status, message } = data;
      this.updateStatus(toolId, status, message);
    });

    window.api.onLog((data: LogEntry) => {
      const { toolId, message } = data;
      this.addLogEntry(toolId, message);
    });

    window.api.onAuthCompleted((data: { toolId: ToolId }) => {
      const { toolId } = data;
      this.addLogEntry(toolId, 'Authentication completed successfully!');
    });

    window.api.onPrerequisiteStatus((data: PrerequisiteStatus) => {
      this.handlePrerequisiteStatus(data);
    });

    window.api.onPrerequisitesReady(() => {
      this.hidePrerequisiteOverlay();
      this.enableAllButtons();
      this.checkInitialAuth();
      this.addLogEntry('system', 'System prerequisites verified');
      this.addLogEntry('system', 'Ready to connect to AI CLI tools');
    });

    window.api.onToolConnected((data: { toolId: ToolId; credentials: any }) => {
      const { toolId, credentials } = data;
      this.storedCredentials[toolId] = credentials;
      this.showCredentialInfo(toolId, credentials);
    });

    window.api.onCredentialsStored((data: any) => {
      if (data.toolId && data.credentials) {
        const toolId = data.toolId as ToolId;
        this.storedCredentials[toolId] = data.credentials;
      }
    });
  }

  private handlePrerequisiteStatus(data: PrerequisiteStatus): void {
    const { status, message } = data;

    if (status === 'checking') {
      this.addLogEntry('system', `${message}`);
    } else if (status === 'error') {
      this.addLogEntry('system', `Error: ${message}`, true);
    } else if (status === 'success') {
      this.addLogEntry('system', `${message}`);
    }
  }

  private hidePrerequisiteOverlay(): void {
    // Overlay removed from UI, no-op
  }


  private enableAllButtons(): void {
    this.connectButtons.forEach(button => {
      const toolId = button.dataset.tool as ToolId;
      // Only enable if not already connected
      if (!this.toolStates[toolId]?.connected) {
        button.disabled = false;
        const btnText = button;
        if (btnText) btnText.textContent = 'Connect';
      }
    });
  }

  private async copyCredentials(toolId: ToolId): Promise<void> {
    try {
      const result = await window.api.copyCredentials(toolId);
      if (result.success) {
        this.addLogEntry(toolId, result.message || 'Credentials copied to clipboard');

        // Show a temporary notification with more detail
        const copyBtn = document.querySelector(`#copy-${toolId}`) as HTMLButtonElement;
        if (copyBtn) {
          const originalText = copyBtn.innerHTML;
          copyBtn.innerHTML = 'Copied!';
          copyBtn.classList.add('success');
          setTimeout(() => {
            copyBtn.innerHTML = originalText;
            copyBtn.classList.remove('success');
          }, 2000);
        }
      } else {
        this.addLogEntry(toolId, `❌ Copy failed: ${result.error}`, true);
      }
    } catch (error: any) {
      this.addLogEntry(toolId, `❌ Copy error: ${error.message}`, true);
    }
  }

  private showCredentialInfo(toolId: ToolId, credentials: any): void {
    if (!credentials) return;

    let info = '';
    if (toolId === 'claude') {
      if (credentials.storage === 'macOS Keychain') {
        info = '🔐 Credentials stored in macOS Keychain (click Copy Info to get credentials)';
      } else if (credentials.path) {
        info = `📁 Credentials ready at: ${credentials.path}`;
      }
    } else if (toolId === 'codex') {
      if (credentials.path) {
        info = `📁 Credentials ready at: ${credentials.path}`;
      }
    } else if (toolId === 'gemini') {
      if (credentials.oauth?.path) {
        info = `📁 OAuth credentials ready at: ${credentials.oauth.path}`;
      } else {
        info = '🔐 OAuth credentials ready';
      }
    }

    if (info) {
      this.addLogEntry(toolId, info);
      this.addLogEntry(toolId, '💡 Click "Copy Info" to copy full credentials to clipboard');
    }
  }

  async initialize(): Promise<void> {
    this.addLogEntry('system', 'Blendle Connect initialized');
    this.addLogEntry('system', 'Checking system prerequisites...');

    // Prerequisites will be checked automatically by main process
    // When ready, onPrerequisitesReady callback will be triggered
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const app = new RendererApp();
  await app.initialize();
});