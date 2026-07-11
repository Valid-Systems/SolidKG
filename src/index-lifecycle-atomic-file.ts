import * as fs from 'fs';
import * as crypto from 'crypto';

const TEMPORARY_FILE_ATTEMPTS = 8;

type AlreadyExistsError = Error & { readonly code: 'EEXIST' };

function isAlreadyExistsError(error: unknown): error is AlreadyExistsError {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function removeOwnedTemporary(temporaryPath: string): void {
  try {
    fs.rmSync(temporaryPath, { force: true });
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
}

function writeTemporaryFile(diagnosticPath: string, contents: string): string {
  let collisionError: AlreadyExistsError | undefined;
  for (let attempt = 0; attempt < TEMPORARY_FILE_ATTEMPTS; attempt += 1) {
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
    fs.renameSync(temporaryPath, diagnosticPath);
  } catch (error) {
    if (temporaryPath) removeOwnedTemporary(temporaryPath);
    throw error;
  }
}
