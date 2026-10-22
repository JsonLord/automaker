const fs = require('fs');
let code = fs.readFileSync('apps/server/tests/unit/routes/projects/import-github.test.ts', 'utf8');

// Using vi.hoisted is correct but vitest executes vi.mock first before the variables are fully bound in some cases,
// or I can just use inline returns without variables.
code = code.replace(
  `const mocks = vi.hoisted(() => {
  return {
    argusServiceMock: {
      start: vi.fn().mockResolvedValue(undefined),
      createOrResolveProject: vi.fn().mockResolvedValue({}),
      getStatus: vi.fn().mockResolvedValue({ automakerProjectId: 'test-id', argusProjectId: 'argus-id' })
    },
    autonomyRunnerMock: { register: vi.fn() }
  };
});

vi.mock('../../../../src/services/argus/runtime.js', () => ({
  argusService: mocks.argusServiceMock
}));

vi.mock('../../../../src/services/argus/autonomy-runtime.js', () => ({
  getArgusAutonomyRunner: vi.fn(() => mocks.autonomyRunnerMock)
}));`,
  `const { argusServiceMock, autonomyRunnerMock } = vi.hoisted(() => ({
    argusServiceMock: {
      start: vi.fn().mockResolvedValue(undefined),
      createOrResolveProject: vi.fn().mockResolvedValue({}),
      getStatus: vi.fn().mockResolvedValue({ automakerProjectId: 'test-id', argusProjectId: 'argus-id' })
    },
    autonomyRunnerMock: { register: vi.fn() }
  }));

vi.mock('../../../../src/services/argus/runtime.js', () => ({
  argusService: argusServiceMock
}));

vi.mock('../../../../src/services/argus/autonomy-runtime.js', () => ({
  getArgusAutonomyRunner: vi.fn(() => autonomyRunnerMock)
}));`
);

// we also need to fix our references inside tests to not use "mocks.argusServiceMock"
code = code.replace(/mocks\.argusServiceMock/g, 'argusServiceMock');
code = code.replace(/mocks\.autonomyRunnerMock/g, 'autonomyRunnerMock');

fs.writeFileSync('apps/server/tests/unit/routes/projects/import-github.test.ts', code);
