import * as path from 'path';
import * as os from 'os';
import { CLIConfig, ToolId } from '../types';

export const CLI_CONFIGS: Record<ToolId, CLIConfig> = {
  codex: {
    name: 'Codex CLI',
    installCmd: ['npm', 'install', '-g', '@openai/codex'],
    checkCmd: 'codex',
    loginCmd: ['codex', 'login'],
    authPath: path.join(os.homedir(), '.codex', 'auth.json'),
    configPath: path.join(os.homedir(), '.codex', 'config.toml'),
    port: 1455,
    description: 'OpenAI\'s lightweight coding agent',
    requiresInteractive: true
  },
  gemini: {
    name: 'Gemini CLI',
    installCmd: ['npm', 'install', '-g', '@google/gemini-cli'],
    checkCmd: 'gemini',
    loginCmd: ['gemini'],
    authPath: null,
    port: 1457,
    description: 'Google\'s Gemini CLI with 1M token context',
    requiresInteractive: true,
    interactiveLogin: true
  },
  claude: {
    name: 'Claude Code',
    installCmd: ['npm', 'install', '-g', '@anthropic-ai/claude-code'],
    checkCmd: 'claude',
    loginCmd: ['claude'],
    authPath: path.join(os.homedir(), '.claude', 'config.json'),
    configPath: path.join(os.homedir(), '.claude', 'config.json'),
    port: 1459,
    description: 'Anthropic\'s powerful AI coding assistant',
    requiresInteractive: true,
    interactiveLogin: true
  }
};