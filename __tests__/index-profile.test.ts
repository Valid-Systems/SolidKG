import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import SolidKG, { type IndexProfile } from '../src';

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'dist', 'bin', 'solidkg.js');
const tempDirs: string[] = [];

function latestMtimeMs(paths: readonly string[], includeEntry: (entryPath: string) => boolean = () => true): number {
  let latest = 0;

  function visit(entryPath: string): void {
    const stat = fs.statSync(entryPath);
    if (includeEntry(entryPath)) latest = Math.max(latest, stat.mtimeMs);
    if (!stat.isDirectory()) return;

    for (const entry of fs.readdirSync(entryPath)) {
      visit(path.join(entryPath, entry));
    }
  }

  for (const entryPath of paths) {
    if (fs.existsSync(entryPath)) visit(entryPath);
  }

  return latest;
}

function hasCurrentBuiltDist(): boolean {
  const schemaPath = path.join(repoRoot, 'dist', 'db', 'schema.sql');
  const schemaSource = path.join(repoRoot, 'src', 'db', 'schema.sql');
  const nativeManifest = path.join(repoRoot, 'dist', 'extraction', 'native-grammars.json');
  const nativeManifestSource = path.join(repoRoot, 'src', 'extraction', 'native-grammars.json');
  const nativeDir = path.join(repoRoot, '.native-grammars', `${process.platform}-${process.arch}`);
  if (!fs.existsSync(cliPath) || !fs.existsSync(schemaPath) || !fs.existsSync(nativeManifest) || !fs.existsSync(nativeDir)) return false;
  if (fs.readdirSync(nativeDir).length < 32) return false;

  const typeScriptSourceMtime = latestMtimeMs([
    path.join(repoRoot, 'src'),
    path.join(repoRoot, 'tsconfig.json'),
  ], entryPath => entryPath.endsWith('.ts') || entryPath.endsWith('.json'));
  const schemaCurrent = fs.statSync(schemaPath).mtimeMs >= fs.statSync(schemaSource).mtimeMs;
  const nativeManifestCurrent = fs.statSync(nativeManifest).mtimeMs >= fs.statSync(nativeManifestSource).mtimeMs;

  return fs.statSync(cliPath).mtimeMs >= typeScriptSourceMtime && schemaCurrent && nativeManifestCurrent;
}

function copyBuildAssets(): void {
  fs.mkdirSync(path.join(repoRoot, 'dist', 'db'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'src', 'db', 'schema.sql'), path.join(repoRoot, 'dist', 'db', 'schema.sql'));

  const extractionTarget = path.join(repoRoot, 'dist', 'extraction');
  fs.mkdirSync(extractionTarget, { recursive: true });
  fs.rmSync(path.join(extractionTarget, 'wasm'), { recursive: true, force: true });
  fs.copyFileSync(path.join(repoRoot, 'src', 'extraction', 'native-grammars.json'), path.join(extractionTarget, 'native-grammars.json'));
}

function stripBinSourceMapComments(): void {
  const binDir = path.join(repoRoot, 'dist', 'bin');
  if (!fs.existsSync(binDir)) return;

  for (const entry of fs.readdirSync(binDir)) {
    if (!entry.endsWith('.js')) continue;
    const file = path.join(binDir, entry);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const filtered = lines.filter((line, index) => index === 0 || !/^\s*\/\/[#@]\s*sourceMappingURL=/.test(line));
    fs.writeFileSync(file, filtered.join('\n'));
  }
}

function buildDistForCliTests(): void {
  execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: repoRoot, stdio: 'pipe' });
  copyBuildAssets();
  stripBinSourceMapComments();
  fs.chmodSync(cliPath, 0o755);
}

beforeAll(() => {
  if (!hasCurrentBuiltDist()) {
    buildDistForCliTests();
    return;
  }

  fs.chmodSync(cliPath, 0o755);
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createFixture(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'math.ts'),
    'export function add(left: number, right: number): number { return left + right; }\n'
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'index.ts'),
    "import { add } from './math';\nexport const value = add(1, 2);\n"
  );
  return dir;
}

function createMixedResolutionFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-index-profile-mixed-'));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'main.ts'),
    [
      'export function target(): number { return 1; }',
      'export function caller(): number {',
      '  target();',
      '  target();',
      '  missingCall();',
      '  return target();',
      '}',
      '',
    ].join('\n')
  );
  return dir;
}

function expectFiniteNonNegative(value: number): void {
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
}

function expectFiniteNonNegativeRecord(record: Record<string, number>): void {
  for (const value of Object.values(record)) {
    expectFiniteNonNegative(value);
  }
}

function expectValidProfile(profile: IndexProfile): void {
  expect(profile.schemaVersion).toBe('solidkg.indexProfile.v1');
  expectFiniteNonNegative(profile.startedAtMs);
  expectFiniteNonNegative(profile.finishedAtMs);
  expect(profile.finishedAtMs).toBeGreaterThanOrEqual(profile.startedAtMs);
  expectFiniteNonNegative(profile.durationMs);
  expectFiniteNonNegative(profile.timingsMs.extraction);
  expectFiniteNonNegative(profile.timingsMs.scip);
  expectFiniteNonNegative(profile.timingsMs.resolution);
  expectFiniteNonNegative(profile.timingsMs.maintenance);
  expectFiniteNonNegative(profile.timingsMs.total);
  expect(profile.timingsMs.total).toBeGreaterThanOrEqual(profile.timingsMs.extraction);
  expectFiniteNonNegative(profile.counts.filesScanned);
  expectFiniteNonNegative(profile.counts.filesIndexed);
  expectFiniteNonNegative(profile.counts.filesSkipped);
  expectFiniteNonNegative(profile.counts.filesErrored);
  expectFiniteNonNegative(profile.counts.nodesCreated);
  expectFiniteNonNegative(profile.counts.edgesCreated);
  expectFiniteNonNegative(profile.counts.unresolvedReferencesRemaining);
  expectFiniteNonNegative(profile.counts.semanticRelations);
  expectFiniteNonNegative(profile.resources.rssBytes);
  expectFiniteNonNegative(profile.resources.heapUsedBytes);
  expectFiniteNonNegative(profile.resources.heapTotalBytes);
  expectFiniteNonNegative(profile.resources.dbSizeBytes);
  expectFiniteNonNegative(profile.resources.walSizeBytes);
  expect(profile.resources.heapTotalBytes).toBeGreaterThanOrEqual(profile.resources.heapUsedBytes);
  expect(Object.keys(profile.dbStatements.byGroup).length).toBeGreaterThan(0);
  expectFiniteNonNegativeRecord(profile.dbStatements.byGroup);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('index profiling', () => {
  it('omits profile by default from the API result', async () => {
    const fixture = createFixture('cg-index-profile-default-');
    const cg = SolidKG.initSync(fixture);
    try {
      const result = await cg.indexAll();
      expect(result.success).toBe(true);
      expect('profile' in result).toBe(false);
    } finally {
      cg.destroy();
    }
  });

  it('returns a versioned finite non-negative API profile when enabled', async () => {
    const fixture = createFixture('cg-index-profile-api-');
    const cg = SolidKG.initSync(fixture);
    try {
      const result = await cg.indexAll({ profile: true });
      expect(result.success).toBe(true);
      expect(result.profile).toBeDefined();
      expectValidProfile(result.profile!);
      expect(result.profile!.counts.filesScanned).toBe(2);
      expect(result.profile!.counts.filesIndexed).toBe(2);
      expect(result.profile!.counts.nodesCreated).toBeGreaterThan(0);
      expect(result.profile!.dbStatements.byGroup['nodes.write']).toBeGreaterThan(0);
      expect(result.profile!.dbStatements.byGroup['files.write']).toBeGreaterThan(0);
    } finally {
      cg.destroy();
    }
  });

  it('keeps mixed resolved/unresolved duplicate reference batches correct while profiling', async () => {
    const fixture = createMixedResolutionFixture();
    const cg = SolidKG.initSync(fixture);
    try {
      const result = await cg.indexAll({ profile: true });
      expect(result.success).toBe(true);
      expectValidProfile(result.profile!);
      expect(result.profile!.counts.unresolvedReferencesRemaining).toBe(1);
      expect(result.profile!.dbStatements.byGroup['unresolved.read']).toBeGreaterThan(0);
      expect(result.profile!.dbStatements.byGroup['unresolved.delete']).toBeGreaterThan(0);
      const caller = cg.searchNodes('caller')[0]?.node;
      expect(caller).toBeDefined();
      if (!caller) return;
      const callees = cg.getCallees(caller.id).map((edge) => edge.node.name);
      expect(callees).toContain('target');
    } finally {
      cg.destroy();
    }
  });

  it('emits synthesis progress after reference resolution batches', async () => {
    const fixture = createMixedResolutionFixture();
    const cg = SolidKG.initSync(fixture);
    try {
      const phases: string[] = [];
      const result = await cg.indexAll({ onProgress: (progress) => phases.push(String(progress.phase)) });

      expect(result.success).toBe(true);
      const lastResolving = phases.lastIndexOf('resolving');
      const synthesis = phases.indexOf('synthesis');
      expect(lastResolving).toBeGreaterThanOrEqual(0);
      expect(synthesis).toBeGreaterThan(lastResolving);
    } finally {
      cg.destroy();
    }
  });

  it('emits only parseable JSON with profile for CLI --profile-json', () => {
    const fixture = createFixture('cg-index-profile-cli-json-');
    execFileSync(process.execPath, [cliPath, 'init', fixture], { cwd: repoRoot, encoding: 'utf8' });
    const stdout = execFileSync(process.execPath, [cliPath, 'index', '--profile-json', fixture], { cwd: repoRoot, encoding: 'utf8' });
    const parsed = JSON.parse(stdout) as unknown;
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) return;
    expect(parsed.success).toBe(true);
    expect(isRecord(parsed.profile)).toBe(true);
    if (!isRecord(parsed.profile)) return;
    expectValidProfile(parsed.profile as unknown as IndexProfile);
  });

  it('keeps normal CLI index output human-readable without profile JSON', () => {
    const fixture = createFixture('cg-index-profile-cli-human-');
    execFileSync(process.execPath, [cliPath, 'init', fixture], { cwd: repoRoot, encoding: 'utf8' });
    const result = spawnSync(process.execPath, [cliPath, 'index', fixture], { cwd: repoRoot, encoding: 'utf8' });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(() => JSON.parse(output)).toThrow();
    expect(output).not.toContain('"profile"');
    expect(output).toContain('SolidKG indexed');
  });
});
