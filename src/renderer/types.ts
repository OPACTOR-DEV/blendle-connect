export type ToolId = 'codex' | 'gemini' | 'claude';

export interface ToolState {
  connected: boolean;
  inProgress: boolean;
}

export interface LogEntry {
  toolId: ToolId | 'system';
  message: string;
  timestamp?: string;
  isError?: boolean;
}

export interface StatusUpdate {
  toolId: ToolId;
  status: 'checking' | 'installing' | 'authenticating' | 'extracting' | 'completed' | 'error' | '';
  message: string;
}

export interface AuthResult {
  success: boolean;
  credentials?: any;
  error?: string;
  message?: string;
}

export interface PrerequisiteStatus {
  status: 'checking' | 'error' | 'success';
  message: string;
}

export interface WindowAPI {
  connectTool: (toolId: ToolId) => Promise<AuthResult>;
  logoutTool: (toolId: ToolId) => Promise<AuthResult>;
  checkTool: (toolId: ToolId) => Promise<boolean>;
  checkAuthenticated: (toolId: ToolId) => Promise<boolean>;
  copyCredentials: (toolId: ToolId) => Promise<AuthResult>;
  onStatusUpdate: (callback: (data: StatusUpdate) => void) => void;
  onLog: (callback: (data: LogEntry) => void) => void;
  onAuthCompleted: (callback: (data: { toolId: ToolId }) => void) => void;
  onShowSuccessScreen: (callback: (data: { toolId: ToolId; toolName: string }) => void) => void;
  onPrerequisiteStatus: (callback: (data: PrerequisiteStatus) => void) => void;
  onPrerequisitesReady: (callback: () => void) => void;
  onToolConnected: (callback: (data: { toolId: ToolId; credentials: any }) => void) => void;
  onCredentialsStored: (callback: (data: any) => void) => void;
}

declare global {
  interface Window {
    api: WindowAPI;
  }
}