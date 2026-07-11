/**
 * Directory Management
 *
 * Manages the .solidkg/ directory structure for SolidKG data.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * SolidKG directory name
 */
export const SOLIDKG_DIR = ".solidkg";
const OWNERSHIP_MARKER = ".solidkg-owned";
const KNOWN_SOLIDKG_FILES = new Set([
  "solidkg.db",
  "solidkg.db-wal",
  "solidkg.db-shm",
  "solidkg.lock",
  "daemon.pid",
  "daemon.log",
  ".gitignore",
  OWNERSHIP_MARKER,
]);
const KNOWN_SOLIDKG_DIRS = new Set(["scip"]);

export interface SolidKGDirectoryOptions {
  dataDir?: string;
}

export interface ValidateDirectoryOptions {
  repair?: boolean;
}

const SOLIDKG_GITIGNORE_CONTENT = `# SolidKG local data directory
# Ignore every generated database/cache/runtime file in this directory.
*
`;

/**
 * Get the .solidkg directory path for a project
 */
export function getSolidKGDir(
  projectRoot: string,
  options: SolidKGDirectoryOptions = {},
): string {
  return options.dataDir
    ? path.resolve(options.dataDir)
    : path.join(projectRoot, SOLIDKG_DIR);
}

/**
 * Check if a project has been initialized with SolidKG
 * Requires both .solidkg/ directory AND solidkg.db to exist
 */
export function isInitialized(
  projectRoot: string,
  options: SolidKGDirectoryOptions = {},
): boolean {
  const solidkgDir = getSolidKGDir(projectRoot, options);
  if (!fs.existsSync(solidkgDir) || !fs.statSync(solidkgDir).isDirectory()) {
    return false;
  }
  // Must have solidkg.db, not just .solidkg folder
  const dbPath = path.join(solidkgDir, "solidkg.db");
  return fs.existsSync(dbPath);
}

/**
 * Find the nearest parent directory containing .solidkg/
 *
 * Walks up from the given path to find a SolidKG-initialized project,
 * similar to how git finds .git/ directories.
 *
 * @param startPath - Directory to start searching from
 * @returns The project root containing .solidkg/, or null if not found
 */
export function findNearestSolidKGRoot(
  startPath: string,
  options: SolidKGDirectoryOptions = {},
): string | null {
  if (options.dataDir) {
    const resolved = path.resolve(startPath);
    return isInitialized(resolved, options) ? resolved : null;
  }

  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (isInitialized(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  // Check root as well
  if (isInitialized(current)) {
    return current;
  }

  return null;
}

/**
 * Create the .solidkg directory structure
 * Note: Only throws if solidkg.db already exists, not just if .solidkg/ exists.
 */
export function createDirectory(
  projectRoot: string,
  options: SolidKGDirectoryOptions = {},
): void {
  const solidkgDir = getSolidKGDir(projectRoot, options);
  const dbPath = path.join(solidkgDir, "solidkg.db");

  // Only throw if SolidKG is actually initialized (db exists)
  // .solidkg/ folder alone is fine
  if (fs.existsSync(dbPath)) {
    throw new Error(`SolidKG already initialized in ${projectRoot}`);
  }

  // Create main directory (if it doesn't exist)
  fs.mkdirSync(solidkgDir, { recursive: true });

  // Create .gitignore inside .solidkg (if it doesn't exist)
  const gitignorePath = path.join(solidkgDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, SOLIDKG_GITIGNORE_CONTENT, "utf-8");
  }

  const markerPath = path.join(solidkgDir, OWNERSHIP_MARKER);
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        owner: "solidkg",
        projectRoot: path.resolve(projectRoot),
      }) + "\n",
      "utf-8",
    );
  }
}

export function ensureOwnershipMarker(
  projectRoot: string,
  options: SolidKGDirectoryOptions = {},
): void {
  const solidkgDir = getSolidKGDir(projectRoot, options);
  const markerPath = path.join(solidkgDir, OWNERSHIP_MARKER);
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        owner: "solidkg",
        projectRoot: path.resolve(projectRoot),
      }) + "\n",
      "utf-8",
    );
  }
}

/**
 * Remove the .solidkg directory
 */
export function removeDirectory(
  projectRoot: string,
  options: SolidKGDirectoryOptions = {},
): void {
  const solidkgDir = getSolidKGDir(projectRoot, options);

  if (!fs.existsSync(solidkgDir)) {
    return;
  }

  // Verify .solidkg is a real directory, not a symlink pointing elsewhere
  const lstat = fs.lstatSync(solidkgDir);
  if (lstat.isSymbolicLink()) {
    // Only remove the symlink itself, never follow it for recursive delete
    fs.unlinkSync(solidkgDir);
    return;
  }

  if (!lstat.isDirectory()) {
    // Not a directory - remove the single file
    fs.unlinkSync(solidkgDir);
    return;
  }

  const markerPath = path.join(solidkgDir, OWNERSHIP_MARKER);
  if (options.dataDir && !fs.existsSync(markerPath)) {
    throw new Error(
      `Refusing to remove external data directory without SolidKG ownership marker: ${solidkgDir}`,
    );
  }

  if (options.dataDir) {
    for (const entry of fs.readdirSync(solidkgDir, { withFileTypes: true })) {
      const entryPath = path.join(solidkgDir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (KNOWN_SOLIDKG_DIRS.has(entry.name))
          fs.rmSync(entryPath, { recursive: true, force: true });
        continue;
      }
      if (KNOWN_SOLIDKG_FILES.has(entry.name))
        fs.rmSync(entryPath, { force: true });
    }
    return;
  }

  // Recursively remove directory
  fs.rmSync(solidkgDir, { recursive: true, force: true });
}

/**
 * Get all files in the .solidkg directory
 */
export function listDirectoryContents(
  projectRoot: string,
  options: SolidKGDirectoryOptions = {},
): string[] {
  const solidkgDir = getSolidKGDir(projectRoot, options);

  if (!fs.existsSync(solidkgDir)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix: string = ""): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Skip symlinks to prevent following links outside .solidkg
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(solidkgDir);
  return files;
}

/**
 * Get the total size of the .solidkg directory in bytes
 */
export function getDirectorySize(
  projectRoot: string,
  options: SolidKGDirectoryOptions = {},
): number {
  const solidkgDir = getSolidKGDir(projectRoot, options);

  if (!fs.existsSync(solidkgDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip symlinks to prevent following links outside .solidkg
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        const stats = fs.statSync(fullPath);
        totalSize += stats.size;
      }
    }
  }

  walkDir(solidkgDir);
  return totalSize;
}

/**
 * Ensure a subdirectory exists within .solidkg
 */
export function ensureSubdirectory(
  projectRoot: string,
  subdirName: string,
  options: SolidKGDirectoryOptions = {},
): string {
  if (
    subdirName.includes("..") ||
    subdirName.includes(path.sep) ||
    subdirName.includes("/")
  ) {
    throw new Error(`Invalid subdirectory name: ${subdirName}`);
  }

  const subdirPath = path.join(getSolidKGDir(projectRoot, options), subdirName);

  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }

  return subdirPath;
}

/**
 * Check if the .solidkg directory has valid structure
 */
export function validateDirectory(
  projectRoot: string,
  options: SolidKGDirectoryOptions = {},
  validateOptions: ValidateDirectoryOptions = {},
): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const solidkgDir = getSolidKGDir(projectRoot, options);
  const repair = validateOptions.repair !== false;

  if (!fs.existsSync(solidkgDir)) {
    errors.push("SolidKG directory does not exist");
    return { valid: false, errors };
  }

  if (!fs.statSync(solidkgDir).isDirectory()) {
    errors.push(".solidkg exists but is not a directory");
    return { valid: false, errors };
  }

  const gitignorePath = path.join(solidkgDir, ".gitignore");
  if (repair && !fs.existsSync(gitignorePath)) {
    try {
      fs.writeFileSync(gitignorePath, SOLIDKG_GITIGNORE_CONTENT, "utf-8");
    } catch {
      // Non-fatal: warn but don't block
      errors.push(
        ".gitignore missing in .solidkg directory and could not be created",
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
