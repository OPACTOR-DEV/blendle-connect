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

        res.send(this.generateSuccessHTML(config.name));

        this.mainWindow.webContents.send('auth-completed', { toolId });
        ipcMain.emit(`auth-completed-${toolId}`, null, { toolId });

        setTimeout(() => {
          const server = this.activeServers.get(toolId);
          if (server) {
            server.close(() => {
              logger.debug('CallbackServer', `Callback server for ${toolId} closed`);
              this.activeServers.delete(toolId);
            });
          }
        }, 5000);
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

  private generateSuccessHTML(toolName: string): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Authentication Complete - ${toolName}</title>
          <style>
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }

            body {
              font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
              background: #000000;
              min-height: 100vh;
              display: flex;
              justify-content: center;
              align-items: center;
              overflow: hidden;
              position: relative;
            }

            body::before {
              content: '';
              position: absolute;
              top: -50%;
              left: -50%;
              width: 200%;
              height: 200%;
              background: radial-gradient(circle at 20% 50%, rgba(120, 119, 198, 0.3), transparent 50%),
                          radial-gradient(circle at 80% 50%, rgba(255, 119, 168, 0.3), transparent 50%),
                          radial-gradient(circle at 40% 80%, rgba(120, 219, 255, 0.2), transparent 50%);
              animation: rotate 20s linear infinite;
            }

            @keyframes rotate {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }

            .container {
              background: rgba(20, 20, 20, 0.8);
              backdrop-filter: blur(20px);
              -webkit-backdrop-filter: blur(20px);
              border: 1px solid rgba(255, 255, 255, 0.1);
              padding: 60px;
              border-radius: 24px;
              text-align: center;
              position: relative;
              z-index: 1;
              max-width: 500px;
              box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5),
                         inset 0 1px 0 0 rgba(255, 255, 255, 0.1);
            }

            .success-icon {
              width: 80px;
              height: 80px;
              margin: 0 auto 30px;
              position: relative;
            }

            .circle {
              width: 80px;
              height: 80px;
              border-radius: 50%;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              display: flex;
              align-items: center;
              justify-content: center;
              animation: pulse 2s ease-in-out infinite;
            }

            @keyframes pulse {
              0%, 100% { transform: scale(1); opacity: 1; }
              50% { transform: scale(1.05); opacity: 0.9; }
            }

            .checkmark {
              width: 35px;
              height: 35px;
              stroke-width: 3;
              stroke: #fff;
              fill: none;
              stroke-dasharray: 100;
              stroke-dashoffset: 100;
              animation: checkmark 0.8s ease-out 0.3s forwards;
            }

            @keyframes checkmark {
              to { stroke-dashoffset: 0; }
            }

            h1 {
              color: #ffffff;
              font-size: 32px;
              font-weight: 600;
              margin-bottom: 16px;
              letter-spacing: -0.5px;
            }

            .tool-name {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              -webkit-background-clip: text;
              -webkit-text-fill-color: transparent;
              background-clip: text;
              font-weight: 700;
            }

            p {
              color: rgba(255, 255, 255, 0.7);
              font-size: 16px;
              line-height: 1.6;
              margin-bottom: 32px;
            }

            .status-badge {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              padding: 12px 24px;
              background: rgba(102, 126, 234, 0.1);
              border: 1px solid rgba(102, 126, 234, 0.3);
              border-radius: 100px;
              color: #667eea;
              font-size: 14px;
              font-weight: 500;
              margin-bottom: 24px;
            }

            .status-dot {
              width: 8px;
              height: 8px;
              background: #667eea;
              border-radius: 50%;
              animation: blink 2s ease-in-out infinite;
            }

            @keyframes blink {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.3; }
            }

            .close-hint {
              color: rgba(255, 255, 255, 0.4);
              font-size: 13px;
              margin-top: 32px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success-icon">
              <div class="circle">
                <svg class="checkmark" viewBox="0 0 52 52">
                  <path d="M14 27 L22 35 L38 16" />
                </svg>
              </div>
            </div>

            <h1>Authentication Complete</h1>

            <div class="status-badge">
              <span class="status-dot"></span>
              <span>Connected</span>
            </div>

            <p>
              <span class="tool-name">${toolName}</span> has been successfully authenticated.<br>
              You can now return to Blendle Connect.
            </p>

            <div class="close-hint">
              You can close this tab at any time
            </div>
          </div>
        </body>
      </html>
    `;
  }
}