#!/usr/bin/env node

/**
 * Script to convert git+ssh:// URLs to git+https:// URLs in package-lock.json
 * This ensures compatibility with CI/CD environments that don't support SSH.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const lockfilePath = join(process.cwd(), 'package-lock.json');

try {
  let content = readFileSync(lockfilePath, 'utf8');
  const originalContent = content;

  // Convert git+ssh://git@github.com/ to git+https://github.com/
  content = content.replace(/git\+ssh:\/\/git@github\.com\//g, 'git+https://github.com/');

  // Also handle other potential git+ssh patterns (e.g., git+ssh://git@gitlab.com/)
  content = content.replace(/git\+ssh:\/\/git@([^/]+)\//g, 'git+https://$1/');

  if (content !== originalContent) {
    writeFileSync(lockfilePath, content, 'utf8');
    console.log('✓ Fixed git+ssh:// URLs in package-lock.json');
    process.exit(0);
  } else {
    console.log('✓ No git+ssh:// URLs found in package-lock.json');
    process.exit(0);
  }
} catch (error) {
  console.error('Error fixing package-lock.json:', error.message);
  process.exit(1);
}
