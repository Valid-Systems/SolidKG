import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
const repoRoot = path.join(__dirname, '..');

describe('native parser runtime', () => {
  it('does not retain the obsolete WASM relaunch module', () => {
    expect(fs.existsSync(path.join(repoRoot, 'src', 'extraction', 'wasm-runtime-flags.ts'))).toBe(false);
  });

  it('launches the CLI without WASM-only V8 flags', () => {
    const launchSurfaces = [
      'scripts/build-bundle.sh',
      'scripts/npm-shim.js',
      'src/bin/solidkg.ts',
      'src/installer/targets/shared.ts',
    ];

    for (const relativePath of launchSurfaces) {
      const content = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(content, relativePath).not.toContain('--liftoff-only');
    }
  });
});
