/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // Exclude Docker integration tests (run separately via jest.docker.config.js)
  testPathIgnorePatterns: ['/node_modules/', 'docker-ssh.*\\.test\\.ts', 'multi-os-ssh\\.test\\.ts', 'multios-.*\\.test\\.ts', 'chaos/'],
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
  // Transform TypeScript files with @swc/jest (3-5x faster than ts-jest)
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
  // Ignore node_modules except for specific packages if needed
  transformIgnorePatterns: [
    'node_modules/(?!.*)',
  ],
  // Limit workers to avoid overwhelming the system (50% of CPUs)
  maxWorkers: '50%',
};
