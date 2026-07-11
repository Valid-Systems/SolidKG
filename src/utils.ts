/**
 * SolidKG Utilities
 *
 * Common utility functions for memory management, concurrency, batching,
 * and security validation.
 *
 * @module utils
 *
 * @example
 * ```typescript
 * import { Mutex, processInBatches, MemoryMonitor, validatePathWithinRoot } from 'solidkg';
 *
 * // Use mutex for concurrent safety
 * const mutex = new Mutex();
 * await mutex.withLock(async () => {
 *   await performCriticalOperation();
 * });
 *
 * // Process items in batches to manage memory
 * const results = await processInBatches(items, 100, async (item) => {
 *   return await processItem(item);
 * });
 *
 * // Monitor memory usage
 * const monitor = new MemoryMonitor(512, (usage) => {
 *   console.warn(`Memory usage exceeded 512MB: ${usage / 1024 / 1024}MB`);
 * });
 * monitor.start();
 * ```
 */

import * as fs from "fs";
import * as path from "path";

// ============================================================
// SECURITY UTILITIES
// ============================================================

/**
 * Sensitive system directories that should never be used as project roots.
 * Checked on all platforms; non-applicable paths are harmlessly skipped.
 */
const SENSITIVE_PATHS = new Set([
  "/",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/tmp",
  "/dev",
  "/proc",
  "/sys",
  "/root",
  "/boot",
  "/lib",
  "/lib64",
  "/opt",
  "c:\\",
  "c:\\windows",
  "c:\\windows\\system32",
]);

/**
 * Validate that a resolved file path stays within the project root.
 * Prevents path traversal attacks (e.g. node.filePath = "../../etc/passwd").
 *
 * @param projectRoot - The project root directory
 * @param filePath - The relative file path to validate
 * @returns The resolved absolute path, or null if it escapes the root
 */
export function validatePathWithinRoot(
  projectRoot: string,
  filePath: string,
): string | null {
  const resolved = path.resolve(projectRoot, filePath);
  const normalizedRoot = path.resolve(projectRoot);

  if (
    !resolved.startsWith(normalizedRoot + path.sep) &&
    resolved !== normalizedRoot
  ) {
    return null;
  }
  return resolved;
}

/**
 * Validate that a path is a safe project root directory.
 *
 * Rejects sensitive system directories and ensures the path is
 * a real, existing directory. Used at MCP and API entry points
 * to prevent arbitrary directory access.
 *
 * @param dirPath - The path to validate
 * @returns An error message if invalid, or null if valid
 */
export function validateProjectPath(dirPath: string): string | null {
  const resolved = path.resolve(dirPath);

  // Block sensitive system directories
  if (
    SENSITIVE_PATHS.has(resolved) ||
    SENSITIVE_PATHS.has(resolved.toLowerCase())
  ) {
    return `Refusing to operate on sensitive system directory: ${resolved}`;
  }

  // Also block common sensitive home subdirectories
  const homeDir = require("os").homedir();
  const sensitiveHomeDirs = [".ssh", ".gnupg", ".aws", ".config"];
  for (const dir of sensitiveHomeDirs) {
    const sensitivePath = path.join(homeDir, dir);
    if (
      resolved === sensitivePath ||
      resolved.startsWith(sensitivePath + path.sep)
    ) {
      return `Refusing to operate on sensitive directory: ${resolved}`;
    }
  }

  // Verify it's a real directory
  try {
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      return `Path is not a directory: ${resolved}`;
    }
  } catch {
    return `Path does not exist or is not accessible: ${resolved}`;
  }

  return null;
}

/**
 * Check if a file path resolves to a location within the given root directory.
 *
 * Prevents path traversal attacks by ensuring the resolved absolute path
 * starts with the resolved root path. Handles '..' sequences, symlink-like
 * relative paths, and platform-specific separators.
 *
 * @param filePath - The path to check (can be relative or absolute)
 * @param rootDir - The root directory that filePath must stay within
 * @returns true if filePath resolves to a location within rootDir
 */
function isPathWithinRoot(filePath: string, rootDir: string): boolean {
  const resolvedPath = path.resolve(rootDir, filePath);
  const resolvedRoot = path.resolve(rootDir);
  return (
    resolvedPath.startsWith(resolvedRoot + path.sep) ||
    resolvedPath === resolvedRoot
  );
}

/**
 * Like isPathWithinRoot but also resolves symlinks via fs.realpathSync.
 *
 * This catches symlink escapes where the logical path appears to be within
 * root but the real path on disk points elsewhere. Falls back to logical
 * path checking if realpath resolution fails (e.g. broken symlink).
 */
export function isPathWithinRootReal(
  filePath: string,
  rootDir: string,
): boolean {
  // First do the cheap logical check
  if (!isPathWithinRoot(filePath, rootDir)) {
    return false;
  }

  // Then verify with realpath to catch symlink escapes
  try {
    const realPath = fs.realpathSync(path.resolve(rootDir, filePath));
    const realRoot = fs.realpathSync(rootDir);
    return realPath.startsWith(realRoot + path.sep) || realPath === realRoot;
  } catch {
    // If realpath fails (broken symlink, permissions), fall back to logical check
    return true;
  }
}

/**
 * Safely parse JSON with a fallback value.
 * Prevents crashes from corrupted database metadata.
 */
export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Clamp a numeric value to a range.
 * Used to enforce sane limits on MCP tool inputs.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Normalize a file path to use forward slashes.
 * Fixes Windows backslash paths so glob matching works consistently.
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function pathMatchesRootAwarePrefix(
  filePath: string,
  pathPrefix: string,
): boolean {
  const normalizedFile = normalizePath(filePath)
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  const normalizedPrefix = normalizePath(pathPrefix)
    .replace(/^\.\//, "")
    .replace(/^\/+/g, "")
    .replace(/\/$/, "");
  if (!normalizedPrefix || normalizedPrefix === ".") return true;
  if (
    normalizedFile === normalizedPrefix ||
    normalizedFile.startsWith(`${normalizedPrefix}/`)
  )
    return true;
  if (normalizedPrefix.startsWith("@")) return false;
  const rootlessFile = normalizedFile.replace(/^@[^/]+\//, "");
  return (
    rootlessFile === normalizedPrefix ||
    rootlessFile.startsWith(`${normalizedPrefix}/`)
  );
}

/**
 * Cross-process file lock using a lock file with PID tracking.
 *
 * Prevents multiple processes (e.g., git hooks, CLI, MCP server) from
 * writing to the same database simultaneously.
 */
export class FileLock {
  private lockPath: string;
  private held = false;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  /**
   * Acquire the lock. Throws if the lock is held by another live process.
   */
  acquire(): void {
    // Check for existing lock
    if (fs.existsSync(this.lockPath)) {
      try {
        const content = fs.readFileSync(this.lockPath, "utf-8").trim();
        const pid = parseInt(content, 10);

        if (!isNaN(pid) && this.isProcessAlive(pid)) {
          throw new Error(
            `SolidKG database is locked by another process (PID ${pid}). ` +
              `If this is stale, run 'solidkg unlock' or delete ${this.lockPath}`,
          );
        }

        fs.unlinkSync(this.lockPath);
      } catch (err) {
        if (err instanceof Error && err.message.includes("locked by another")) {
          throw err;
        }
        // Other errors reading lock file - try to remove it
        try {
          fs.unlinkSync(this.lockPath);
        } catch {
          /* ignore */
        }
      }
    }

    // Write our PID to the lock file using exclusive create flag
    try {
      fs.writeFileSync(this.lockPath, String(process.pid), { flag: "wx" });
      this.held = true;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        // Race condition: another process grabbed the lock between our check and write
        throw new Error(
          "SolidKG database is locked by another process. " +
            `If this is stale, run 'solidkg unlock' or delete ${this.lockPath}`,
        );
      }
      throw err;
    }
  }

  /**
   * Release the lock
   */
  release(): void {
    if (!this.held) return;
    try {
      // Only remove if we still own it (check PID)
      const content = fs.readFileSync(this.lockPath, "utf-8").trim();
      if (parseInt(content, 10) === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Lock file already gone - that's fine
    }
    this.held = false;
  }

  /**
   * Execute a function while holding the lock
   */
  withLock<T>(fn: () => T): T {
    this.acquire();
    try {
      return fn();
    } finally {
      this.release();
    }
  }

  /**
   * Execute an async function while holding the lock
   */
  async withLockAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Check if a process is still running
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Process items in batches to manage memory
 *
 * @param items - Array of items to process
 * @param batchSize - Number of items per batch
 * @param processor - Function to process each item
 * @param onBatchComplete - Optional callback after each batch
 * @returns Array of results
 */
export async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T, index: number) => Promise<R>,
  onBatchComplete?: (completed: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, Math.min(i + batchSize, items.length));
    const batchResults = await Promise.all(
      batch.map((item, idx) => processor(item, i + idx)),
    );
    results.push(...batchResults);

    if (onBatchComplete) {
      onBatchComplete(Math.min(i + batchSize, items.length), items.length);
    }

    // Allow GC between batches
    if (global.gc) {
      global.gc();
    }
  }

  return results;
}

/**
 * Simple mutex lock for preventing concurrent operations
 */
export class Mutex {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  /**
   * Acquire the lock
   *
   * @returns A release function to call when done
   */
  async acquire(): Promise<() => void> {
    while (this.locked) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }

    this.locked = true;

    return () => {
      this.locked = false;
      const next = this.waitQueue.shift();
      if (next) {
        next();
      }
    };
  }

  /**
   * Execute a function while holding the lock
   */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Check if the lock is currently held
   */
  isLocked(): boolean {
    return this.locked;
  }
}

/**
 * Debounce a function
 *
 * @param fn - Function to debounce
 * @param delay - Delay in milliseconds
 * @returns Debounced function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Throttle a function
 *
 * @param fn - Function to throttle
 * @param limit - Minimum time between calls in milliseconds
 * @returns Throttled function
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number,
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = limit - (now - lastCall);

    if (remaining <= 0) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      lastCall = now;
      fn(...args);
    } else if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        timeoutId = null;
        fn(...args);
      }, remaining);
    }
  };
}

/**
 * Memory monitor for tracking usage during operations
 */
export class MemoryMonitor {
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private peakUsage = 0;
  private threshold: number;
  private onThresholdExceeded?: (usage: number) => void;

  constructor(
    thresholdMB: number = 500,
    onThresholdExceeded?: (usage: number) => void,
  ) {
    this.threshold = thresholdMB * 1024 * 1024;
    this.onThresholdExceeded = onThresholdExceeded;
  }

  /**
   * Start monitoring memory usage
   */
  start(intervalMs: number = 1000): void {
    this.stop();
    this.peakUsage = 0;

    this.checkInterval = setInterval(() => {
      const usage = process.memoryUsage().heapUsed;
      if (usage > this.peakUsage) {
        this.peakUsage = usage;
      }
      if (usage > this.threshold && this.onThresholdExceeded) {
        this.onThresholdExceeded(usage);
      }
    }, intervalMs);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Get peak memory usage in bytes
   */
  getPeakUsage(): number {
    return this.peakUsage;
  }

  /**
   * Get current memory usage in bytes
   */
  getCurrentUsage(): number {
    return process.memoryUsage().heapUsed;
  }
}
