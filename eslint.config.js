// Lint rules chosen for the bugs this codebase actually produces, not for style.
//
// The one that earns its keep is `no-use-before-define`. A hook's dependency
// array is evaluated while the component renders, so naming something declared
// further down the file throws "Cannot access X before initialization" and
// blanks the whole page — and `vite build` compiles it happily every time. It
// has happened three times here.

import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,

      // The rule this config exists for. `functions: false` because component
      // declarations legitimately sit below the component that renders them;
      // `variables: true` is what catches the dependency-array case.
      'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],

      // A stale dependency gives a handler that silently acts on old state,
      // which is a bug that looks like a race. Worth an error, not a warning.
      'react-hooks/exhaustive-deps': 'error',

      // This codebase passes data through props deliberately and has no
      // prop-types; the rule would be pure noise.
      'react/prop-types': 'off',

      // Apostrophes in ordinary prose — "doesn't", "shop's" — render correctly
      // and reading &apos; in a sentence is worse than the thing it prevents.
      'react/no-unescaped-entities': 'off',
    },
  },
]
