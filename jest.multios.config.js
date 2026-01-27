/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/multi-os-ssh.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  globalSetup: '<rootDir>/test-docker/globalSetup.multios.ts',
  globalTeardown: '<rootDir>/test-docker/globalTeardown.multios.ts',
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
    }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!.*)',
  ],
  // Longer timeout: multi-OS tests may be slower (especially first run)
  testTimeout: 120000,
};
