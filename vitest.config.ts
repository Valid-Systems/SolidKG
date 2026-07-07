import { defineConfig } from 'vitest/config';
import { WASM_RUNTIME_FLAGS } from './src/extraction/wasm-runtime-flags';

const workerExecArgv = [
  ...WASM_RUNTIME_FLAGS,
  ...process.execArgv.filter((arg) => !WASM_RUNTIME_FLAGS.includes(arg)),
];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    pool: 'forks',
    execArgv: workerExecArgv,
    minWorkers: 1,
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
