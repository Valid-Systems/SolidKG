import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');

describe('release and CI guardrails', () => {
  it('marks the repository root package as private to prevent accidental publishing', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      private?: boolean;
      scripts?: Record<string, string>;
    };

    expect(packageJson.private).toBe(true);
    expect(packageJson.scripts?.prepublishOnly).toBe('node scripts/guard-root-publish.mjs');
    expect(fs.existsSync(path.join(repoRoot, 'scripts', 'guard-root-publish.mjs'))).toBe(true);
  });

  it('has a normal CI workflow that typechecks, tests, and builds', () => {
    const ciPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
    expect(fs.existsSync(ciPath)).toBe(true);
    const workflow = fs.readFileSync(ciPath, 'utf8');
    expect(workflow).toContain('pnpm exec tsc');
    expect(workflow).toContain('pnpm test');
    expect(workflow).toContain('pnpm run build');
  });

  it('guards the release workflow with main-branch, concurrency, tests, and package smoke', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain('pnpm test');
    expect(workflow).toContain('pnpm run build');
    expect(workflow).toContain('Package smoke');
    expect(workflow).toContain('pkg.license');
  });
});
