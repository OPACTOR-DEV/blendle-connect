#!/bin/bash

echo "Testing Claude login with TTY..."

# First logout
echo "1. Logging out..."
printf "/logout\n/exit\n" | script -q /dev/null claude 2>/dev/null

sleep 2

# Now test login
echo "2. Testing login prompt..."
printf "/login\n1\n" | script -q /dev/null claude 2>&1 | head -100 | grep -E "(login|Login|account|Account|Anthropic|Console|browser|http)" || echo "No login prompts found"

echo "3. Checking if already authenticated..."
printf "/exit\n" | script -q /dev/null claude 2>&1 | head -20 | grep -E "(Welcome|Claude)" && echo "Claude is running"