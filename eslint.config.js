import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/examples/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/{src,types}/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      'no-unused-vars': [
        'error',
        { varsIgnorePattern: '.*', args: 'none' }
      ]
    }
  }
)
