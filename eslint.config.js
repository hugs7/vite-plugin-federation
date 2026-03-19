import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/examples/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/{src,types}/**/*.{ts,js}'],
    languageOptions: {
      globals: {
        console: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', args: 'none', caughtErrors: 'none' }
      ],
      'no-useless-assignment': 'off'
    }
  }
)
