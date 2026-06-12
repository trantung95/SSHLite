/** @type {import('ts-jest').JestConfigWithTsJest} */
// Isolated config for the native-search-tools integration suite (ports 2207/2208).
// Run with: npm run test:docker:search-tools  (requires Docker Desktop running)
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/docker-ssh-search-tools.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^vscode$': '<rootDir>/src/__mocks__/vscode.ts',
  },
  globalSetup: '<rootDir>/test-docker/globalSetup.search-tools.ts',
  globalTeardown: '<rootDir>/test-docker/globalTeardown.search-tools.ts',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  transformIgnorePatterns: ['node_modules/(?!.*)'],
  testTimeout: 60000,
};
