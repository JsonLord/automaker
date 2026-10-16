#!/usr/bin/env node

/**
 * This script prepares the server for bundling with Electron.
 * It copies the server dist and installs production dependencies
 * in a way that works with npm workspaces.
 */

import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, lstatSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const APP_DIR = join(__dirname, '..');
const SERVER_DIR = join(APP_DIR, '..', 'server');
const LIBS_DIR = join(APP_DIR, '..', '..', 'libs');
const BUNDLE_DIR = join(APP_DIR, 'server-bundle');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Local workspace packages that need to be bundled
const LOCAL_PACKAGES = [
  '@automaker/types',
  '@automaker/utils',
  '@automaker/prompts',
  '@automaker/platform',
  '@automaker/model-resolver',
  '@automaker/dependency-resolver',
  '@automaker/git-utils',
];

console.log('🔧 Preparing server for Electron bundling...\n');

// Step 1: Clean up previous bundle
if (existsSync(BUNDLE_DIR)) {
  console.log('🗑️  Cleaning previous server-bundle...');
  rmSync(BUNDLE_DIR, { recursive: true });
}
mkdirSync(BUNDLE_DIR, { recursive: true });

// Step 2: Build the server TypeScript
console.log('📦 Building server TypeScript...');
execFileSync(npmCommand, ['run', 'build'], {
  cwd: SERVER_DIR,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

// Step 3: Copy server dist
console.log('📋 Copying server dist...');
cpSync(join(SERVER_DIR, 'dist'), join(BUNDLE_DIR, 'dist'), { recursive: true });

// Step 4: Copy local workspace packages
console.log('📦 Copying local workspace packages...');
const bundleLibsDir = join(BUNDLE_DIR, 'libs');
mkdirSync(bundleLibsDir, { recursive: true });

for (const pkgName of LOCAL_PACKAGES) {
  const pkgDir = pkgName.replace('@automaker/', '');
  const srcDir = join(LIBS_DIR, pkgDir);
  const destDir = join(bundleLibsDir, pkgDir);

  if (!existsSync(srcDir)) {
    throw new Error(`Required package ${pkgName} not found at ${srcDir}`);
  }

  mkdirSync(destDir, { recursive: true });

  // Copy dist folder
  if (existsSync(join(srcDir, 'dist'))) {
    cpSync(join(srcDir, 'dist'), join(destDir, 'dist'), { recursive: true });
  }

  // The copied packages are production artifacts, not development workspaces.
  // npm still resolves omitted dev peers for file: links; retaining Vitest here
  // can pull an unrelated test toolchain into standalone dependency resolution.
  const pkg = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf-8'));
  delete pkg.devDependencies;
  delete pkg.scripts;
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[section] || {})) {
      if (!name.startsWith('@automaker/')) continue;
      if (!LOCAL_PACKAGES.includes(name)) {
        throw new Error(`Required local dependency ${name} is missing from LOCAL_PACKAGES`);
      }
      pkg[section][name] = `file:../${name.replace('@automaker/', '')}`;
    }
  }
  writeFileSync(join(destDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  console.log(`   ✓ ${pkgName}`);
}

// Step 5: Create a minimal package.json for the server
console.log('📝 Creating server package.json...');
const serverPkg = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf-8'));

// Replace local package versions with file: references
const dependencies = { ...serverPkg.dependencies };
for (const pkgName of LOCAL_PACKAGES) {
  if (dependencies[pkgName]) {
    const pkgDir = pkgName.replace('@automaker/', '');
    dependencies[pkgName] = `file:libs/${pkgDir}`;
  }
}

const bundlePkg = {
  name: '@automaker/server-bundle',
  version: serverPkg.version,
  type: 'module',
  main: 'dist/index.js',
  dependencies,
};

writeFileSync(join(BUNDLE_DIR, 'package.json'), JSON.stringify(bundlePkg, null, 2));

// Step 6: Install production dependencies
console.log('📥 Installing server production dependencies...');
execFileSync(npmCommand, ['install', '--omit=dev', '--ignore-scripts', '--workspaces=false'], {
  cwd: BUNDLE_DIR,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    // Prevent npm from using workspace resolution
    npm_config_workspaces: 'false',
  },
});

// Step 6b: Replace symlinks for local packages with real copies
// npm install creates symlinks for file: references, but these break when packaged by electron-builder
console.log('🔗 Replacing symlinks with real directory copies...');
const nodeModulesAutomaker = join(BUNDLE_DIR, 'node_modules', '@automaker');
for (const pkgName of LOCAL_PACKAGES) {
  const pkgDir = pkgName.replace('@automaker/', '');
  const nmPkgPath = join(nodeModulesAutomaker, pkgDir);
  try {
    // lstatSync does not follow symlinks, allowing us to check for broken ones
    if (lstatSync(nmPkgPath).isSymbolicLink()) {
      const realPath = resolve(BUNDLE_DIR, 'libs', pkgDir);
      rmSync(nmPkgPath);
      cpSync(realPath, nmPkgPath, { recursive: true });
      console.log(`   ✓ Replaced symlink: ${pkgName}`);
    }
  } catch (error) {
    // If the path doesn't exist, lstatSync throws ENOENT. We can safely ignore this.
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

// Step 7: Rebuild native modules for current architecture
// This is critical for modules like node-pty that have native bindings
console.log('🔨 Rebuilding native modules for current architecture...');
execFileSync(npmCommand, ['rebuild', 'node-pty', '--workspaces=false'], {
  cwd: BUNDLE_DIR,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, npm_config_build_from_source: 'true' },
});
console.log('✅ Native modules rebuilt successfully');

console.log('\n✅ Server prepared for bundling at:', BUNDLE_DIR);
