import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');

function makeConsumer(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-package-consumer-'));
  const modulesDir = path.join(dir, 'node_modules');
  fs.mkdirSync(modulesDir, { recursive: true });
  const linkPath = path.join(modulesDir, 'solidkg');
  fs.symlinkSync(repoRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  return dir;
}

describe('package entrypoint exports', () => {
  it('exposes SolidKG and public types from the package root after build', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      exports?: { '.'?: { types?: string; require?: string; default?: string } };
    };
    expect(packageJson.exports?.['.']?.types).toBe('./dist/index.d.ts');
    expect((packageJson.exports?.['.'] as { import?: string } | undefined)?.import).toBe('./dist/index.js');
    expect(packageJson.exports?.['.']?.require).toBe('./dist/index.js');
    expect(packageJson.exports?.['.']?.default).toBe('./dist/index.js');

    const distEntry = path.join(repoRoot, 'dist', 'index.js');
    const distTypes = path.join(repoRoot, 'dist', 'index.d.ts');
    expect(fs.existsSync(distEntry), 'run pnpm run build before this package export test').toBe(true);
    expect(fs.existsSync(distTypes), 'run pnpm run build before this package export test').toBe(true);

    const consumer = makeConsumer();
    try {
      fs.writeFileSync(path.join(consumer, 'runtime.cjs'), `
const pkg = require('solidkg');
if (typeof pkg.SolidKG !== 'function') throw new Error('missing named SolidKG export');
if (pkg.default !== pkg.SolidKG) throw new Error('default export does not match SolidKG');
if (!Array.isArray(pkg.NODE_KINDS) || !pkg.NODE_KINDS.includes('function')) throw new Error('missing public type constants');
console.log('runtime package root import ok');
`);

      const runtimeOutput = execFileSync(process.execPath, [path.join(consumer, 'runtime.cjs')], {
        cwd: consumer,
        encoding: 'utf8',
      });
      expect(runtimeOutput).toContain('runtime package root import ok');

      fs.writeFileSync(path.join(consumer, 'consumer.ts'), `
import SolidKG, { SolidKG as NamedSolidKG, NODE_KINDS } from 'solidkg';
import type { IndexResult, Node } from 'solidkg';

const sameCtor: typeof NamedSolidKG = SolidKG;
const kind: Node['kind'] = NODE_KINDS[0];
const result: Pick<IndexResult, 'success'> = { success: true };
console.log(Boolean(sameCtor), kind, result.success);
`);
      fs.writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          strict: true,
          skipLibCheck: true,
        },
        include: ['consumer.ts'],
      }, null, 2));

      try {
        execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--pretty', 'false', '-p', consumer], {
          cwd: consumer,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (error) {
        const result = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
        const stdout = result.stdout?.toString() ?? '';
        const stderr = result.stderr?.toString() ?? '';
        throw new Error(`consumer typecheck failed\n${stdout}${stderr}${result.message ?? ''}`);
      }
    } finally {
      fs.rmSync(consumer, { recursive: true, force: true });
    }
  });
});
