const { spawn } = require('child_process');

console.log('Testing Claude CLI interaction...');

const claude = spawn('claude', [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, FORCE_TTY: '1' }
});

let buffer = '';
let step = 0;

claude.stdout.on('data', (data) => {
  buffer += data.toString();
  console.log('STDOUT:', JSON.stringify(data.toString()));
  console.log('CLEAN:', data.toString().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''));

  // Try to detect prompts and respond
  if (step === 0 && buffer.includes('Choose') || buffer.includes('Select') || buffer.includes('Dark')) {
    console.log('>>> Sending ENTER for theme selection');
    claude.stdin.write('\r\n');
    step = 1;
    buffer = '';
  } else if (step === 1 && (buffer.includes('login') || buffer.includes('Anthropic') || buffer.includes('[1]'))) {
    console.log('>>> Sending 1 for Anthropic account');
    setTimeout(() => {
      claude.stdin.write('1\r\n');
      step = 2;
      buffer = '';
    }, 500);
  }
});

claude.stderr.on('data', (data) => {
  console.log('STDERR:', data.toString());
});

claude.on('close', (code) => {
  console.log('Process exited with code:', code);
  process.exit(0);
});

// Timeout after 30 seconds
setTimeout(() => {
  console.log('Timeout reached, killing process');
  claude.kill();
}, 30000);