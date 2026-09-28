import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['node_modules/**', 'dist/**', '.wrangler/**', 'drizzle/**'],
	},
	{
		files: ['src/**/*.ts'],
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		rules: {
			// Keep gradual typing violations visible in production code.
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
			'@typescript-eslint/no-unused-expressions': 'warn',
			'@typescript-eslint/no-non-null-asserted-optional-chain': 'warn',
			'@typescript-eslint/no-empty-object-type': 'warn',
			'preserve-caught-error': 'warn',
			'no-case-declarations': 'warn',
			'no-unassigned-vars': 'warn',
			'no-useless-assignment': 'warn',
		},
	},
	{
		// Test fakes may use loose external-SDK boundaries without manufacturing
		// generic adapter types solely for lint.
		files: ['src/tests/**/*.ts', 'src/**/*.test.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
);
