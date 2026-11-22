import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 轻量 ESLint 基线：先守住会导致真实错误的规则，不引入格式化噪音。
 * 类型检查由 tsc 负责；这里专注解析器能直接发现的死角。
 */
export default [
  {
    ignores: ['dist/**', 'release/**', 'node_modules/**', 'artifacts/**']
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      }
    },
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-unsafe-finally': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error'
    }
  }
];
