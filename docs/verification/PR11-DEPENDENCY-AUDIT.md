# PR #11 dependency audit

Audit dates: 2026-10-15 and 2026-10-16. Registry audit results change as advisories are published.
Counts below are vulnerable **packages**, including packages that inherit a
finding through a dependency; they are not counts of distinct vulnerabilities.

## Baseline and remediation

| Audit                  | Before                                      | After compatible upgrades         |
| ---------------------- | ------------------------------------------- | --------------------------------- |
| Full dependency tree   | 66: 7 critical, 44 high, 11 moderate, 4 low | 8: 0 critical, 0 high, 8 moderate |
| `npm audit --omit=dev` | 16: 2 critical, 10 high, 3 moderate, 1 low  | 0                                 |

The Security Audit workflow now uses `npm audit --audit-level=high`, strengthening
the previous critical-only gate. That exact command exits successfully. This does not establish that the
remaining moderate finding is acceptable for a desktop packaging release.
The original HF Dockerfile copies the full builder `node_modules` directory,
including desktop and development dependencies. An omitted-development audit
alone therefore does not describe that original image's contents.

No `npm audit fix --force`, ignored advisory, override, audit exclusion, lowered
severity threshold, or legacy peer-dependency resolver was used.

| Direct dependency                   | Before                        | After             | Compatibility constraint                                                |
| ----------------------------------- | ----------------------------- | ----------------- | ----------------------------------------------------------------------- |
| `@github/copilot-sdk`               | 0.1.16                        | 0.2.2             | Node >=20; fixes real Node ESM import failure and refreshes bundled CLI |
| `@modelcontextprotocol/sdk`         | 1.25.2                        | 1.32.1            | Node >=18; existing Zod 4 satisfies its peer range                      |
| `morgan`                            | 1.10.1                        | 1.12.1            | Same major; logging security fixes                                      |
| `ws`                                | 8.18.3                        | 8.22.0            | Same major; server WebSocket API retained                               |
| `yaml`                              | 2.7.0                         | 2.9.1             | Same major; project lifecycle and export parsing                        |
| `vitest`                            | 4.0.16; types workspace 3.2.4 | 4.1.12 everywhere | Node 22 supported; all Vitest peers aligned                             |
| `@vitest/ui`, `@vitest/coverage-v8` | 4.0.16                        | 4.1.12            | Exact peer match with Vitest                                            |
| `vite`                              | 7.3.0                         | 7.3.7             | Node >=22.12 supported by the tested Node 22.23.3                       |
| `@tanstack/router-plugin`           | 1.141.7                       | 1.168.46          | Requires React Router ^1.170.44                                         |
| `@tanstack/react-router`            | 1.141.6                       | 1.170.44          | Matches plugin; existing React/React DOM 19 satisfy peers               |
| `@electron/rebuild`                 | 4.0.2                         | 4.0.3             | Both versions require Node >=22.12                                      |
| `electron`                          | 39.2.7                        | 41.10.6           | Explicit major upgrade; see migration requirements below                |
| `electron-builder`                  | 26.0.12                       | 26.15.3           | Same major; removes vulnerable older native build/archive chains        |

The compatible lockfile refresh also updates vulnerable transitive packages,
including `proxy-addr`, `seroval`, `fast-xml-parser`, `fast-uri`,
`@hono/node-server`, `@xmldom/xmldom`, `lodash`, `qs`, `path-to-regexp`, `tar`,
Rollup, PostCSS, and glob/parser dependencies.

The npm 10.9.9 resolver crashed while generating the upgraded Vitest peer tree
(`Cannot read properties of null (reading 'edgesOut')`). Lockfile generation
used npm 11.21.1, whose engine supports Node >=22.9; both tools retain lockfile
version 3. The resulting lockfile installs successfully with the existing
**npm 10.9.9 `npm ci --ignore-scripts`**, and `node-pty` rebuild succeeds.

Actual Node 22 ESM loading caught a compatibility failure that type checking
and mocked provider tests cannot detect: the audit-recommended Copilot SDK
0.1.32 imports `vscode-jsonrpc/node` without its required `.js` extension.
That fails with `ERR_MODULE_NOT_FOUND`. SDK 0.2.2 corrects the import to
`vscode-jsonrpc/node.js`, retains the provider's session APIs, and loads
successfully under Node 22.23.3. It is an explicit 0.x minor change requiring
runtime-import, type, build and provider-suite validation; no dependency
files are patched after installation. The new server workspace command
`npm run check:runtime --workspace=apps/server` loads the actual SDK transport
entry points with Node's ESM resolver and passes for all eleven entry points.
It constructs no clients and makes no model/provider calls.

## Remaining findings and disposition

### Resolved Electron 39 findings: high

The original version and the latest 39.x patch, `electron@39.8.10`, are affected by:

- [GHSA-hq2x-r82h-9wj4](https://github.com/advisories/GHSA-hq2x-r82h-9wj4): popup sandbox inheritance.
- [GHSA-gr2m-v5gq-v685](https://github.com/advisories/GHSA-gr2m-v5gq-v685): child-window sandbox inheritance.
- [GHSA-j84w-jfhq-vhvj](https://github.com/advisories/GHSA-j84w-jfhq-vhvj): custom file/HTTP protocol cross-origin reads.
- [GHSA-9qh4-3jw8-366w](https://github.com/advisories/GHSA-9qh4-3jw8-366w): WebView worker Node integration.

The app's main window sets `contextIsolation: true` and `nodeIntegration: false`,
and its window-open handler denies new Electron windows. No WebView or
custom protocol handler was found in the Electron source. These facts narrow
the known exposure but do not prove immunity to all Chromium/Electron paths.
An explicit upgrade to Electron 41.10.6 clears these advisory ranges instead
of accepting an unpatched 39.x line.

### Resolved Electron download extraction findings: high

`electron -> extract-zip@2.0.1` is affected by
[GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) and
[GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3).
Malicious symlink archive entries can write outside the extraction directory.
There is no patched public `extract-zip` version in the available 2.x line.
This path is used to install Electron binaries; it is not an Automaker HTTP
request handler. Electron 41.10.6 replaces it with the maintained
`@electron-internal/extract-zip` package and removes both findings from the
lockfile.

### Desktop tooling proxy logger: moderate

[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) affects
`sprintf-js@1.1.3`: an unbounded precision specifier can exhaust resources.
The remaining path is
`electron-builder -> app-builder-lib -> @electron/get -> global-agent -> roarr -> sprintf-js`.
It propagates to eight package findings across the
`electron-builder` / `app-builder-lib` / DMG / Squirrel Windows tooling chains.
No patched `sprintf-js` 1.x exists in the registry. Replacing or overriding
its API without testing the parent tools is not an accepted fix.

### Electron version choice and required compatibility proof

Audit's broad recommendation is Electron 44.7.2. A smaller available candidate
is **Electron 41.10.6**, which this change explicitly pins: it clears the listed Electron ranges, depends on
`@electron/get@^5.0.0` (no `global-agent` logger chain), and uses the maintained
`@electron-internal/extract-zip` package. It supports the tested Node 22.23.3.
It is an explicit major upgrade, not a routine lockfile refresh.

The upstream [40/41 breaking changes](https://github.com/electron/electron/blob/main/docs/breaking-changes.md)
include renderer clipboard deprecation, macOS debug-symbol archive format,
PDF WebContents changes, cookie event-cause changes, and Linux hidden-file
dialog deprecation. The affected APIs were not found in Automaker's Electron
main/preload source. Compatibility validation must compile the Electron main
and preload bundles, package the desktop app, rebuild and exercise `node-pty`
against the Electron ABI, and smoke-test window loading, preload IPC, file
dialogs, external-link handling, and shutdown on supported platforms.

`electron-builder@26.15.3` independently pulls `@electron/get@4`; updating the
Electron runtime does not remove that moderate build-tool chain.
Investigate a supported parent update or a narrowly tested parent change.
Audit suggests 26.5.0, but a downgrade needs comparison against the security
fixes introduced after it and must not reintroduce previous high findings.

### Packaging and stable Node-API validation

The desktop packaging check exposed another real installation failure:
`prepare-server.mjs` copied complete workspace manifests into its standalone
server bundle. npm 10 still resolved the copied Vitest development peers under
`--omit=dev` and crashed in Arborist. Copied production manifests now omit
development dependencies and lifecycle scripts, and their internal
`@automaker/*` dependencies use relative sibling `file:` references. The
default npm 10 standalone install succeeds with 125 production packages and
no development packages; the repository manifests and audited root lockfile
remain authoritative for development.

The terminal is built from source during preparation, and a failed build
stops packaging. The pinned `node-pty@1.1.0-beta41` uses `node-addon-api` and
`NODE_API_MODULE` on Unix and Windows; it does not use a V8/NAN-specific ABI.
Its default Node-API version is 8. [Node-API ABI stability](https://nodejs.org/api/n-api.html#implications-of-abi-stability)
allows that artifact to run under both the Node 22 build host and Electron's
embedded Node runtime. An Electron-specific header compilation is unnecessary
for this pinned stable Node-API addon.

The `afterPack` hook copies that exact source-built native artifact into the
package and runs the **actual packaged executable** with
`ELECTRON_RUN_AS_NODE=1`. It verifies the expected Electron version, target
architecture and Node-API support, loads the packaged terminal, spawns a
shell, checks marker output and exit status, and fails the build on any
error or timeout. Different build/target operating systems or architectures
fail explicitly; there is no silent reuse of a foreign binary. Changing the
pinned terminal version requires reviewing this policy.

The Linux x64 runtime check passed with **Electron 41.10.6, Node 24.18.0,
module ABI 145 and Node-API 10**, including real PTY spawn/output/exit. This
proves compatibility with Electron's runtime rather than inferring it from a
TypeScript build or the host Node version. GUI interactions and Windows/macOS
packaging still require their platform-specific smoke tests before a desktop
release.

## Reproduction

```sh
npm ci --ignore-scripts
npm rebuild node-pty
npm run check:runtime --workspace=apps/server
npm audit --json
npm audit --omit=dev --json
npm audit --audit-level=high
npm run lint:lockfile
```

Both audit JSON results were captured before and after remediation. General
build, type, unit-test, lint and coverage results are recorded with the PR
validation results; audit success alone is not dependency compatibility proof.

The **pre-existing** unused `geist@1.5.1 -> next@>=13.2.0` peer dependency was
removed. The baseline lockfile already lacked Next, and no Geist
JavaScript/font entry point was imported. This avoids adding an unrelated
Next runtime to the Vite application. CSS custom property names containing
`geist` do not import that package.

## Production image dependency boundary

The Dockerfile now creates a separate locked production dependency stage with
`npm ci --omit=dev --ignore-scripts` and a native node-pty rebuild. It copies that
production dependency set into the image. Chromium is downloaded during the builder
stage and its cache copied separately, so the runtime does not need the development
Playwright installer, Electron, Vitest or Vite. All application/shared source needed
by the Dockerfile is retained.

A clean isolated production install and native rebuild passed, and all eleven
runtime import checks passed against it. Electron, Vitest and Vite were absent.
This validates the dependency set; a built container smoke test remains a separate
release prerequisite in this environment.
