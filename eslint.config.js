// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Repo-wide lint. Beyond the usual recommended sets, this encodes a few of the
 * CLAUDE.md security invariants so they are enforced mechanically:
 *  - rule 1: no Math.random anywhere (secrets come from crypto.randomBytes)
 *  - rule 5: no innerHTML / outerHTML / insertAdjacentHTML with user-influenced content
 *  - rule 6: no eval / Function constructor (would need 'unsafe-eval' in CSP)
 */
export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/drizzle/meta/**', '**/playwright-report/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Not cryptographically secure. Use crypto.randomBytes / crypto.randomUUID (CLAUDE.md rule 1).',
        },
        { property: 'innerHTML', message: 'Use textContent / DOM APIs (CLAUDE.md rule 5).' },
        { property: 'outerHTML', message: 'Use textContent / DOM APIs (CLAUDE.md rule 5).' },
        {
          property: 'insertAdjacentHTML',
          message: 'Use textContent / DOM APIs (CLAUDE.md rule 5).',
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['web/**/*.ts', 'extension/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
