const { execSync } = require('child_process');

console.log('Testing Claude Keychain integration...\n');

// 1. Check current auth status
console.log('1. Checking current authentication status:');
try {
  const creds = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
    encoding: 'utf-8'
  });
  if (creds && creds.trim()) {
    console.log('✅ Claude is authenticated (credentials found in Keychain)');
    console.log('   Credentials length:', creds.trim().length, 'characters');
  }
} catch (e) {
  console.log('❌ Claude is NOT authenticated (no credentials in Keychain)');
}

// 2. Try to delete credentials
console.log('\n2. Attempting to delete Claude credentials from Keychain:');
try {
  execSync('security delete-generic-password -s "Claude Code-credentials" 2>/dev/null');
  console.log('✅ Successfully deleted Claude credentials from Keychain');
} catch (e) {
  console.log('❌ No credentials to delete or deletion failed');
}

// 3. Verify deletion
console.log('\n3. Verifying deletion:');
try {
  const creds = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
    encoding: 'utf-8'
  });
  if (creds && creds.trim()) {
    console.log('⚠️  Credentials still exist (deletion may have failed)');
  }
} catch (e) {
  console.log('✅ Credentials successfully removed from Keychain');
}

console.log('\nTest complete!');