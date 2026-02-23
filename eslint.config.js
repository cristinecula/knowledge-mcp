import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['build/', 'node_modules/'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow unused vars prefixed with _ (common pattern for intentionally unused params)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Relax rules for test files — tests often need type flexibility
    files: ['src/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
