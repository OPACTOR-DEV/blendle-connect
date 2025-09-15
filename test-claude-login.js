const { spawn } = require('child_process');

console.log('Testing Claude login flow...');

async function testClaude() {
  // First logout
  console.log('1. Logging out...');
  const logout = spawn('claude', [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_TTY: '1' }
  });

  logout.stdin.write('/logout\n');
  setTimeout(() => {
    logout.stdin.write('/exit\n');
    logout.kill();
  }, 1000);

  await new Promise(r => setTimeout(r, 2000));

  // Now try login
  console.log('2. Starting login process...');
  const claude = spawn('claude', [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_TTY: '1' }
  });

  let buffer = '';

  claude.stdout.on('data', (data) => {
    const output = data.toString();
    buffer += output;
    const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    if (clean.trim()) {
      console.log('STDOUT:', clean);
    }

    // Try to send /login command after welcome
    if (buffer.includes('Welcome to Claude') && !buffer.includes('login')) {
      console.log('>>> Sending /login command');
      claude.stdin.write('/login\n');
    }

    // Handle login method selection
    if (buffer.includes('Select login method') || buffer.includes('[1]') && buffer.includes('Anthropic')) {
      console.log('>>> Sending 1 for Anthropic account');
      setTimeout(() => {
        claude.stdin.write('1\n');
      }, 500);
    }

    // Check for browser URL
    if (buffer.includes('http')) {
      const urlMatch = buffer.match(/(https?:\/\/[^\s\)]+)/);
      if (urlMatch) {
        console.log('>>> Found auth URL:', urlMatch[1]);
      }
    }
  });

  claude.stderr.on('data', (data) => {
    console.log('STDERR:', data.toString());
  });

  // Exit after 15 seconds
  setTimeout(() => {
    console.log('Timeout, sending exit');
    claude.stdin.write('/exit\n');
    setTimeout(() => {
      claude.kill();
      process.exit(0);
    }, 1000);
  }, 15000);
}

testClaude().catch(console.error);