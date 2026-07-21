import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildNodeTooOldBanner, MIN_NODE_MAJOR } from '../src/bin/node-version-check';

describe('buildNodeTooOldBanner', () => {
  it('embeds the reported Node version in the header', () => {
    expect(buildNodeTooOldBanner('18.20.0')).toContain(
      'Unsupported Node.js version: 18.20.0'
    );
  });

  it('states the supported floor matching MIN_NODE_MAJOR', () => {
    expect(MIN_NODE_MAJOR).toBe(24);
    expect(buildNodeTooOldBanner('22.4.0')).toContain(
      `requires Node.js ${MIN_NODE_MAJOR} or newer`
    );
  });

  it('keeps package engines aligned with the CLI source runtime floor', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    expect(packageJson.engines?.node).toBe('>=24.0.0');
  });

  it('points users to Node 24 LTS via nvm and Homebrew', () => {
    const banner = buildNodeTooOldBanner('16.0.0');
    expect(banner).toContain('Node.js 24 LTS');
    expect(banner).toContain('nvm install 24');
    expect(banner).toContain('brew install node@24');
  });

  it('documents the SOLIDKG_ALLOW_UNSAFE_NODE override', () => {
    expect(buildNodeTooOldBanner('18.0.0')).toContain('SOLIDKG_ALLOW_UNSAFE_NODE=1');
  });
});
