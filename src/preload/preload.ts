import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
    // Tool operations
    checkTool: (toolId: string) => ipcRenderer.invoke('check-tool', toolId),
    checkAuthenticated: (toolId: string) => ipcRenderer.invoke('check-authenticated', toolId),
    installTool: (toolId: string) => ipcRenderer.invoke('install-tool', toolId),
    loginTool: (toolId: string) => ipcRenderer.invoke('login-tool', toolId),
    logoutTool: (toolId: string) => ipcRenderer.invoke('logout-tool', toolId),
    extractCredentials: (toolId: string) => ipcRenderer.invoke('extract-credentials', toolId),
    connectTool: (toolId: string) => ipcRenderer.invoke('connect-tool', toolId),
    copyCredentials: (toolId: string) => ipcRenderer.invoke('copy-credentials', toolId),

    // Event listeners
    onStatusUpdate: (callback: (data: any) => void) =>
        ipcRenderer.on('status-update', (_event, data) => callback(data)),
    onLog: (callback: (data: any) => void) =>
        ipcRenderer.on('log', (_event, data) => callback(data)),
    onAuthCompleted: (callback: (data: any) => void) =>
        ipcRenderer.on('auth-completed', (_event, data) => callback(data)),
    onShowSuccessScreen: (callback: (data: any) => void) =>
        ipcRenderer.on('show-success-screen', (_event, data) => callback(data)),
    onPrerequisiteStatus: (callback: (data: any) => void) =>
        ipcRenderer.on('prerequisite-status', (_event, data) => callback(data)),
    onPrerequisitesReady: (callback: () => void) =>
        ipcRenderer.on('prerequisites-ready', () => callback()),
    onToolConnected: (callback: (data: any) => void) =>
        ipcRenderer.on('tool-connected', (_event, data) => callback(data)),
    onCredentialsStored: (callback: (data: any) => void) =>
        ipcRenderer.on('credentials-stored', (_event, data) => callback(data))
});