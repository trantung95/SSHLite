/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/docker-ssh.test.ts', '**/docker-ssh-tools.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // vscode mock required for SSH Tools service tests
  moduleNameMapper: {
    '^vscode$': '<rootDir>/src/__mocks__/vscode.ts',
  },
  // Global setup: start containers, wait for SSH
  globalSetup: '<rootDir>/test-docker/globalSetup.ts',
  // Global teardown: stop containers
  globalTeardown: '<rootDir>/test-docker/globalTeardown.ts',
  // Transform TypeScript files
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
    }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!.*)',
  ],
  // Longer timeout for Docker tests
  testTimeout: 60000,
};
