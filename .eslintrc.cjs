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
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            // 实证背景：better-sqlite3 驱动共享单连接，裸 .transaction( 并发会嵌套 SAVEPOINT，
            // 内层「提交」不保证持久化、内层回滚静默误删外层数据（tx-probe 已实证）。
            // 一切写事务必须经 server/src/common/transaction.ts 的 runInTransaction。
            selector: "CallExpression > MemberExpression[property.name='transaction']",
            message:
              '禁止裸 .transaction( 调用：better-sqlite3 共享单连接会嵌套 SAVEPOINT（已实证内层回滚误删外层数据），一切写事务必须经 common/transaction.ts 的 runInTransaction。',
          },
        ],
      },
    },
    {
      // 唯一豁免：互斥入口实现自身
      files: ['server/src/common/transaction.ts'],
      rules: { 'no-restricted-syntax': 'off' },
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
