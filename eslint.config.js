import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'eslint.config.js'] },
  js.configs.recommended,
  {
    files: ['server/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Business logic must use the injected Clock (see docs/DECISIONS.md).
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'Use the injected Clock, not new Date().' },
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Use the injected Clock, not Date.now().' },
      ],
    },
  },
  {
    // The Clock implementation itself and test code may read the real time.
    files: ['server/src/lib/clock.ts', 'server/tests/**/*.ts', 'server/scripts/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['client/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: { ...reactHooks.configs.recommended.rules },
  },
);
