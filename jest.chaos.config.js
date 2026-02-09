/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/chaos/chaos.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  globalSetup: '<rootDir>/test-docker/globalSetup.chaos.ts',
  globalTeardown: '<rootDir>/test-docker/globalTeardown.chaos.ts',
  // Chaos tests need vscode mock for ActivityService, CommandGuard, etc.
  moduleNameMapper: {
    '^vscode$': '<rootDir>/src/__mocks__/vscode.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
    }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!.*)',
  ],
  // Quick mode: 360s, deep mode: 900s (controlled via CHAOS_TIMEOUT env var)
  testTimeout: parseInt(process.env.CHAOS_TIMEOUT || '360000', 10),
};
