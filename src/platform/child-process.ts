import type { ExecFileSyncOptionsWithStringEncoding, SpawnOptions, SpawnSyncOptions } from 'child_process';

export type HiddenExecFileSyncOptions = ExecFileSyncOptionsWithStringEncoding & { windowsHide: true };
export type HiddenSpawnOptions = SpawnOptions & { windowsHide: true };
export type HiddenSpawnSyncOptions = SpawnSyncOptions & { windowsHide: true };

export function hiddenExecFileSyncOptions(options: ExecFileSyncOptionsWithStringEncoding): HiddenExecFileSyncOptions {
  return { ...options, windowsHide: true };
}

export function hiddenSpawnOptions(options: SpawnOptions): HiddenSpawnOptions {
  return { ...options, windowsHide: true };
}

export function hiddenSpawnSyncOptions(options: SpawnSyncOptions): HiddenSpawnSyncOptions {
  return { ...options, windowsHide: true };
}
