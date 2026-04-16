module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  ignorePatterns: ['dist/', 'node_modules/', 'test/'],
  rules: {
    // Allow `any` types throughout the codebase
    '@typescript-eslint/no-explicit-any': 'off',

    // Allow unused vars if prefixed with underscore
    '@typescript-eslint/no-unused-vars': ['warn', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    }],

    // Allow empty functions (common in stubs/defaults)
    '@typescript-eslint/no-empty-function': 'off',

    // Allow require() imports
    '@typescript-eslint/no-var-requires': 'off',

    // Downgrade common rules to warnings instead of errors
    '@typescript-eslint/no-inferrable-types': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@typescript-eslint/ban-ts-comment': 'warn',
    '@typescript-eslint/ban-types': 'warn',
    '@typescript-eslint/no-empty-interface': 'warn',
    '@typescript-eslint/no-namespace': 'warn',

    // Standard ESLint rules relaxed
    'no-console': 'off',
    'prefer-const': 'warn',
    'no-empty': ['warn', { allowEmptyCatch: true }],
  },
};
