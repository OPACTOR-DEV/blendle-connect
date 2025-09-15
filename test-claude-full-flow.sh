#!/bin/bash

echo "========================================="
echo "Claude Code Full Installation & Login Test"
echo "========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Check current status
echo -e "${YELLOW}Step 1: Checking current Claude installation...${NC}"
if which claude > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Claude is installed at: $(which claude)${NC}"
    claude --version
else
    echo -e "${RED}✗ Claude is NOT installed${NC}"
fi

# Step 2: Clean up existing auth
echo ""
echo -e "${YELLOW}Step 2: Cleaning up existing authentication...${NC}"

# Kill any running Claude processes
pkill -f claude 2>/dev/null && echo "  - Killed existing Claude processes" || echo "  - No Claude processes running"

# Remove from Keychain (macOS)
security delete-generic-password -s "Claude Code-credentials" 2>/dev/null && \
    echo -e "${GREEN}  ✓ Removed credentials from Keychain${NC}" || \
    echo "  - No credentials in Keychain"

# Remove cache directories
rm -rf ~/.claude/statsig ~/.claude/shell-snapshots 2>/dev/null && \
    echo -e "${GREEN}  ✓ Cleaned cache directories${NC}" || \
    echo "  - No cache to clean"

# Step 3: Uninstall Claude (if needed for fresh install)
echo ""
echo -e "${YELLOW}Step 3: Uninstalling Claude for fresh install...${NC}"
npm uninstall -g @anthropic-ai/claude-code 2>/dev/null && \
    echo -e "${GREEN}  ✓ Uninstalled Claude Code${NC}" || \
    echo "  - Claude was not installed via npm"

# Step 4: Install Claude
echo ""
echo -e "${YELLOW}Step 4: Installing Claude Code...${NC}"
npm install -g @anthropic-ai/claude-code

if which claude > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Claude installed successfully!${NC}"
    echo "  Version: $(claude --version)"
else
    echo -e "${RED}✗ Failed to install Claude${NC}"
    exit 1
fi

# Step 5: Test login flow
echo ""
echo -e "${YELLOW}Step 5: Testing Claude login flow...${NC}"
echo "This will attempt to trigger the login process..."
echo ""

# Create expect script for automated interaction
cat > /tmp/claude-login-test.exp << 'EOF'
#!/usr/bin/expect -f

set timeout 30
spawn claude

# Wait for initial prompt
expect {
    "Welcome to Claude" {
        send "/login\r"
    }
    timeout {
        puts "Timeout waiting for Claude to start"
        exit 1
    }
}

# Wait for login method selection
expect {
    "Select login method" {
        puts "\n=== LOGIN PROMPT DETECTED ==="
        send "1\r"
    }
    "Anthropic account" {
        puts "\n=== ANTHROPIC OPTION DETECTED ==="
        send "1\r"
    }
    timeout {
        puts "No login prompt detected - Claude might already be authenticated"
    }
}

# Look for browser URL
expect {
    -re {(https://[^\s]+)} {
        puts "\n=== BROWSER URL DETECTED ==="
        puts "URL: $expect_out(1,string)"
        puts "SUCCESS: Login flow is working!"
    }
    timeout {
        puts "No browser URL detected within timeout"
    }
}

# Exit
send "/exit\r"
expect eof
EOF

chmod +x /tmp/claude-login-test.exp

# Check if expect is installed
if which expect > /dev/null 2>&1; then
    echo "Running automated login test with expect..."
    /tmp/claude-login-test.exp
else
    echo -e "${YELLOW}expect not installed, trying alternative method...${NC}"

    # Alternative: Use script command with input
    echo "Creating test script..."
    cat > /tmp/claude-test-input.txt << 'EOF'
/login
1
EOF

    echo "Running Claude with test input..."
    timeout 10 script -q /dev/null bash -c 'cat /tmp/claude-test-input.txt | claude' | head -100 | grep -E "(login|Login|account|Anthropic|http)" || echo "No login prompts detected"
fi

# Step 6: Final verification
echo ""
echo -e "${YELLOW}Step 6: Final verification...${NC}"

# Check if credentials were created
sleep 2
if security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null > /dev/null; then
    echo -e "${GREEN}✓ Claude credentials found in Keychain - authentication successful!${NC}"
else
    echo -e "${YELLOW}⚠ No credentials in Keychain - authentication may be pending${NC}"
fi

# Cleanup
rm -f /tmp/claude-login-test.exp /tmp/claude-test-input.txt

echo ""
echo "========================================="
echo "Test complete!"
echo "========================================="`