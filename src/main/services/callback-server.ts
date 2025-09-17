import express from 'express';
import { Server } from 'http';
import { BrowserWindow, ipcMain } from 'electron';
import { ToolId } from '../types';
import { CLI_CONFIGS } from '../config/cli-configs';
import { logger } from '../utils/logger';

export class CallbackServer {
  private activeServers: Map<ToolId, Server> = new Map();
  private mainWindow: BrowserWindow;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  async setupCallbackServer(toolId: ToolId): Promise<number> {
    const config = CLI_CONFIGS[toolId];

    return new Promise((resolve, reject) => {
      const app = express();

      const handleCallback = async (req: express.Request, res: express.Response) => {
        logger.debug('CallbackServer', `OAuth callback received for ${toolId}`, { url: req.url });

        // Send simple redirect page that closes automatically
        res.send(this.generateCloseHTML());

        // Notify the main app of successful authentication
        this.mainWindow.webContents.send('auth-completed', { toolId });
        ipcMain.emit(`auth-completed-${toolId}`, null, { toolId });

        // Show in-app success notification
        this.mainWindow.webContents.send('show-success-screen', {
          toolId,
          toolName: config.name
        });

        setTimeout(() => {
          const server = this.activeServers.get(toolId);
          if (server) {
            server.close(() => {
              logger.debug('CallbackServer', `Callback server for ${toolId} closed`);
              this.activeServers.delete(toolId);
            });
          }
        }, 2000);
      };

      app.get('/callback', handleCallback);
      app.get('/auth/callback', handleCallback);
      app.get('/', handleCallback);

      const server = app.listen(config.port, 'localhost', () => {
        logger.info('CallbackServer', `Callback server for ${toolId} listening on localhost:${config.port}`);
        this.activeServers.set(toolId, server);
        resolve(config.port);
      });

      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn('CallbackServer', `Port ${config.port} is in use, trying random port`);
          const fallbackServer = app.listen(0, 'localhost', () => {
            const port = (fallbackServer.address() as any).port;
            logger.info('CallbackServer', `Callback server for ${toolId} listening on localhost:${port} (fallback)`);
            this.activeServers.set(toolId, fallbackServer);
            resolve(port);
          });
        } else {
          logger.error('CallbackServer', `Failed to start callback server for ${toolId}`, err);
          reject(err);
        }
      });
    });
  }

  closeAll(): void {
    for (const [toolId, server] of this.activeServers) {
      server.close();
      logger.debug('CallbackServer', `Closed server for ${toolId}`);
    }
    this.activeServers.clear();
  }

  private generateCloseHTML(): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Authentication Complete</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
              background: #000000;
              color: #ffffff;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              margin: 0;
              text-align: center;
            }
            .container {
              padding: 40px;
            }
            h1 {
              font-size: 24px;
              margin-bottom: 16px;
              color: #667eea;
            }
            p {
              font-size: 16px;
              color: rgba(255, 255, 255, 0.7);
              margin-bottom: 24px;
            }
            .spinner {
              border: 2px solid rgba(255, 255, 255, 0.1);
              border-top: 2px solid #667eea;
              border-radius: 50%;
              width: 24px;
              height: 24px;
              animation: spin 1s linear infinite;
              margin: 0 auto;
            }
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✓ Authentication Complete</h1>
            <p>Please return to Blendle Connect.</p>
            <div class="spinner"></div>
          </div>
          <script>
            // Auto-close after 3 seconds
            setTimeout(() => {
              window.close();
            }, 3000);
          </script>
        </body>
      </html>
    `;
  }
}