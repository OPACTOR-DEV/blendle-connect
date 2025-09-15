export interface CLIConfig {
  name: string;
  installCmd: string[];
  checkCmd: string;
  loginCmd: string[];
  authPath: string | null;
  configPath?: string;
  port: number;
  description: string;
  requiresInteractive: boolean;
  useSlashCommand?: boolean;
  interactiveLogin?: boolean;
  altInstallCmd?: {
    darwin?: string[];
    linux?: string[];
    win32?: string[] | null;
  };
}

export type ToolId = 'codex' | 'gemini' | 'claude';

export interface ToolState {
  connected: boolean;
  inProgress: boolean;
}

export interface AuthResult {
  success: boolean;
  credentials?: any;
  error?: string;
}

export interface LogMessage {
  toolId: ToolId | 'system';
  message: string;
  level?: 'info' | 'warn' | 'error' | 'debug';
  timestamp?: string;
}

export interface StatusUpdate {
  toolId: ToolId;
  status: 'checking' | 'installing' | 'authenticating' | 'extracting' | 'completed' | 'error' | '';
  message: string;
}

export interface Credentials {
  status: string;
  message: string;
  storage?: string;
  path?: string;
  format?: string;
  content?: string;
}