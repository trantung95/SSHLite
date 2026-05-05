/** @type {import('ts-jest').JestConfigWithTsJest} */
// Windows-client → Linux-server integration tests.
// Targets the multi-OS chaos stack on ports 2210-2214. The describe blocks
// inside windows-client.test.ts gate on process.platform === 'win32', so on
// non-Windows hosts the suite simply marks tests as skipped (containers are
// still brought up so the skip-path is itself exercised).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/windows-client.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^vscode$': '<rootDir>/src/__mocks__/vscode.ts',
  },
  globalSetup: '<rootDir>/test-docker/globalSetup.windows-client.ts',
  globalTeardown: '<rootDir>/test-docker/globalTeardown.windows-client.ts',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  transformIgnorePatterns: ['node_modules/(?!.*)'],
  testTimeout: 60000,
};
