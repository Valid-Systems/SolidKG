/**
 * Lowest supported Node.js major version. Matches the `engines` floor in
 * package.json. Below this, SolidKG relies on language features / native APIs
 * that aren't present, and the combination is untested. `engines` alone only
 * *warns* on install (unless the user set `engine-strict`), so the CLI bootstrap
 * also hard-blocks here to actually enforce the floor.
 */
export const MIN_NODE_MAJOR = 24;

/**
 * Build the bordered banner shown when SolidKG detects a Node.js major below
 * {@link MIN_NODE_MAJOR}. Pinned via unit test so the recovery commands and the
 * override env var can't be silently stripped by future edits.
 *
 * Uses ASCII glyphs to stay readable on Windows OEM-codepage consoles
 * (see ../ui/glyphs.ts for the rationale).
 */
export function buildNodeTooOldBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[SolidKG] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    `SolidKG requires Node.js ${MIN_NODE_MAJOR} or newer. Older versions lack`,
    'language features and native APIs SolidKG depends on, and are not',
    'tested or supported.',
    '',
    'Fix: install Node.js 24 LTS:',
    '  nvm install 24 && nvm use 24                          # nvm',
    '  brew install node@24 && brew link --overwrite --force node@24  # Homebrew',
    '',
    'To override (NOT recommended - unsupported):',
    '  SOLIDKG_ALLOW_UNSAFE_NODE=1 solidkg ...',
    sep,
  ].join('\n');
}
