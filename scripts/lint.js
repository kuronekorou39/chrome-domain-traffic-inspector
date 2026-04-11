#!/usr/bin/env node
// Simple lint script for Chrome extension files
// Checks syntax and common issues without requiring ESLint

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_FILES = [
  'lib/domain-utils.js',
  'background.js',
  'sidepanel.js'
];

let hasErrors = false;

for (const file of JS_FILES) {
  const filePath = path.join(__dirname, '..', file);

  if (!fs.existsSync(filePath)) {
    console.error(`MISSING: ${file}`);
    hasErrors = true;
    continue;
  }

  const code = fs.readFileSync(filePath, 'utf-8');

  // Syntax check
  try {
    new vm.Script(code, { filename: file });
    console.log(`  OK: ${file} (syntax)`);
  } catch (err) {
    console.error(`FAIL: ${file} - ${err.message}`);
    hasErrors = true;
  }

  // Check for common issues
  const lines = code.split('\n');
  lines.forEach((line, i) => {
    const lineNum = i + 1;
    // console.log left in production code (allow console.error/warn)
    if (/\bconsole\.log\b/.test(line) && !file.includes('test') && !file.includes('lint')) {
      console.warn(`  WARN: ${file}:${lineNum} - console.log found`);
    }
    // Debugger statement
    if (/\bdebugger\b/.test(line)) {
      console.error(`  FAIL: ${file}:${lineNum} - debugger statement found`);
      hasErrors = true;
    }
  });
}

// Check manifest.json is valid JSON
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf-8'));
  if (!manifest.manifest_version || !manifest.name || !manifest.version) {
    console.error('FAIL: manifest.json - missing required fields');
    hasErrors = true;
  } else {
    console.log('  OK: manifest.json');
  }
} catch (err) {
  console.error(`FAIL: manifest.json - ${err.message}`);
  hasErrors = true;
}

// Check HTML references script files correctly
const html = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.html'), 'utf-8');
const scriptRefs = [...html.matchAll(/src="([^"]+\.js)"/g)].map(m => m[1]);
for (const ref of scriptRefs) {
  const refPath = path.join(__dirname, '..', ref);
  if (!fs.existsSync(refPath)) {
    console.error(`FAIL: sidepanel.html references missing file: ${ref}`);
    hasErrors = true;
  }
}

if (hasErrors) {
  console.error('\nLint failed with errors.');
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}
