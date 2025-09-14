import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      // Dependencies
      'node_modules/**',
      '.pnpm-store/**',
      // Build outputs
      'dist/**',
      'build/**',
      '.next/**',
      'out/**',
      // Generated files
      'wasm/**',
      'drizzle/**',
      'next-env.d.ts',
      // Test outputs
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      // Cache
      '.cache/**',
      '.turbo/**',
      // Database
      'data/**',
      '*.db',
      '*.sqlite',
      // Deployment
      '.vercel/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];