/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // Exclude Docker integration tests (run separately via jest.docker.config.js)
  testPathIgnorePatterns: ['/node_modules/', 'docker-ssh\\.test\\.ts', 'multi-os-ssh\\.test\\.ts', 'multios-.*\\.test\\.ts', 'chaos/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/extension.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // Mock vscode module
  moduleNameMapper: {
    '^vscode$': '<rootDir>/src/__mocks__/vscode.ts',
  },
  // Transform TypeScript files
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
    }],
  },
  // Ignore node_modules except for specific packages if needed
  transformIgnorePatterns: [
    'node_modules/(?!.*)',
  ],
};
