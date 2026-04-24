/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/e2e'],
  testMatch: ['**/*.e2e.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Mock vscode module — required by SSHConnection and CommandGuard
  moduleNameMapper: {
    '^vscode$': '<rootDir>/src/__mocks__/vscode.ts',
  },
  // Transform TypeScript files with @swc/jest (fast)
  transform: {
    '^.+\\.ts$': ['@swc/jest', {
      jsc: {
        parser: {
          syntax: 'typescript',
          decorators: true,
        },
        target: 'es2020',
      },
      module: {
        type: 'commonjs',
      },
    }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!.*)',
  ],
  // E2E tests can be slow (real SSH + Docker) — generous timeout
  testTimeout: 60000,
};
