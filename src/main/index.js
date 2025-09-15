const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const express = require('express');
const https = require('https');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');
const axios = require('axios');

let mainWindow;
let activeServers = new Map();

// Minimal console noise by default; enable with BLENDLE_DEBUG=1
const BLENDLE_DEBUG = process.env.BLENDLE_DEBUG === '1';
function debugLog(...args) {
  if (BLENDLE_DEBUG) console.log(...args);
}

// Enforce account-based OAuth across tools (no API keys / cloud flags)
function sanitizeEnvForOAuth(enhancedPath) {
  const env = { ...process.env };
  const unsetVars = [
    // Generic
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    // Google/Gemini variants
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_GCA',
    // Browser suppression variables
    'NO_BROWSER',
    'DEBIAN_FRONTEND',
    // CI and env hints that suppress browser
    'CI'
  ];

  for (const key of unsetVars) {
    if (key in env) delete env[key];
  }

  env.PATH = enhancedPath || env.PATH;
  // If BROWSER is set to a known non-GUI shim, unset it
  if (env.BROWSER === 'www-browser') delete env.BROWSER;
  return env;
}

// PTY-free: no native modules; we rely on regular spawn with stdin piping

async function ensureGeminiOAuthSelected() {
  try {
    const geminiDir = path.join(os.homedir(), '.gemini');
    await fsPromises.mkdir(geminiDir, { recursive: true });
    const settingsPath = path.join(geminiDir, 'settings.json');

    let settings = {};
    try {
      const raw = await fsPromises.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(raw);
    } catch (_) {
      // no settings yet
    }

    // Ensure correct key path used by gemini-cli:
    // security.auth.selectedType = 'oauth-personal'
    settings.security = settings.security || {};
    settings.security.auth = settings.security.auth || {};
    settings.security.auth.selectedType = 'oauth-personal';
    // clear enforcedType/useExternal unless explicitly set
    if (settings.security.auth.enforcedType && settings.security.auth.enforcedType !== 'oauth-personal') {
      delete settings.security.auth.enforcedType;
    }
    if (settings.security.auth.useExternal !== undefined) {
      // leave as-is; not necessary to change
    }

    // Also set legacy shortcut key to help older versions migrate
    settings.selectedAuthType = 'oauth-personal';

    await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.warn('Failed to ensure Gemini OAuth selection:', e.message);
    return false;
  }
}

const CLI_CONFIGS = {
  codex: {
    name: 'Codex CLI',
    installCmd: ['npm', 'install', '-g', '@openai/codex'],
    checkCmd: 'codex',
    loginCmd: ['codex', 'login'],  // codex login 유지
    authPath: path.join(os.homedir(), '.codex', 'auth.json'),
    configPath: path.join(os.homedir(), '.codex', 'config.toml'),
    port: 1455,
    description: 'OpenAI\'s lightweight coding agent',
    requiresInteractive: true
  },
  claude: {
    name: 'Claude Code',
    installCmd: ['npm', 'install', '-g', '@anthropic-ai/claude-code'],
    checkCmd: 'claude',
    loginCmd: ['claude'],  // claude 실행 후 /login 명령 사용
    authPath: null,  // OS 보안 저장소 사용 (Keychain/Secret Service/Credential Manager)
    port: 1456,
    description: 'Anthropic\'s Claude Code CLI',
    requiresInteractive: true,
    useSlashCommand: true,  // /login 슬래시 명령 사용
    altInstallCmd: {
      darwin: ['curl', '-fsS', 'https://claude.ai/install', '|', 'bash'],
      linux: ['curl', '-fsS', 'https://claude.ai/install', '|', 'bash'],
      win32: null
    }
  },
  gemini: {
    name: 'Gemini CLI',
    installCmd: ['npm', 'install', '-g', '@google/gemini-cli'],
    checkCmd: 'gemini',
    loginCmd: ['gemini'],  // gemini 실행 시 인터랙티브 프롬프트에서 선택
    authPath: null,  // 로컬 캐시 (플랫폼별 위치)
    port: 1457,
    description: 'Google\'s Gemini CLI with 1M token context',
    requiresInteractive: true,
    interactiveLogin: true  // 첫 실행 시 인터랙티브 메뉴에서 "Login with Google" 선택
  }
};

function getEnhancedPath() {
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  const existingPath = process.env.PATH || '';

  const additionalPaths = [
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    path.join(os.homedir(), '.nvm/versions/node/v22.17.0/bin'),
    path.join(os.homedir(), '.nvm/versions/node/v20.18.0/bin'),
    path.join(os.homedir(), '.volta/bin'),
    path.join(os.homedir(), '.fnm/aliases/default/bin'),
    process.platform === 'win32' ? 'C:\\Program Files\\nodejs' : '',
    process.platform === 'win32' ? path.join(process.env.APPDATA, 'npm') : ''
  ].filter(p => p);

  const allPaths = [...new Set([...additionalPaths, ...existingPath.split(pathSeparator)])];
  return allPaths.join(pathSeparator);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1b26',
    icon: path.join(__dirname, '../../assets/icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    for (let [key, server] of activeServers) {
      server.close();
    }
    activeServers.clear();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

async function checkToolInstalled(toolId) {
  const config = CLI_CONFIGS[toolId];
  return new Promise((resolve) => {
    const checkCmd = process.platform === 'win32' ? 'where' : 'which';
    const enhancedPath = getEnhancedPath();

    const check = spawn(checkCmd, [config.checkCmd], {
      env: sanitizeEnvForOAuth(enhancedPath)
    });

    check.on('close', (code) => {
      resolve(code === 0);
    });

    check.on('error', () => {
      resolve(false);
    });
  });
}

async function checkNodeInstalled() {
  return new Promise((resolve) => {
    const checkCmd = process.platform === 'win32' ? 'where' : 'which';
    const enhancedPath = getEnhancedPath();

    const check = spawn(checkCmd, ['node'], {
      env: sanitizeEnvForOAuth(enhancedPath)
    });

    check.on('close', (code) => {
      if (code === 0) {
        const npmCheck = spawn(checkCmd, ['npm'], {
          env: sanitizeEnvForOAuth(enhancedPath)
        });

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

async function installNodeAutomatically() {
  const platform = process.platform;

  mainWindow.webContents.send('log', {
    toolId: 'system',
    message: 'Installing Node.js...'
  });

  try {
    if (platform === 'darwin') {
      const hasHomebrew = await new Promise((resolve) => {
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
            mainWindow.webContents.send('log', {
              toolId: 'system',
              message: data.toString()
            });
          });

          install.on('close', (code) => {
            if (code === 0) {
              resolve(true);
            } else {
              reject(new Error('Failed to install Node.js'));
            }
          });
        });
      }
    }

    mainWindow.webContents.send('log', {
      toolId: 'system',
      message: 'Please install Node.js manually from https://nodejs.org'
    });
    shell.openExternal('https://nodejs.org/en/download/');
    return false;
  } catch (error) {
    console.error('Failed to install Node.js:', error);
    return false;
  }
}

async function installTool(toolId) {
  const config = CLI_CONFIGS[toolId];

  return new Promise(async (resolve, reject) => {
    let nodeInstalled = await checkNodeInstalled();

    if (!nodeInstalled) {
      mainWindow.webContents.send('log', {
        toolId,
        message: 'Node.js not found. Installing...'
      });

      try {
        await installNodeAutomatically();
        await new Promise(r => setTimeout(r, 3000));
        nodeInstalled = await checkNodeInstalled();

        if (!nodeInstalled) {
          reject(new Error('Node.js installation failed. Please install manually.'));
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
    }

    mainWindow.webContents.send('log', {
      toolId,
      message: `Installing ${config.name}...`
    });

    const enhancedPath = getEnhancedPath();

    // Try alternative install method for Claude Code
    if (toolId === 'claude' && config.altInstallCmd && config.altInstallCmd[process.platform]) {
      const altCmd = config.altInstallCmd[process.platform];
      const install = spawn(altCmd[0], altCmd.slice(1), {
        shell: true,
        env: sanitizeEnvForOAuth(enhancedPath)
      });

      install.stdout.on('data', (data) => {
        mainWindow.webContents.send('log', { toolId, message: data.toString() });
      });

      install.stderr.on('data', (data) => {
        mainWindow.webContents.send('log', { toolId, message: data.toString() });
      });

      install.on('close', (code) => {
        if (code === 0) {
          mainWindow.webContents.send('log', {
            toolId,
            message: `${config.name} installed successfully!`
          });
          resolve();
        } else {
          // Fallback to npm install
          installViaNode();
        }
      });
    } else {
      installViaNode();
    }

    function installViaNode() {
      const [cmd, ...args] = config.installCmd;
      const install = spawn(cmd, args, {
        shell: true,
        env: sanitizeEnvForOAuth(enhancedPath)
      });

      install.stdout.on('data', (data) => {
        mainWindow.webContents.send('log', { toolId, message: data.toString() });
      });

      install.stderr.on('data', (data) => {
        mainWindow.webContents.send('log', { toolId, message: data.toString() });
      });

      install.on('close', (code) => {
        if (code === 0) {
          mainWindow.webContents.send('log', {
            toolId,
            message: `${config.name} installed successfully!`
          });
          resolve();
        } else {
          reject(new Error(`Installation failed with code ${code}`));
        }
      });
    }
  });
}

function setupCallbackServer(toolId) {
  const config = CLI_CONFIGS[toolId];

  return new Promise((resolve, reject) => {
    const app = express();

    const handleCallback = async (req, res) => {
      debugLog(`OAuth callback received for ${toolId}:`, req.url);

      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>Authentication Complete - ${config.name}</title>
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

              /* Animated gradient background */
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

              /* Floating particles */
              .particles {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                overflow: hidden;
                z-index: 0;
              }

              .particle {
                position: absolute;
                width: 4px;
                height: 4px;
                background: rgba(255, 255, 255, 0.5);
                border-radius: 50%;
                animation: float 15s infinite linear;
              }

              @keyframes float {
                from {
                  transform: translateY(100vh) translateX(0);
                  opacity: 0;
                }
                10% {
                  opacity: 1;
                }
                90% {
                  opacity: 1;
                }
                to {
                  transform: translateY(-100vh) translateX(100px);
                  opacity: 0;
                }
              }

              .particle:nth-child(2n) { left: 10%; animation-delay: 1s; animation-duration: 13s; }
              .particle:nth-child(3n) { left: 20%; animation-delay: 2s; animation-duration: 17s; }
              .particle:nth-child(4n) { left: 30%; animation-delay: 3s; animation-duration: 14s; }
              .particle:nth-child(5n) { left: 40%; animation-delay: 4s; animation-duration: 16s; }
              .particle:nth-child(6n) { left: 50%; animation-delay: 5s; animation-duration: 12s; }
              .particle:nth-child(7n) { left: 60%; animation-delay: 6s; animation-duration: 18s; }
              .particle:nth-child(8n) { left: 70%; animation-delay: 7s; animation-duration: 15s; }
              .particle:nth-child(9n) { left: 80%; animation-delay: 8s; animation-duration: 13s; }
              .particle:nth-child(10n) { left: 90%; animation-delay: 9s; animation-duration: 19s; }
            </style>
          </head>
          <body>
            <div class="particles">
              <div class="particle"></div>
              <div class="particle"></div>
              <div class="particle"></div>
              <div class="particle"></div>
              <div class="particle"></div>
              <div class="particle"></div>
              <div class="particle"></div>
              <div class="particle"></div>
              <div class="particle"></div>
              <div class="particle"></div>
            </div>

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
                <span class="tool-name">${config.name}</span> has been successfully authenticated.<br>
                You can now return to Blendle Connect.
              </p>

              <div class="close-hint">
                You can close this tab at any time
              </div>
            </div>
          </body>
        </html>
      `);

      // Send event to renderer
      mainWindow.webContents.send('auth-completed', { toolId });

      // Also emit internal event for the login process
      ipcMain.emit(`auth-completed-${toolId}`, null, { toolId });

      setTimeout(() => {
        const server = activeServers.get(toolId);
        if (server) {
          server.close(() => {
            debugLog(`Callback server for ${toolId} closed`);
            activeServers.delete(toolId);
          });
        }
      }, 5000);
    };

    app.get('/callback', handleCallback);
    app.get('/auth/callback', handleCallback);
    app.get('/', handleCallback);

    const server = app.listen(config.port, 'localhost', () => {
      debugLog(`Callback server for ${toolId} listening on localhost:${config.port}`);
      activeServers.set(toolId, server);
      resolve(config.port);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        debugLog(`Port ${config.port} is in use, trying random port...`);
        const server = app.listen(0, 'localhost', () => {
          const port = server.address().port;
          debugLog(`Callback server for ${toolId} listening on localhost:${port} (fallback)`);
          activeServers.set(toolId, server);
          resolve(port);
        });
      } else {
        reject(err);
      }
    });
  });
}

async function performLogin(toolId) {
  const config = CLI_CONFIGS[toolId];

  return new Promise(async (resolve, reject) => {
    try {
      mainWindow.webContents.send('log', {
        toolId,
        message: `Starting ${config.name} login process...`
      });

      const callbackPort = await setupCallbackServer(toolId);
      await new Promise(r => setTimeout(r, 500));

      const enhancedPath = getEnhancedPath();

      // Special handling for Gemini - enforce OAuth and delete credentials
      if (toolId === 'gemini') {
        debugLog('Gemini re-authentication: clearing credentials');

        // Delete Gemini credentials
        const geminiConfigPath = path.join(os.homedir(), '.gemini');
        try {
          // Delete oauth_creds.json if exists
          const oauthCredsPath = path.join(geminiConfigPath, 'oauth_creds.json');
          if (fs.existsSync(oauthCredsPath)) {
            fs.unlinkSync(oauthCredsPath);
            debugLog('Deleted Gemini OAuth credentials');
            mainWindow.webContents.send('log', {
              toolId,
              message: 'Cleared Gemini OAuth credentials'
            });
          }

          // Also clear google_accounts.json if exists
          const googleAccountsPath = path.join(geminiConfigPath, 'google_accounts.json');
          if (fs.existsSync(googleAccountsPath)) {
            fs.unlinkSync(googleAccountsPath);
            debugLog('Deleted Gemini Google accounts cache');
          }
        } catch (err) {
          console.error('Error clearing Gemini credentials:', err);
        }

        // Ensure Gemini auth method is set to OAuth to avoid 'set Auth method' error
        await ensureGeminiOAuthSelected();

        // Non-PTY path: run non-interactively with a dummy prompt so CLI stays alive
        const login = spawn('gemini', ['--prompt', 'Authenticate'], {
          env: sanitizeEnvForOAuth(enhancedPath),
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let authCompleted = false;
        let resolved = false;
        let sentAuthCommand = false;
        // Poll for OAuth credentials being written by the CLI
        const credPoll = setInterval(() => {
          try {
            const credPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
            if (fs.existsSync(credPath)) {
              authCompleted = true;
              clearInterval(credPoll);
              mainWindow.webContents.send('log', { toolId, message: 'Detected Gemini OAuth credentials on disk' });
              // Finish early once creds are present, but do NOT kill the CLI
              // to allow the browser redirect to localhost to succeed.
              if (!resolved) {
                resolved = true;
                return resolve();
              }
            }
          } catch (_) {}
        }, 500);

        const loginTimeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            clearInterval(credPoll);
            try { if (login) login.kill(); } catch (_) {}
            reject(new Error('Login process timed out'));
          }
        }, 2 * 60 * 1000); // 2 minutes timeout

        const handleOutput = (data) => {
          const output = data.toString();
          debugLog(`Gemini output:`, output);

          // Filter noise: only forward meaningful auth lines to UI
          const meaningfulPatterns = [
            /Code Assist login required/i,
            /open authentication page/i,
            /Waiting for authentication/i,
            /Loaded cached credentials/i,
            /already authenticated/i,
            /authenticated/i,
            /logged in/i,
            /(https?:\/\/[^\s]+)/i
          ];
          const isMeaningful = meaningfulPatterns.some((re) => re.test(output));
          if (!isMeaningful) {
            return; // suppress verbose agent chatter
          }

          // Only now forward meaningful lines to UI
          mainWindow.webContents.send('log', { toolId, message: output });

          // Check for auth URL or success patterns
          const urlMatch = output.match(/(https?:\/\/[^\s\)]+)/);
          if (urlMatch) {
            const authUrl = urlMatch[1];
            debugLog(`Found Gemini auth URL: ${authUrl}`);
            mainWindow.webContents.send('log', {
              toolId,
              message: 'Opening authentication page in browser...'
            });
            shell.openExternal(authUrl);
          }

          // Check for success
          if (output.toLowerCase().includes('authenticated') ||
              output.toLowerCase().includes('logged in') ||
              output.toLowerCase().includes('success')) {
            authCompleted = true;
            if (!resolved) {
              resolved = true;
              return resolve();
            }
          }
        };

        login.stdout.on('data', handleOutput);
        login.stderr.on('data', (data) => {
          const output = data.toString();
          if (output.trim()) mainWindow.webContents.send('log', { toolId, message: output });
        });

        login.on('close', (code) => {
          clearTimeout(loginTimeout);
          clearInterval(credPoll);
          if (!resolved) {
            resolved = true;
            if (code === 0 || authCompleted) {
              resolve();
            } else {
              reject(new Error(`Login process failed with code ${code}`));
            }
          }
        });

        return; // Exit early for Gemini
      }

      // Regular flow for other tools
      const [cmd, ...args] = config.loginCmd;

      // Non-PTY unified flow for Codex/Claude
      let login;
      const spawnOptions = {
        env: { ...sanitizeEnvForOAuth(enhancedPath), TERM: 'xterm-256color', FORCE_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe']
      };

      // For Codex, first logout then login
      if (toolId === 'codex') {
          debugLog('Codex re-authentication: logout first');

          // First run codex logout
          const logoutProcess = spawn('codex', ['logout'], {
            env: sanitizeEnvForOAuth(enhancedPath),
            stdio: ['pipe', 'pipe', 'pipe']
          });

          let logoutCompleted = false;

          logoutProcess.on('close', (code) => {
            if (!logoutCompleted) {
              logoutCompleted = true;
              debugLog(`Codex logout completed with code ${code}`);
              mainWindow.webContents.send('log', {
                toolId,
                message: 'Logged out from Codex, starting fresh login...'
              });

              // Now start codex for login
              login = spawn(cmd, args, spawnOptions);
              setupCodexLogin();
            }
          });

          logoutProcess.on('error', (err) => {
            if (!logoutCompleted) {
              logoutCompleted = true;
              console.error('Codex logout error:', err);
              // Continue with login anyway
              login = spawn(cmd, args, spawnOptions);
              setupCodexLogin();
            }
          });

          // Wait for logout to complete before continuing
          const setupCodexLogin = () => {
            // Continue with the rest of the login flow
            let authUrl = null;
            let authCompleted = false;
            let resolved = false;

            // Store reference to auth completion from callback server
            const authCompletedHandler = (event, data) => {
              if (data.toolId === toolId) {
                debugLog(`Auth completed signal received for ${toolId}`);
                authCompleted = true;
              }
            };

            // Listen for auth completion from callback server
            ipcMain.once(`auth-completed-${toolId}`, authCompletedHandler);

            const loginTimeout = setTimeout(() => {
              if (!resolved) {
                resolved = true;
                ipcMain.removeListener(`auth-completed-${toolId}`, authCompletedHandler);
                login.kill();
                reject(new Error('Login process timed out'));
              }
            }, 5 * 60 * 1000);

            const handleOutput = (data) => {
              const output = data.toString();
              const cleanOutput = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                                        .replace(/\[[\?>][0-9]+[a-z]/g, '')
                                        .replace(/\[\d+[A-Z]/g, '');

              debugLog(`${toolId} output:`, cleanOutput);

              if (cleanOutput.trim()) {
                mainWindow.webContents.send('log', { toolId, message: cleanOutput });
              }

              const urlPatterns = [
                /(https?:\/\/[^\s\)\]]+)/g,
                /Open.*browser.*?(https?:\/\/[^\s]+)/i,
                /Visit.*?(https?:\/\/[^\s]+)/i,
                /Navigate to.*?(https?:\/\/[^\s]+)/i
              ];

              for (const pattern of urlPatterns) {
                const matches = output.match(pattern);
                if (matches && matches.length > 0 && !authUrl) {
                  authUrl = matches[matches.length - 1].replace(/[)\]'"]*$/, '');
                  debugLog(`Found auth URL for ${toolId}:`, authUrl);
                  mainWindow.webContents.send('log', {
                    toolId,
                    message: 'Opening authentication page in browser...'
                  });

                  setTimeout(() => {
                    if (!authCompleted) {
                      shell.openExternal(authUrl);
                    }
                  }, 2000);
                  break;
                }
              }

              const successPatterns = [
                'success',
                'login successful',
                'authenticated successfully',
                'login completed',
                'loaded cached credentials',
                'already authenticated',
                'credentials loaded'
              ];

              if (successPatterns.some(pattern => cleanOutput.toLowerCase().includes(pattern))) {
                authCompleted = true;
                debugLog(`Authentication success detected for ${toolId}: ${cleanOutput}`);
              }
            };

            login.stdout.on('data', handleOutput);
            login.stderr.on('data', (data) => {
              const output = data.toString();
              mainWindow.webContents.send('log', { toolId, message: output });

              if (output.toLowerCase().includes('success') ||
                  output.toLowerCase().includes('authenticated')) {
                authCompleted = true;
              }
            });

            const checkAuth = setInterval(async () => {
              if (authCompleted && !resolved) {
                resolved = true;
                clearInterval(checkAuth);
                clearTimeout(loginTimeout);
                ipcMain.removeListener(`auth-completed-${toolId}`, authCompletedHandler);

                setTimeout(() => {
                  login.kill('SIGTERM');
                  resolve();
                }, 3000);
              }
            }, 500);

            login.on('exit', (code) => {
              clearInterval(checkAuth);
              clearTimeout(loginTimeout);
              ipcMain.removeListener(`auth-completed-${toolId}`, authCompletedHandler);

              if (!resolved) {
                resolved = true;
                if (authCompleted || code === 0) {
                  resolve();
                } else {
                  reject(new Error(`Login process failed with code ${code}`));
                }
              }
            });
          };

          return; // Exit early for Codex
        }

      // Claude (or other tools): start process directly
      if (toolId !== 'codex') {
        login = spawn(cmd, args, spawnOptions);
      }

      let authUrl = null;
      let authCompleted = false;
      let resolved = false;

      // Store reference to auth completion from callback server
      const authCompletedHandler = (event, data) => {
        if (data.toolId === toolId) {
          debugLog(`Auth completed signal received for ${toolId}`);
          authCompleted = true;
        }
      };

      // Listen for auth completion from callback server
      ipcMain.once(`auth-completed-${toolId}`, authCompletedHandler);

      const loginTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ipcMain.removeListener(`auth-completed-${toolId}`, authCompletedHandler);
          login.kill();
          reject(new Error('Login process timed out'));
        }
      }, 5 * 60 * 1000);

      // Handle data events (stdout/stderr)
      const handleOutput = (data) => {
        const output = data.toString();

        // Clean up terminal escape sequences for logging
        const cleanOutput = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                                  .replace(/\[[\?>][0-9]+[a-z]/g, '')
                                  .replace(/\[\d+[A-Z]/g, '');

        debugLog(`${toolId} output:`, cleanOutput);

        // Send cleaned output to UI
        if (cleanOutput.trim()) {
          mainWindow.webContents.send('log', { toolId, message: cleanOutput });
        }

        // Handle tool-specific interactive prompts
        if (toolId === 'claude' && config.useSlashCommand) {
          // Claude Code: First send /logout, then /login
          if (output.includes('>') || output.includes('claude>') ||
              output.includes('Welcome to Claude') || output.includes('Type')) {
            debugLog('Sending /logout then /login commands to Claude');
            if (login.stdin && login.stdin.writable) {
              login.stdin.write('/logout\n');
              setTimeout(() => {
                login.stdin.write('/login\n');
              }, 1000);
            }
          }
        }

        const urlPatterns = [
          /(https?:\/\/[^\s\)\]]+)/g,
          /Open.*browser.*?(https?:\/\/[^\s]+)/i,
          /Visit.*?(https?:\/\/[^\s]+)/i,
          /Navigate to.*?(https?:\/\/[^\s]+)/i
        ];

        for (const pattern of urlPatterns) {
          const matches = output.match(pattern);
          if (matches && matches.length > 0 && !authUrl) {
            // Get the last match (usually the most complete URL)
            authUrl = matches[matches.length - 1].replace(/[)\]'"]*$/, '');
            debugLog(`Found auth URL for ${toolId}:`, authUrl);
            mainWindow.webContents.send('log', {
              toolId,
              message: 'Opening authentication page in browser...'
            });

            // Don't open the URL ourselves - the CLI usually does it
            // But provide a fallback after a delay
            setTimeout(() => {
              if (!authCompleted && authUrl) {
                debugLog(`Opening auth URL as fallback for ${toolId}`);
                shell.openExternal(authUrl);
              }
            }, 5000);
            break;
          }
        }

        // If no URL found but we see login-related text, assume it's handling it
        if (!authUrl && (output.includes('Opening') ||
                        output.includes('browser') ||
                        output.includes('authenticate') ||
                        output.includes('Waiting for'))) {
          mainWindow.webContents.send('log', {
            toolId,
            message: 'Authentication in progress - check your browser...'
          });
        }

        const successPatterns = [
          'successfully signed in',
          'authentication successful',
          'logged in as',
          'authentication complete',
          'login successful',
          'authenticated successfully',
          'login completed',
          'loaded cached credentials',  // Gemini shows this when already authenticated
          'already authenticated',
          'credentials loaded'
        ];

        if (successPatterns.some(pattern => cleanOutput.toLowerCase().includes(pattern))) {
          authCompleted = true;
          debugLog(`Authentication success detected for ${toolId}: ${cleanOutput}`);
        }
      };

      // Regular spawn uses stdout and stderr
      login.stdout.on('data', handleOutput);
      login.stderr.on('data', (data) => {
        const output = data.toString();
        mainWindow.webContents.send('log', { toolId, message: output });

        // Check for success patterns in stderr too (some CLIs output there)
        if (output.toLowerCase().includes('success') ||
            output.toLowerCase().includes('authenticated')) {
          authCompleted = true;
        }
      });

      const checkAuth = setInterval(async () => {
        if (authCompleted && !resolved) {
          resolved = true;
          clearInterval(checkAuth);
          clearTimeout(loginTimeout);
          ipcMain.removeListener(`auth-completed-${toolId}`, authCompletedHandler);

          // Give time for CLI to save credentials
          setTimeout(() => {
            login.kill('SIGTERM');
            resolve();
          }, 3000);
        }
      }, 500);

      login.on('exit', (code) => {
        clearInterval(checkAuth);
        clearTimeout(loginTimeout);
        ipcMain.removeListener(`auth-completed-${toolId}`, authCompletedHandler);

        if (!resolved) {
          resolved = true;
          if (authCompleted || code === 0) {
            resolve();
          } else {
            reject(new Error(`Login process failed with code ${code}`));
          }
        }
      });

    } catch (error) {
      console.error(`Error in performLogin for ${toolId}:`, error);
      reject(error);
    }
  });
}

async function extractCredentials(toolId) {
  const config = CLI_CONFIGS[toolId];

  // Wait for credentials to be written
  await new Promise(r => setTimeout(r, 3000));

  // Tool-specific credential handling
  if (toolId === 'codex') {
    // Codex: ~/.codex/auth.json 및 config.toml
    const possiblePaths = [
      path.join(os.homedir(), '.codex', 'auth.json'),
      path.join(os.homedir(), '.codex', 'config.toml')
    ];

    for (const credPath of possiblePaths) {
      try {
        await fsPromises.access(credPath);
        const authData = await fsPromises.readFile(credPath, 'utf-8');

        let credentials;
        if (credPath.endsWith('.toml')) {
          credentials = { path: credPath, format: 'toml', content: authData };
        } else {
          credentials = JSON.parse(authData);
        }

        debugLog(`Codex credentials found at: ${credPath}`);
        mainWindow.webContents.send('log', {
          toolId,
          message: `Credentials extracted from: ${credPath}`
        });

        return credentials;
      } catch (error) {
        continue;
      }
    }
  } else if (toolId === 'claude') {
    // Claude Code: OS 보안 저장소 사용
    debugLog('Claude Code uses OS secure storage (Keychain/Secret Service/Credential Manager)');
    mainWindow.webContents.send('log', {
      toolId,
      message: 'Authentication completed (credentials in OS secure storage)'
    });

    return {
      status: 'authenticated',
      message: 'Claude Code authenticated successfully',
      storage: process.platform === 'darwin' ? 'macOS Keychain' :
               process.platform === 'win32' ? 'Windows Credential Manager' :
               'Secret Service'
    };
  } else if (toolId === 'gemini') {
    // Gemini: 로컬 캐시 (플랫폼별)
    debugLog('Gemini CLI uses local cache for credentials');
    mainWindow.webContents.send('log', {
      toolId,
      message: 'Authentication completed (credentials cached locally)'
    });

    // Check if we can verify authentication by running a command
    try {
      const enhancedPath = getEnhancedPath();
      const checkAuth = spawn('gemini', ['--version'], {
        env: sanitizeEnvForOAuth(enhancedPath)
      });

      return new Promise((resolve) => {
        checkAuth.on('close', (code) => {
          if (code === 0) {
            resolve({
              status: 'authenticated',
              message: 'Gemini CLI authenticated successfully',
              storage: 'local-cache'
            });
          } else {
            resolve({
              status: 'authentication-required',
              message: 'Gemini CLI may need re-authentication',
              storage: 'local-cache'
            });
          }
        });

        checkAuth.on('error', () => {
          resolve({
            status: 'error',
            message: 'Could not verify Gemini authentication',
            storage: 'local-cache'
          });
        });
      });
    } catch (error) {
      return {
        status: 'authenticated',
        message: 'Gemini CLI authenticated (verification skipped)',
        storage: 'local-cache'
      };
    }
  }

  // Fallback
  return {
    status: 'authenticated',
    message: 'Tool authenticated successfully',
    storage: 'unknown'
  };
}

// Helper function to check if already authenticated
async function checkAuthenticated(toolId) {
  const enhancedPath = getEnhancedPath();

  if (toolId === 'codex') {
    // Codex: ~/.codex/auth.json 존재 확인
    try {
      await fsPromises.access(path.join(os.homedir(), '.codex', 'auth.json'));
      debugLog('Found existing Codex auth.json');
      return true;
    } catch (error) {
      return false;
    }

  } else if (toolId === 'claude') {
    // Claude: OS 키체인 확인 (플랫폼별)
    if (process.platform === 'darwin') {
      // macOS: Keychain 확인
      try {
        // security find-generic-password는 찾으면 0, 못찾으면 에러
        execSync('security find-generic-password -s "claude-code" 2>/dev/null');
        debugLog('Found Claude credentials in Keychain');
        return true;
      } catch (e) {
        try {
          execSync('security find-generic-password -s "claude-cli" 2>/dev/null');
          debugLog('Found Claude credentials in Keychain');
          return true;
        } catch (e2) {
          return false;
        }
      }

    } else if (process.platform === 'win32') {
      // Windows: Credential Manager 확인
      try {
        execSync('cmdkey /list:claude-code 2>nul | findstr claude-code');
        debugLog('Found Claude credentials in Credential Manager');
        return true;
      } catch (e) {
        return false;
      }

    } else {
      // Linux: claude --version으로 확인
      return new Promise((resolve) => {
        const check = spawn('claude', ['--version'], {
          env: sanitizeEnvForOAuth(enhancedPath)
        });

        check.on('close', (code) => {
          resolve(code === 0);
        });

        check.on('error', () => resolve(false));
      });
    }

  } else if (toolId === 'gemini') {
    // Gemini: ~/.gemini/oauth_creds.json 존재 확인
    const credsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
    const winPath = process.platform === 'win32' ?
      path.join(process.env.USERPROFILE || os.homedir(), '.gemini', 'oauth_creds.json') :
      credsPath;

    try {
      await fsPromises.access(process.platform === 'win32' ? winPath : credsPath);
      debugLog('Found existing Gemini oauth_creds.json');
      return true;
    } catch (error) {
      // Only oauth_creds.json indicates OAuth account sign-in; otherwise not authenticated
      return false;
    }
  }

  return false;
}

// Helper function to logout/delete credentials
async function logoutTool(toolId) {
  try {
    if (toolId === 'codex') {
      // Codex: ~/.codex/auth.json 삭제로 로컬 로그아웃
      const authPath = path.join(os.homedir(), '.codex', 'auth.json');

      try {
        await fsPromises.unlink(authPath);
        debugLog(`Deleted Codex auth: ${authPath}`);
        return { success: true, message: 'Codex logged out successfully' };
      } catch (e) {
        debugLog(`No Codex auth file found at ${authPath}`);
        return { success: true, message: 'No Codex credentials to remove' };
      }

    } else if (toolId === 'claude') {
      // Claude: OS 키체인/보안 저장소 사용
      // 파일 삭제로는 완전한 로그아웃 불가, 키체인 정리 필요

      if (process.platform === 'darwin') {
        // macOS: Keychain에서 Claude 항목 삭제
        const keychainCommands = [
          'security delete-generic-password -s "claude-code" 2>/dev/null',
          'security delete-generic-password -s "claude-cli" 2>/dev/null',
          'security delete-generic-password -s "claude" 2>/dev/null',
          'security delete-internet-password -s "claude.ai" 2>/dev/null'
        ];

        let deletedAny = false;
        for (const cmd of keychainCommands) {
          try {
            execSync(cmd);
            debugLog(`Executed: ${cmd}`);
            deletedAny = true;
          } catch (e) {
            // 해당 키체인 항목이 없을 수 있음
          }
        }

        return {
          success: true,
          message: deletedAny ? 'Claude credentials removed from Keychain' : 'No Claude credentials in Keychain'
        };

      } else if (process.platform === 'win32') {
        // Windows: Credential Manager
        try {
          execSync('cmdkey /delete:claude-code 2>nul');
          return { success: true, message: 'Claude credentials removed from Credential Manager' };
        } catch (e) {
          return { success: true, message: 'No Claude credentials in Credential Manager' };
        }

      } else {
        // Linux: Secret Service
        return {
          success: true,
          message: 'Claude uses OS secure storage - manual removal may be needed'
        };
      }

    } else if (toolId === 'gemini') {
      // Gemini: ~/.gemini/oauth_creds.json 및 settings.json 처리
      const geminiDir = path.join(os.homedir(), '.gemini');
      const filesToDelete = [
        path.join(geminiDir, 'oauth_creds.json'),  // OAuth 인증 정보
        path.join(geminiDir, 'settings.json')       // 설정 (selectedAuth 포함)
      ];

      // Windows 경로도 확인
      if (process.platform === 'win32') {
        const winPath = path.join(process.env.USERPROFILE || os.homedir(), '.gemini');
        filesToDelete.push(
          path.join(winPath, 'oauth_creds.json'),
          path.join(winPath, 'settings.json')
        );
      }

      let deletedAny = false;
      for (const file of filesToDelete) {
        try {
          await fsPromises.unlink(file);
          debugLog(`Deleted Gemini file: ${file}`);
          deletedAny = true;
        } catch (e) {
          // 파일이 없을 수 있음
        }
      }

      return {
        success: true,
        message: deletedAny ? 'Gemini credentials removed' : 'No Gemini credentials found'
      };
    }

    return { success: false, message: 'Unknown tool' };
  } catch (error) {
    console.error(`Error logging out ${toolId}:`, error);
    return { success: false, message: error.message };
  }
}

// IPC Handlers
ipcMain.handle('check-tool', async (event, toolId) => {
  return await checkToolInstalled(toolId);
});

ipcMain.handle('check-authenticated', async (event, toolId) => {
  return await checkAuthenticated(toolId);
});

ipcMain.handle('logout-tool', async (event, toolId) => {
  return await logoutTool(toolId);
});

ipcMain.handle('install-tool', async (event, toolId) => {
  try {
    await installTool(toolId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('login-tool', async (event, toolId) => {
  try {
    await performLogin(toolId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('extract-credentials', async (event, toolId) => {
  try {
    const credentials = await extractCredentials(toolId);
    return { success: true, credentials };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('connect-tool', async (event, toolId) => {
  try {
    mainWindow.webContents.send('status-update', {
      toolId,
      status: 'checking',
      message: `Checking ${CLI_CONFIGS[toolId].name}...`
    });

    const isInstalled = await checkToolInstalled(toolId);

    if (!isInstalled) {
      mainWindow.webContents.send('status-update', {
        toolId,
        status: 'installing',
        message: `Installing ${CLI_CONFIGS[toolId].name}...`
      });

      await installTool(toolId);
    }

    // Check if already authenticated
    const isAuthenticated = await checkAuthenticated(toolId);

    if (isAuthenticated) {
      mainWindow.webContents.send('log', {
        toolId,
        message: `${CLI_CONFIGS[toolId].name} is already authenticated!`
      });

      mainWindow.webContents.send('status-update', {
        toolId,
        status: 'extracting',
        message: `Verifying existing credentials...`
      });

      const credentials = await extractCredentials(toolId);

      mainWindow.webContents.send('status-update', {
        toolId,
        status: 'completed',
        message: `${CLI_CONFIGS[toolId].name} connected successfully!`
      });

      return { success: true, credentials };
    }

    // Not authenticated, proceed with login
    mainWindow.webContents.send('status-update', {
      toolId,
      status: 'authenticating',
      message: `Authenticating ${CLI_CONFIGS[toolId].name}...`
    });

    await performLogin(toolId);

    mainWindow.webContents.send('status-update', {
      toolId,
      status: 'extracting',
      message: `Extracting credentials...`
    });

    const credentials = await extractCredentials(toolId);

    mainWindow.webContents.send('status-update', {
      toolId,
      status: 'completed',
      message: `${CLI_CONFIGS[toolId].name} connected successfully!`
    });

    return { success: true, credentials };
  } catch (error) {
    mainWindow.webContents.send('status-update', {
      toolId,
      status: 'error',
      message: error.message
    });

    return { success: false, error: error.message };
  }
});
