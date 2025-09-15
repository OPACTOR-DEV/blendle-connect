import * as path from 'path';
import * as os from 'os';

export class EnvironmentManager {
  private static readonly UNSET_VARS = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_GCA',
    'NO_BROWSER',
    'DEBIAN_FRONTEND',
    'CI'
  ];

  static getEnhancedPath(): string {
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
      process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'npm') : ''
    ].filter(p => p);

    const allPaths = [...new Set([...additionalPaths, ...existingPath.split(pathSeparator)])];
    return allPaths.join(pathSeparator);
  }

  static sanitizeEnvForOAuth(enhancedPath?: string): NodeJS.ProcessEnv {
    const env = { ...process.env };

    for (const key of this.UNSET_VARS) {
      if (key in env) delete env[key];
    }

    env.PATH = enhancedPath || this.getEnhancedPath();

    if (env.BROWSER === 'www-browser') delete env.BROWSER;

    return env;
  }

  static getSpawnEnv(): NodeJS.ProcessEnv {
    const enhancedPath = this.getEnhancedPath();
    return {
      ...this.sanitizeEnvForOAuth(enhancedPath),
      TERM: 'xterm-256color',
      FORCE_COLOR: '1'
    };
  }
}