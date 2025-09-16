import { BrowserWindow } from 'electron';
import { ToolId } from '../types';
import { logger } from '../utils/logger';

export class OAuthWindow {
  private authWindow: BrowserWindow | null = null;
  private callbackPort: number;
  private toolId: ToolId;
  private completed: boolean = false;

  constructor(toolId: ToolId, callbackPort: number) {
    this.toolId = toolId;
    this.callbackPort = callbackPort;
  }

  async open(authUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Create a new window for OAuth
      this.authWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: true
        },
        titleBarStyle: 'default',
        title: `Authenticate ${this.toolId}`
      });
      this.completed = false;

      // Handle navigation events to intercept OAuth callbacks
      this.authWindow.webContents.on('will-redirect', (_event, url) => {
        this.handleRedirect(url, resolve, reject);
      });

      this.authWindow.webContents.on('will-navigate', (_event, url) => {
        this.handleRedirect(url, resolve, reject);
      });

      // Also check when the page finishes loading
      this.authWindow.webContents.on('did-navigate', (_event, url) => {
        this.handleRedirect(url, resolve, reject);
      });

      // For Claude's specific redirect pattern
      if (this.toolId === 'claude') {
        // Claude uses console.anthropic.com/download-complete
        this.authWindow.webContents.on('did-navigate-in-page', (_event, url) => {
          if (this.completed) {
            return;
          }
          if (url.includes('download-complete') || url.includes('success')) {
            logger.info('OAuthWindow', `Claude authentication detected: ${url}`);
            this.redirectToLocalhost(url, resolve);
          }
        });
      }

      this.authWindow.on('closed', () => {
        this.authWindow = null;
        resolve(); // Resolve even if window is closed
      });

      // Load the auth URL
      this.authWindow.loadURL(authUrl);
    });
  }

  private handleRedirect(url: string, resolve: () => void, reject: (error: Error) => void): void {
    logger.debug('OAuthWindow', `Navigating to: ${url}`);

    if (this.completed) {
      return;
    }

    const lowerUrl = url.toLowerCase();

    // Tool-specific success patterns
    const toolSpecificSuccess: Record<ToolId, RegExp[]> = {
      claude: [
        /console\.anthropic\.com\/oauth\/code\/success/i,
        /download-complete/i
      ],
      gemini: [
        /developers\.google\.com\/gemini-code-assist\/auth\/auth_success/i,
        /approval/i
      ],
      codex: []
    };

    const genericSuccessPatterns = [
      /code=/i,
      /success/i,
      /authenticated/i
    ];

    const matchesToolSpecific = toolSpecificSuccess[this.toolId].some(pattern => pattern.test(url));
    const matchesGeneric = genericSuccessPatterns.some(pattern => pattern.test(url));

    if (matchesToolSpecific || matchesGeneric) {
      logger.info('OAuthWindow', `Authentication success detected for ${this.toolId}`);
      this.completed = true;

      // Extract any authorization code if present
      const codeMatch = url.match(/[?&]code=([^&]+)/);
      if (codeMatch) {
        this.sendCodeToLocalhost(codeMatch[1], resolve);
      } else {
        this.redirectToLocalhost(url, resolve);
      }
    }

    // Check for error indicators
    if (lowerUrl.includes('error') || lowerUrl.includes('denied')) {
      logger.error('OAuthWindow', `Authentication error for ${this.toolId}: ${url}`);
      if (this.authWindow) {
        this.authWindow.close();
      }
      reject(new Error('Authentication was denied or failed'));
    }
  }

  private redirectToLocalhost(_originalUrl: string, resolve: () => void): void {
    if (!this.authWindow) return;

    // Create a success page on localhost
    const successUrl = `http://localhost:${this.callbackPort}/auth/callback?success=true&tool=${this.toolId}`;

    logger.info('OAuthWindow', `Redirecting to localhost callback: ${successUrl}`);

    // Load our success page
    this.authWindow.loadURL(successUrl);

    // Close the window after a short delay
    setTimeout(() => {
      if (this.authWindow) {
        this.authWindow.close();
      }
      resolve();
    }, 2000);
  }

  private sendCodeToLocalhost(code: string, resolve: () => void): void {
    if (!this.authWindow) return;

    // Send the authorization code to our localhost callback
    const callbackUrl = `http://localhost:${this.callbackPort}/auth/callback?code=${code}&tool=${this.toolId}`;

    logger.info('OAuthWindow', `Sending code to localhost: ${callbackUrl}`);

    // Make a request to our callback server
    this.authWindow.loadURL(callbackUrl);

    // Close the window after a short delay
    setTimeout(() => {
      if (this.authWindow) {
        this.authWindow.close();
      }
      resolve();
    }, 2000);
  }

  close(): void {
    if (this.authWindow) {
      this.authWindow.close();
      this.authWindow = null;
    }
  }
}
