const { spawn, execSync } = require('child_process');

console.log('=== Claude Login Flow Test ===\n');

// 1. Check current auth status
console.log('1. Checking Keychain for existing credentials...');
try {
  const creds = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
    encoding: 'utf-8'
  });
  console.log('   ❌ Found credentials in Keychain (should be empty!)');
} catch {
  console.log('   ✅ No credentials in Keychain (good!)');
}

// 2. Start Claude and try to trigger login
console.log('\n2. Starting Claude process and sending /login command...');

const claude = spawn('claude', [], {
  env: { ...process.env, FORCE_TTY: '1' },
  stdio: ['pipe', 'pipe', 'pipe']
});

let buffer = '';
let loginTriggered = false;
let urlFound = false;

claude.stdout.on('data', (data) => {
  const output = data.toString();
  buffer += output;

  // Clean output for display
  const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
  if (clean && clean.length > 0) {
    console.log('   STDOUT:', clean.substring(0, 100));
  }

  // After welcome, send /login
  if (!loginTriggered && buffer.includes('Welcome')) {
    console.log('\n3. Sending /login command...');
    setTimeout(() => {
      claude.stdin.write('/login\n');
      loginTriggered = true;
    }, 1000);
  }

  // Look for login prompts
  if (buffer.includes('Select login') || buffer.includes('Choose')) {
    console.log('\n4. ✅ Login prompt detected!');
    console.log('   Sending "1" for Anthropic account...');
    setTimeout(() => {
      claude.stdin.write('1\n');
    }, 500);
  }

  // Look for auth URL
  const urlMatch = buffer.match(/(https?:\/\/[^\s\)]+)/);
  if (urlMatch && !urlFound) {
    urlFound = true;
    console.log('\n5. ✅ Auth URL found:', urlMatch[1]);
    console.log('\n   SUCCESS! Login flow is working correctly.');

    // Exit after finding URL
    setTimeout(() => {
      claude.stdin.write('/exit\n');
      setTimeout(() => {
        claude.kill();
        process.exit(0);
      }, 500);
    }, 1000);
  }
});

claude.stderr.on('data', (data) => {
  console.log('   STDERR:', data.toString().substring(0, 100));
});

// Timeout after 10 seconds
setTimeout(() => {
  if (!urlFound) {
    console.log('\n❌ Timeout: No login prompt or URL found');
    console.log('   Claude might already be authenticated or there\'s an issue with the login flow');
  }
  claude.kill();
  process.exit(1);
}, 10000);

claude.on('error', (err) => {
  console.error('Error spawning Claude:', err);
  process.exit(1);
});