/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/docker-ssh.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // No vscode mock needed for Docker tests
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
