import { describe, expect, it } from 'vitest';
import { hiddenExecFileSyncOptions, hiddenSpawnOptions, hiddenSpawnSyncOptions } from '../src/platform/child-process';

describe('hidden child process options', () => {
  it.runIf(process.platform === 'win32')('hide console windows for sync git and lifecycle subprocesses on Windows', () => {
    expect(hiddenExecFileSyncOptions({ cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).windowsHide).toBe(true);
    expect(hiddenSpawnOptions({ cwd: process.cwd(), shell: false, stdio: 'ignore' }).windowsHide).toBe(true);
    expect(hiddenSpawnSyncOptions({ stdio: 'inherit' }).windowsHide).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('keeps a consistent option shape for cross-platform call sites', () => {
    expect(hiddenExecFileSyncOptions({ cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).windowsHide).toBe(true);
  });
});
