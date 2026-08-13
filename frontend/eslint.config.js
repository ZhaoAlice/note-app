import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-globals': [
        'error',
        { name: 'alert', message: '请使用应用内弹窗组件。' },
        { name: 'confirm', message: '请使用 ConfirmDialog。' },
        { name: 'prompt', message: '请使用应用内表单弹窗。' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'alert', message: '请使用应用内弹窗组件。' },
        { object: 'window', property: 'confirm', message: '请使用 ConfirmDialog。' },
        { object: 'window', property: 'prompt', message: '请使用应用内表单弹窗。' },
      ],
    },
  },
)
