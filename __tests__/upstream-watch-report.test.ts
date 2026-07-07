import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'upstream-watch', 'report.mjs');

function makeTempRepo(manifest: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-watch-'));
  const watchDir = path.join(dir, '.upstream-watch');
  fs.mkdirSync(watchDir, { recursive: true });
  fs.writeFileSync(path.join(watchDir, 'mirrored-paths.txt'), manifest);
  return dir;
}

function runReport(cwd: string, compareJson: unknown, ...args: string[]) {
  return execFileSync('node', [SCRIPT, '--base', 'v0.9.5', '--head', 'v0.9.9', ...args], {
    cwd,
    input: JSON.stringify(compareJson),
    encoding: 'utf8',
  });
}

describe('upstream-watch report helper', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports only files matching the mirrored-path manifest', () => {
    const dir = makeTempRepo('src/mcp/**\nsrc/installer/**\nREADME.md\n');
    dirs.push(dir);

    const output = runReport(dir, {
      files: [
        { filename: 'src/mcp/tools.ts', status: 'modified', changes: 42 },
        { filename: 'src/installer/targets/opencode.ts', status: 'modified', changes: 7 },
        { filename: 'docs/design/unrelated.md', status: 'added', changes: 3 },
      ],
    });

    expect(output).toContain('# Upstream Watch Report');
    expect(output).toContain('Range: `v0.9.5...v0.9.9`');
    expect(output).toContain('Matched mirrored files: 2');
    expect(output).toContain('- `modified` `src/mcp/tools.ts` (42 changes)');
    expect(output).toContain('- `modified` `src/installer/targets/opencode.ts` (7 changes)');
    expect(output).not.toContain('docs/design/unrelated.md');
  });

  it('marks an upstream release as low attention when no manifest paths changed', () => {
    const dir = makeTempRepo('src/mcp/**\n');
    dirs.push(dir);

    const output = runReport(dir, {
      files: [{ filename: 'docs/design/unrelated.md', status: 'modified', changes: 3 }],
    });

    expect(output).toContain('Matched mirrored files: 0');
    expect(output).toContain('No manifest paths changed. Keep the state file unchanged until a maintainer reviews the release notes.');
  });

  it('reports renamed files when the previous path matched the manifest', () => {
    const dir = makeTempRepo('src/mcp/**\n');
    dirs.push(dir);

    const output = runReport(dir, {
      files: [{
        filename: 'docs/archive/tools.md',
        previous_filename: 'src/mcp/tools.ts',
        status: 'renamed',
        changes: 12,
      }],
    });

    expect(output).toContain('Matched mirrored files: 1');
    expect(output).toContain('- `renamed` `src/mcp/tools.ts` -> `docs/archive/tools.md` (12 changes)');
  });

  it('labels reports with CodeGraph upstream by default', () => {
    const dir = makeTempRepo('src/mcp/**\n');
    dirs.push(dir);

    const output = runReport(dir, {
      files: [{ filename: 'src/mcp/tools.ts', status: 'modified', changes: 1 }],
    });

    expect(output).toContain('Repository: `colbymchenry/codegraph`');
  });

  it('requires explicit base and head tags so state updates stay deliberate', () => {
    const dir = makeTempRepo('src/mcp/**\n');
    dirs.push(dir);

    expect(() =>
      execFileSync('node', [SCRIPT], {
        cwd: dir,
        input: JSON.stringify({ files: [] }),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ).toThrow(/--base and --head are required/);
  });
});
