#!/usr/bin/env node

/** Verify the packaged backend's stable Node-API terminal with its real runtime. */
const { execFile } = require('child_process');
const { cpSync, mkdirSync, readFileSync, rmSync } = require('fs');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

exports.default = async function (context) {
  const { appOutDir, electronPlatformName, arch, packager } = context;
  const electronVersion = packager.config.electronVersion || packager.info?.framework?.version;
  if (!/^\d+\.\d+\.\d+/.test(electronVersion || '')) {
    throw new Error('Cannot rebuild the backend without the resolved Electron version');
  }
  if (electronPlatformName !== process.platform) {
    throw new Error('The backend native terminal must be rebuilt on its target operating system');
  }

  const archNames = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
  const archStr = typeof arch === 'number' ? archNames[arch] : arch;
  if (archStr !== process.arch) {
    throw new Error(
      'The backend native terminal must be built and tested on its target architecture'
    );
  }
  const productFilename = packager.appInfo.productFilename || packager.appInfo.productName;
  const resourcesDir =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');
  const nativeModuleDir = path.join(resourcesDir, 'server', 'node_modules', 'node-pty');
  const nativeVersion = JSON.parse(
    readFileSync(path.join(nativeModuleDir, 'package.json'))
  ).version;
  if (nativeVersion !== '1.1.0-beta41') {
    throw new Error('Review the terminal Node-API compatibility policy before upgrading node-pty');
  }
  // This pinned node-pty uses NODE_API_MODULE and node-addon-api, not V8/NAN.
  // Its default Node-API 8 ABI is stable across our Node 22 build host and
  // Electron's Node runtime. The preparation step MUST build it from source;
  // copy that exact result and prove it with the packaged executable below.
  const sourceRelease = path.join(
    __dirname,
    '..',
    'server-bundle',
    'node_modules',
    'node-pty',
    'build',
    'Release'
  );
  const targetRelease = path.join(nativeModuleDir, 'build', 'Release');
  rmSync(targetRelease, { recursive: true, force: true });
  mkdirSync(path.dirname(targetRelease), { recursive: true });
  cpSync(sourceRelease, targetRelease, { recursive: true });

  const executable =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename)
      : path.join(
          appOutDir,
          electronPlatformName === 'win32'
            ? `${productFilename}.exe`
            : packager.executableName || productFilename
        );
  const probe = `
    const assert = require('node:assert/strict');
    assert.equal(process.versions.electron, process.argv[2]);
    assert.equal(process.arch, process.argv[3]);
    assert.ok(Number(process.versions.napi) >= 8);
    const pty = require(process.argv[1]);
    const windows = process.platform === 'win32';
    const marker = 'AUTOMAKER_NATIVE_PTY_OK';
    const child = pty.spawn(windows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
      windows ? ['/d', '/s', '/c', 'echo ' + marker] : ['-c', 'printf ' + marker],
      { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      console.error('Packaged terminal timed out');
      process.exitCode = 1;
    }, 10000);
    child.onData(data => { output += data; });
    child.onExit(event => {
      clearTimeout(timer);
      assert.equal(event.exitCode, 0);
      assert.ok(output.includes(marker));
      console.log(JSON.stringify({ result: 'PASS', electron: process.versions.electron,
        node: process.versions.node, abi: process.versions.modules, napi: process.versions.napi,
        arch: process.arch, terminal: 'spawn/output/exit verified' }));
    });
  `;
  try {
    const { stdout, stderr } = await execFileAsync(
      executable,
      ['-e', probe, nativeModuleDir, electronVersion, archStr],
      { cwd: resourcesDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20000 }
    );
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } catch (error) {
    if (error.stdout) console.error(error.stdout);
    if (error.stderr) console.error(error.stderr);
    throw error;
  }
  console.log('Packaged backend native terminal compatibility verified');
};
