import * as fs from 'fs';
import * as crypto from 'crypto';

const TEMPORARY_NAME_ATTEMPTS = 8;
const RENAME_RETRY_DELAYS_MS = [25, 50, 100, 150, 150, 150, 150] as const;
const RENAME_ATTEMPTS = RENAME_RETRY_DELAYS_MS.length + 1;

type AlreadyExistsError = Error & { readonly code: 'EEXIST' };
type TransientRenameError = Error & { readonly code: 'EACCES' | 'EBUSY' | 'EPERM' };

function isAlreadyExistsError(error: unknown): error is AlreadyExistsError {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isTransientRenameError(error: unknown): error is TransientRenameError {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EACCES' || error.code === 'EBUSY' || error.code === 'EPERM')
  );
}

function sleepSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function removeOwnedTemporary(temporaryPath: string): void {
  try {
    fs.rmSync(temporaryPath, { force: true });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : 'unknown';
    console.error('[SolidKG] Could not remove owned lifecycle temporary file', { code });
  }
}

function writeTemporaryFile(diagnosticPath: string, contents: string): string {
  let collisionError: AlreadyExistsError | undefined;
  for (let attempt = 0; attempt < TEMPORARY_NAME_ATTEMPTS; attempt += 1) {
    const temporaryPath = `${diagnosticPath}.${crypto.randomBytes(16).toString('hex')}.tmp`;
    let fileDescriptor: number;
    try {
      fileDescriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        collisionError = error;
        continue;
      }
      throw error;
    }

    let writeError: unknown;
    let hasWriteError = false;
    try {
      fs.writeFileSync(fileDescriptor, contents, 'utf8');
    } catch (error) {
      writeError = error;
      hasWriteError = true;
    } finally {
      try {
        fs.closeSync(fileDescriptor);
      } catch (error) {
        if (!hasWriteError) {
          writeError = error;
          hasWriteError = true;
        }
      }
    }

    if (hasWriteError) {
      removeOwnedTemporary(temporaryPath);
      throw writeError;
    }
    return temporaryPath;
  }

  if (collisionError) throw collisionError;
  throw new Error('Temporary diagnostic file creation did not run');
}

export function writeAtomicLifecycleFile(diagnosticPath: string, contents: string): void {
  let temporaryPath: string | undefined;
  try {
    temporaryPath = writeTemporaryFile(diagnosticPath, contents);
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
      try {
        fs.renameSync(temporaryPath, diagnosticPath);
        return;
      } catch (error) {
        const delay = RENAME_RETRY_DELAYS_MS[attempt];
        if (!isTransientRenameError(error) || delay === undefined) throw error;
        sleepSynchronously(delay);
      }
    }
  } catch (error) {
    if (temporaryPath) removeOwnedTemporary(temporaryPath);
    throw error;
  }
}
