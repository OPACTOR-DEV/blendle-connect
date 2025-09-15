const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Tool operations
    checkTool: (toolId) => ipcRenderer.invoke('check-tool', toolId),
    checkAuthenticated: (toolId) => ipcRenderer.invoke('check-authenticated', toolId),
    installTool: (toolId) => ipcRenderer.invoke('install-tool', toolId),
    loginTool: (toolId) => ipcRenderer.invoke('login-tool', toolId),
    logoutTool: (toolId) => ipcRenderer.invoke('logout-tool', toolId),
    extractCredentials: (toolId) => ipcRenderer.invoke('extract-credentials', toolId),
    connectTool: (toolId) => ipcRenderer.invoke('connect-tool', toolId),

    // Event listeners
    onStatusUpdate: (callback) => ipcRenderer.on('status-update', (event, data) => callback(data)),
    onLog: (callback) => ipcRenderer.on('log', (event, data) => callback(data)),
    onAuthCompleted: (callback) => ipcRenderer.on('auth-completed', (event, data) => callback(data))
});