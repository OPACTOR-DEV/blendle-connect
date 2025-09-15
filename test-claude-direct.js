const ClaudeService = require('./dist/main/services/claude-service').ClaudeService;

async function test() {
  console.log('Testing Claude service directly...\n');

  // 1. Check authentication
  console.log('1. Checking authentication status...');
  const isAuth = await ClaudeService.checkAuthenticated();
  console.log('   Authenticated:', isAuth);

  // 2. Logout if authenticated
  if (isAuth) {
    console.log('\n2. Logging out...');
    const logoutResult = await ClaudeService.logout();
    console.log('   Logout result:', logoutResult);
  }

  // 3. Check authentication again
  console.log('\n3. Checking authentication after logout...');
  const isAuthAfter = await ClaudeService.checkAuthenticated();
  console.log('   Authenticated:', isAuthAfter);

  // 4. Try login
  console.log('\n4. Starting login process...');
  try {
    await ClaudeService.performAutoLogin({
      mainWindow: { webContents: { send: () => {} } },
      onLog: (msg) => console.log('   LOG:', msg),
      onAuthComplete: () => console.log('   AUTH COMPLETE!')
    });
  } catch (error) {
    console.error('   Login error:', error.message);
  }
}

test().catch(console.error);