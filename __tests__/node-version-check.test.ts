/**
 * Pin the Node-25 block banner content. The banner replaced a soft
 * `console.warn` because the warning was scrolling off-screen before
 * the OOM crash 30 seconds later, generating duplicate bug reports
 * (#54, #81, #140). The recipe and override env var below are
 * load-bearing — if any of them get edited away, this test catches it.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildNode25BlockBanner, buildNodeTooOldBanner, MIN_NODE_MAJOR } from '../src/bin/node-version-check';

describe('buildNode25BlockBanner', () => {
  it('embeds the reported Node version in the header', () => {
    expect(buildNode25BlockBanner('25.9.0')).toContain(
      'Unsupported Node.js version: 25.9.0'
    );
  });

  it('names the V8 turboshaft WASM root cause and the OOM symptom', () => {
    const banner = buildNode25BlockBanner('25.7.0');
    expect(banner).toContain('V8 WASM JIT');
    expect(banner).toContain('turboshaft');
    expect(banner).toContain('Fatal process out of memory: Zone');
  });

  it('points users to Node 24 LTS via nvm and Homebrew', () => {
    const banner = buildNode25BlockBanner('25.7.0');
    expect(banner).toContain('Node.js 24 LTS');
    expect(banner).toContain('nvm install 24');
    expect(banner).toContain('brew install node@24');
  });

  it('documents the SOLIDKG_ALLOW_UNSAFE_NODE override', () => {
    const banner = buildNode25BlockBanner('25.7.0');
    expect(banner).toContain('SOLIDKG_ALLOW_UNSAFE_NODE=1');
  });

  it('links to issue #81 for the root-cause writeup', () => {
    expect(buildNode25BlockBanner('25.7.0')).toContain(
      'solidkg.local/repository/issues/81'
    );
  });
});

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
    expect(packageJson.engines?.node).toBe('>=24.0.0 <25.0.0');
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
