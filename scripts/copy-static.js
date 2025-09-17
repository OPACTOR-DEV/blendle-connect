#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

const targets = [
  {
    type: 'file',
    src: path.join(projectRoot, 'src/renderer/index.html'),
    dest: path.join(projectRoot, 'dist/renderer/index.html')
  },
  {
    type: 'file',
    src: path.join(projectRoot, 'src/renderer/styles.css'),
    dest: path.join(projectRoot, 'dist/renderer/styles.css')
  },
  {
    type: 'dir',
    src: path.join(projectRoot, 'src/main/scripts'),
    dest: path.join(projectRoot, 'dist/main/scripts')
  }
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Missing file: ${srcPath}`);
  }
  ensureDir(path.dirname(destPath));
  fs.copyFileSync(srcPath, destPath);
}

function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) {
    return;
  }
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcEntry = path.join(srcDir, entry.name);
    const destEntry = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcEntry, destEntry);
    } else {
      ensureDir(path.dirname(destEntry));
      fs.copyFileSync(srcEntry, destEntry);
    }
  }
}

for (const target of targets) {
  if (target.type === 'file') {
    copyFile(target.src, target.dest);
  } else {
    copyDir(target.src, target.dest);
  }
}
