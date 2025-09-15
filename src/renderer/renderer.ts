import { ToolId, ToolState, LogEntry, StatusUpdate, PrerequisiteStatus } from './types.js';

class RendererApp {
  private connectButtons: NodeListOf<HTMLButtonElement>;
  private disconnectButtons: NodeListOf<HTMLButtonElement>;
  private consoleOutput: HTMLElement | null;
  private debugSection: HTMLElement | null;
  private activityLog: HTMLElement | null;
  private toggleDebugBtn: HTMLElement | null;
  private toggleText: HTMLElement | null;
  private prerequisiteOverlay: HTMLElement | null;
  private prerequisiteMessage: HTMLElement | null;

  private toolStates: Record<ToolId, ToolState> = {
    codex: { connected: false, inProgress: false },
    gemini: { connected: false, inProgress: false },
    claude: { connected: false, inProgress: false }
  };

  constructor() {
    this.connectButtons = document.querySelectorAll('.connect-btn');
    this.disconnectButtons = document.querySelectorAll('.disconnect-btn');
    this.consoleOutput = document.getElementById('console-output');
    this.debugSection = document.querySelector('.debug-section');
    this.activityLog = document.getElementById('debug-console');
    this.toggleDebugBtn = document.getElementById('toggle-debug');
    this.toggleText = document.getElementById('toggle-text');
    this.prerequisiteOverlay = document.getElementById('prerequisite-overlay');
    this.prerequisiteMessage = document.getElementById('prerequisite-message');

    this.initializeEventListeners();
    this.initializeIPCHandlers();
    this.disableAllButtons(); // Disable buttons until prerequisites are ready
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

  private updateButtonState(toolId: ToolId, state: 'connecting' | 'connected' | 'error' | 'default'): void {
    const connectBtn = document.querySelector(`#connect-${toolId}`) as HTMLButtonElement;
    const disconnectBtn = document.querySelector(`#logout-${toolId}`) as HTMLButtonElement;
    const btnText = connectBtn?.querySelector('.btn-text') as HTMLElement;
    const spinner = connectBtn?.querySelector('.spinner') as HTMLElement;

    if (!connectBtn || !disconnectBtn) return;

    switch (state) {
      case 'connecting':
        connectBtn.disabled = true;
        if (btnText) btnText.textContent = 'Connecting...';
        if (spinner) spinner.style.display = 'block';
        connectBtn.classList.add('loading');
        disconnectBtn.style.display = 'none';
        break;

      case 'connected':
        connectBtn.style.display = 'none';
        disconnectBtn.style.display = 'flex';
        if (spinner) spinner.style.display = 'none';
        connectBtn.classList.remove('loading');
        this.updateStatus(toolId, 'completed', '✅ Connected successfully!');
        break;

      case 'error':
        connectBtn.disabled = false;
        if (btnText) btnText.textContent = 'Retry';
        if (spinner) spinner.style.display = 'none';
        connectBtn.classList.remove('loading');
        connectBtn.style.display = 'flex';
        disconnectBtn.style.display = 'none';
        break;

      default:
        connectBtn.disabled = false;
        if (btnText) btnText.textContent = 'Connect';
        if (spinner) spinner.style.display = 'none';
        connectBtn.classList.remove('loading');
        connectBtn.style.display = 'flex';
        disconnectBtn.style.display = 'none';
    }
  }

  private updateStatus(toolId: ToolId, status: StatusUpdate['status'], message: string): void {
    const statusIndicator = document.querySelector(`#status-${toolId}`) as HTMLElement;
    if (!statusIndicator) return;

    statusIndicator.classList.remove('checking', 'installing', 'authenticating', 'completed', 'error', 'extracting');

    if (status && status.trim() !== '') {
      statusIndicator.classList.add(status);
      statusIndicator.textContent = message;
      statusIndicator.style.display = 'block';
    } else {
      statusIndicator.textContent = '';
      statusIndicator.style.display = 'none';
    }

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
          this.addLogEntry(toolId, `Credentials extracted successfully:`);
          this.addLogEntry(toolId, JSON.stringify(result.credentials, null, 2));
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
    this.updateStatus(toolId, 'checking', 'Logging out...');

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
  }

  private handlePrerequisiteStatus(data: PrerequisiteStatus): void {
    const { status, message } = data;

    // Update overlay message
    if (this.prerequisiteMessage) {
      this.prerequisiteMessage.textContent = message;
    }

    if (status === 'checking') {
      this.addLogEntry('system', `📦 ${message}`);
    } else if (status === 'error') {
      this.addLogEntry('system', `❌ ${message}`, true);
      // Show error in overlay
      if (this.prerequisiteMessage) {
        this.prerequisiteMessage.style.color = 'var(--error)';
      }
    } else if (status === 'success') {
      this.addLogEntry('system', `✅ ${message}`);
    }
  }

  private hidePrerequisiteOverlay(): void {
    if (this.prerequisiteOverlay) {
      this.prerequisiteOverlay.classList.add('hidden');
      setTimeout(() => {
        if (this.prerequisiteOverlay) {
          this.prerequisiteOverlay.style.display = 'none';
        }
      }, 300);
    }
  }

  private disableAllButtons(): void {
    this.connectButtons.forEach(button => {
      button.disabled = true;
      const btnText = button.querySelector('.btn-text') as HTMLElement;
      if (btnText) btnText.textContent = 'Checking system...';
    });
  }

  private enableAllButtons(): void {
    this.connectButtons.forEach(button => {
      button.disabled = false;
      const btnText = button.querySelector('.btn-text') as HTMLElement;
      if (btnText) btnText.textContent = 'Connect';
    });
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