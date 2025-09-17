#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const targets = ['dist', 'dist-app'];

for (const target of targets) {
  const dirPath = path.join(projectRoot, target);
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`Failed to remove ${dirPath}:`, error);
    process.exitCode = 1;
  }
}
