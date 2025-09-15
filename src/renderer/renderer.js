const connectButtons = document.querySelectorAll('.connect-btn');
const logoutButtons = document.querySelectorAll('.logout-btn');
const debugConsole = document.getElementById('debug-console');
const consoleOutput = document.getElementById('console-output');
const debugSection = document.querySelector('.debug-section');
const toggleDebugBtn = document.getElementById('toggle-debug');

const toolStates = {
    codex: { connected: false, inProgress: false },
    claude: { connected: false, inProgress: false },
    gemini: { connected: false, inProgress: false }
};

function formatTimestamp() {
    const now = new Date();
    return now.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function addLogEntry(toolId, message, isError = false) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${toolId} ${isError ? 'error' : ''}`;

    const timestamp = document.createElement('span');
    timestamp.className = 'log-timestamp';
    timestamp.textContent = `[${formatTimestamp()}]`;

    const content = document.createElement('span');
    content.textContent = message;

    entry.appendChild(timestamp);
    entry.appendChild(content);

    consoleOutput.appendChild(entry);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;

    // Auto-expand debug console when there's activity
    if (!debugSection.classList.contains('expanded')) {
        debugSection.classList.add('expanded');
    }
}

function updateButtonState(toolId, state) {
    const connectBtn = document.querySelector(`#connect-${toolId}`);
    const logoutBtn = document.querySelector(`#logout-${toolId}`);
    const btnText = connectBtn.querySelector('.btn-text');
    const spinner = connectBtn.querySelector('.spinner');
    const statusIndicator = document.querySelector(`#status-${toolId}`);

    switch (state) {
        case 'connecting':
            connectBtn.disabled = true;
            btnText.textContent = 'Connecting...';
            spinner.style.display = 'block';
            connectBtn.classList.add('loading');
            logoutBtn.style.display = 'none';
            break;

        case 'connected':
            connectBtn.style.display = 'none';
            logoutBtn.style.display = 'flex';
            spinner.style.display = 'none';
            connectBtn.classList.remove('loading');
            // Update status indicator
            updateStatus(toolId, 'completed', 'Connected');
            break;

        case 'error':
            connectBtn.disabled = false;
            btnText.textContent = 'Retry';
            spinner.style.display = 'none';
            connectBtn.classList.remove('loading');
            connectBtn.style.display = 'flex';
            logoutBtn.style.display = 'none';
            break;

        default:
            connectBtn.disabled = false;
            btnText.textContent = 'Connect';
            spinner.style.display = 'none';
            connectBtn.classList.remove('loading');
            connectBtn.style.display = 'flex';
            logoutBtn.style.display = 'none';
    }
}

function updateStatus(toolId, status, message) {
    const statusIndicator = document.querySelector(`#status-${toolId}`);

    // Remove all status classes
    statusIndicator.classList.remove('checking', 'installing', 'authenticating', 'completed', 'error', 'extracting');

    // Only add class if status is not empty
    if (status && status.trim() !== '') {
        statusIndicator.classList.add(status);
        statusIndicator.textContent = message;
        statusIndicator.style.display = 'block';
    } else {
        // Hide status indicator if no status
        statusIndicator.textContent = '';
        statusIndicator.style.display = 'none';
    }

    // Add log entry only if there's a message
    if (message && message.trim() !== '') {
        addLogEntry(toolId, message, status === 'error');
    }
}

async function connectTool(toolId) {
    if (toolStates[toolId].connected || toolStates[toolId].inProgress) {
        return;
    }

    toolStates[toolId].inProgress = true;
    updateButtonState(toolId, 'connecting');

    try {
        addLogEntry(toolId, `Starting connection process...`);

        const result = await window.api.connectTool(toolId);

        if (result.success) {
            toolStates[toolId].connected = true;
            toolStates[toolId].inProgress = false;
            updateButtonState(toolId, 'connected');

            // Display extracted credentials in debug console
            if (result.credentials) {
                addLogEntry(toolId, `Credentials extracted successfully:`);
                addLogEntry(toolId, JSON.stringify(result.credentials, null, 2));
            }
        } else {
            throw new Error(result.error);
        }
    } catch (error) {
        toolStates[toolId].inProgress = false;
        updateButtonState(toolId, 'error');
        updateStatus(toolId, 'error', `Connection failed: ${error.message}`);
        addLogEntry(toolId, `Error: ${error.message}`, true);
    }
}

async function logoutTool(toolId) {
    // Don't double log
    updateStatus(toolId, 'checking', 'Logging out...');

    try {
        const result = await window.api.logoutTool(toolId);

        if (result.success) {
            toolStates[toolId].connected = false;
            updateButtonState(toolId, 'default');
            // Clear status indicator
            updateStatus(toolId, '', '');
            addLogEntry(toolId, result.message);
            addLogEntry('system', `${toolId} disconnected successfully`);
        } else {
            throw new Error(result.message || 'Logout failed');
        }
    } catch (error) {
        addLogEntry(toolId, `Logout error: ${error.message}`, true);
        updateStatus(toolId, 'error', `Logout failed`);
        // Reset button state even on error
        setTimeout(() => {
            updateStatus(toolId, '', '');
        }, 3000);
    }
}

async function checkInitialAuth() {
    for (const toolId of ['codex', 'claude', 'gemini']) {
        const isInstalled = await window.api.checkTool(toolId);

        if (isInstalled) {
            const isAuthenticated = await window.api.checkAuthenticated(toolId);

            if (isAuthenticated) {
                toolStates[toolId].connected = true;
                updateButtonState(toolId, 'connected');
                addLogEntry('system', `${toolId} is already authenticated`);
            }
        }
    }
}

// Event Listeners
connectButtons.forEach(button => {
    button.addEventListener('click', () => {
        const toolId = button.dataset.tool;
        connectTool(toolId);
    });
});

logoutButtons.forEach(button => {
    button.addEventListener('click', () => {
        const toolId = button.dataset.tool;
        logoutTool(toolId);
    });
});

toggleDebugBtn.addEventListener('click', () => {
    debugSection.classList.toggle('expanded');
});

// IPC Event Handlers
window.api.onStatusUpdate((data) => {
    const { toolId, status, message } = data;
    updateStatus(toolId, status, message);
});

window.api.onLog((data) => {
    const { toolId, message } = data;
    addLogEntry(toolId, message);
});

window.api.onAuthCompleted((data) => {
    const { toolId } = data;
    addLogEntry(toolId, 'Authentication completed successfully!');
});

// Initial setup
document.addEventListener('DOMContentLoaded', async () => {
    addLogEntry('system', 'Blendle Connect initialized');
    addLogEntry('system', 'Checking authentication status...');

    // Check if tools are already installed and authenticated
    await checkInitialAuth();

    addLogEntry('system', 'Ready to connect to AI CLI tools');
});