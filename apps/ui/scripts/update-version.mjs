#!/usr/bin/env node
/**
 * Updates the version in apps/ui/package.json
 * Usage: node scripts/update-version.mjs <version>
 * Example: node scripts/update-version.mjs 1.2.3
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const version = process.argv[2];

if (!version) {
  console.error('Error: Version argument is required');
  console.error('Usage: node scripts/update-version.mjs <version>');
  process.exit(1);
}

// Remove 'v' prefix if present (e.g., "v1.2.3" -> "1.2.3")
const cleanVersion = version.startsWith('v') ? version.slice(1) : version;

// Validate version format (basic semver check)
if (!/^\d+\.\d+\.\d+/.test(cleanVersion)) {
  console.error(`Error: Invalid version format: ${cleanVersion}`);
  console.error('Expected format: X.Y.Z (e.g., 1.2.3)');
  process.exit(1);
}

const packageJsonPath = join(__dirname, '..', 'package.json');

try {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const oldVersion = packageJson.version;
  packageJson.version = cleanVersion;

  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');

  console.log(`Updated version from ${oldVersion} to ${cleanVersion}`);
} catch (error) {
  console.error(`Error updating version: ${error.message}`);
  process.exit(1);
}
