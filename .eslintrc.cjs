module.exports = {
  root: true,
  env: { es2022: true, node: true },
  extends: ['eslint:recommended', 'prettier'],
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'server/dist/',
    'web/dist/',
    'data/',
    'storage/',
    'coverage/',
  ],
  overrides: [
    {
      files: ['server/src/**/*.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: { sourceType: 'module' },
      plugins: ['@typescript-eslint'],
      extends: ['plugin:@typescript-eslint/recommended', 'prettier'],
    },
    {
      files: ['web/src/**/*.{ts,tsx}', 'web/vite.config.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: { sourceType: 'module', ecmaFeatures: { jsx: true } },
      plugins: ['@typescript-eslint', 'react-hooks'],
      extends: ['plugin:@typescript-eslint/recommended', 'plugin:react-hooks/recommended', 'prettier'],
      env: { browser: true, node: false },
    },
  ],
};
