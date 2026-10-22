import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'docs/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    // Portability rule (technical-structure.md): only platforms/ and cli/ may use Node APIs.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/platforms/**', 'src/cli/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'Node APIs only in platforms/ and cli/' }] },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Pass config in; no process outside platforms/ and cli/' },
      ],
    },
  },
)
