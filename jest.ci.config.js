/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/integration/multios-connection.test.ts',
    '**/integration/multios-auth.test.ts',
    '**/integration/multios-fileops.test.ts',
    '**/integration/multios-monitor.test.ts',
    '**/integration/multios-commandguard.test.ts',
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Map vscode to mock since extension classes import vscode
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
  // Longer timeout: multi-OS + extension logic tests
  testTimeout: 120000,
};
