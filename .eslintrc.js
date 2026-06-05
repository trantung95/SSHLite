// ESLint config for SSH Lite.
//
// ESLint 8.x (classic eslintrc format) with @typescript-eslint v6. `npm run lint`
// lints `src` only (TypeScript). No type-aware rules (no parserOptions.project)
// so it stays fast and needs no full type-check pass.
//
// Several rules are relaxed because the codebase leans on those patterns by
// design (see comments + CLAUDE.md). The goal is a useful, green lint gate, not
// a churn of unrelated files.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2021, sourceType: 'module' },
  env: { node: true, es2021: true },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    // The codebase deliberately uses `any` / non-null `!` in mocks, webview
    // bridges, and VS Code API glue.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-inferrable-types': 'off',
    '@typescript-eslint/ban-ts-comment': 'warn',
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
    ],
    // Guarded `while (true) { … }` loops (with a max-iteration / parent break)
    // are an established pattern here; only flag constant conditions outside loops.
    'no-constant-condition': ['error', { checkLoops: false }],
    // Empty catch is used deliberately for best-effort cleanup.
    'no-empty': ['error', { allowEmptyCatch: true }],
    // A few service switch statements declare block-scoped locals without wrapping
    // braces; safe here and not worth churning unrelated files.
    'no-case-declarations': 'off',
    'no-control-regex': 'off',
    'no-regex-spaces': 'off',
  },
  overrides: [
    {
      // Test + mock files: @swc/jest does NOT hoist const/let into jest.mock()
      // factories, so `var` mock variables are REQUIRED (see CLAUDE.md "Testing").
      files: ['**/*.test.ts', 'src/__mocks__/**/*.ts', 'src/__tests__/**/*.ts'],
      rules: { 'no-var': 'off' },
    },
  ],
};
