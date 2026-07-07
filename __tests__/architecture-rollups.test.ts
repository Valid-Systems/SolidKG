import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SolidKG from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

interface ArchitectureLayerRule {
  name: string;
  paths: string[];
}

interface AnalyzeArchitectureOptions {
  layers?: ArchitectureLayerRule[];
}

interface ArchitectureFileAssignment {
  filePath: string;
  packageName: string;
  packageRoot: string;
  packageProvenance: 'manifest' | 'root' | 'unassigned';
  layerName: string;
  layerProvenance: 'config_layer' | 'unassigned';
}

interface ArchitectureDependency {
  source: string;
  target: string;
  edgeKinds: string[];
}

interface CouplingMetric {
  name: string;
  Ca: number;
  Ce: number;
  instability: number;
}

interface ArchitectureReport {
  packages: Array<{ name: string; root: string; provenance: 'manifest' | 'root'; fileCount: number }>;
  layers: Array<{ name: string; provenance: 'config_layer' | 'unassigned'; fileCount: number }>;
  fileAssignments: ArchitectureFileAssignment[];
  packageDependencies: ArchitectureDependency[];
  layerDependencies: ArchitectureDependency[];
  coupling: {
    packages: CouplingMetric[];
    layers: CouplingMetric[];
  };
}

interface ArchitectureSolidKG {
  analyzeArchitecture(options?: AnalyzeArchitectureOptions): Promise<ArchitectureReport> | ArchitectureReport;
  getArchitecture(): Promise<ArchitectureReport> | ArchitectureReport;
  getPackage(nameOrPath: string): Promise<ArchitectureReport['packages'][number] | null> | ArchitectureReport['packages'][number] | null;
  getPackageLookup(nameOrPath: string): {
    query: string;
    kind: 'package' | 'path';
    resolvedBy: 'name' | 'root' | 'owning_package' | 'not_found';
    package: ArchitectureReport['packages'][number] | null;
    matchedPath?: string;
    matchedFileCount?: number;
  };
  getCoupling(): Promise<ArchitectureReport['coupling']> | ArchitectureReport['coupling'];
}

let testDir: string | undefined;
let cg: SolidKG | undefined;

describe('architecture rollups and coupling metrics', () => {
  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    testDir = undefined;
  });

  it('package rollup computes two-package coupling', async () => {
    await createProject({
      'packages/api/package.json': JSON.stringify({ name: 'api' }),
      'packages/api/src/index.ts': `
import { readRecord } from '../../data/src/store';

export function handleRequest(): string {
  return readRecord();
}
`,
      'packages/data/package.json': JSON.stringify({ name: 'data' }),
      'packages/data/src/store.ts': `
export function readRecord(): string {
  return 'record';
}
`,
    });

    const report = await architectureApi(cg!).analyzeArchitecture();

    expect(packageNames(report)).toEqual(expect.arrayContaining(['api', 'data']));
    expect(report.packageDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'api', target: 'data' }),
    ]));
    expect(couplingFor(report.coupling.packages, 'api')).toMatchObject({ Ca: 0, Ce: 1, instability: 1 });
    expect(couplingFor(report.coupling.packages, 'data')).toMatchObject({ Ca: 1, Ce: 0, instability: 0 });
  });

  it('isolated package coupling has zero instability', async () => {
    await createProject({
      'packages/solo/package.json': JSON.stringify({ name: 'solo' }),
      'packages/solo/src/index.ts': `
export function isolated(): number {
  return 1;
}
`,
    });

    const report = await architectureApi(cg!).analyzeArchitecture();

    expect(couplingFor(report.coupling.packages, 'solo')).toMatchObject({
      Ca: 0,
      Ce: 0,
      instability: 0,
    });
  });

  it('configured layers assign explicit matches and leave unmatched unassigned', async () => {
    await createProject({
      'package.json': JSON.stringify({ name: 'layered-app' }),
      'src/api/controller.ts': `
import { loadData } from '../data/repository';

export function controller(): string {
  return loadData();
}
`,
      'src/data/repository.ts': `
export function loadData(): string {
  return 'data';
}
`,
      'src/shared/util.ts': `
export function identity(value: string): string {
  return value;
}
`,
    });

    const report = await architectureApi(cg!).analyzeArchitecture({
      layers: [
        { name: 'api', paths: ['src/api/**'] },
        { name: 'data', paths: ['src/data/**'] },
      ],
    });

    expect(layerNames(report)).toEqual(['api', 'data', 'unassigned']);
    expect(assignmentFor(report, 'src/api/controller.ts')).toMatchObject({
      layerName: 'api',
      layerProvenance: 'config_layer',
    });
    expect(assignmentFor(report, 'src/data/repository.ts')).toMatchObject({
      layerName: 'data',
      layerProvenance: 'config_layer',
    });
    expect(assignmentFor(report, 'src/shared/util.ts')).toMatchObject({
      layerName: 'unassigned',
      layerProvenance: 'unassigned',
    });
  });

  it('dependency edge filtering excludes containment from coupling', async () => {
    await createProject({
      'packages/empty-a/package.json': JSON.stringify({ name: 'empty-a' }),
      'packages/empty-a/src/index.ts': `
export function a(): string {
  return 'a';
}
`,
      'packages/empty-b/package.json': JSON.stringify({ name: 'empty-b' }),
      'packages/empty-b/src/index.ts': `
export function b(): string {
  return 'b';
}
`,
    });

    const report = await architectureApi(cg!).analyzeArchitecture();

    expect(report.packageDependencies).toEqual([]);
    expect(couplingFor(report.coupling.packages, 'empty-a')).toMatchObject({ Ca: 0, Ce: 0, instability: 0 });
    expect(couplingFor(report.coupling.packages, 'empty-b')).toMatchObject({ Ca: 0, Ce: 0, instability: 0 });
  });

  it('nearest manifest root owns nested package files', async () => {
    await createProject({
      'package.json': JSON.stringify({ name: 'root' }),
      'src/root.ts': `
export function rootOnly(): string {
  return 'root';
}
`,
      'packages/feature/package.json': JSON.stringify({ name: 'feature' }),
      'packages/feature/src/index.ts': `
export function featureOnly(): string {
  return 'feature';
}
`,
    });

    const report = await architectureApi(cg!).analyzeArchitecture();

    expect(assignmentFor(report, 'src/root.ts')).toMatchObject({
      packageName: 'root',
      packageRoot: '.',
      packageProvenance: 'manifest',
    });
    expect(assignmentFor(report, 'packages/feature/src/index.ts')).toMatchObject({
      packageName: 'feature',
      packageRoot: 'packages/feature',
      packageProvenance: 'manifest',
    });
  });

  it('architecture getters return the last analyzed rollup', async () => {
    await createProject({
      'packages/api/package.json': JSON.stringify({ name: 'api' }),
      'packages/api/src/index.ts': `export function api(): string { return 'api'; }`,
    });

    const arch = architectureApi(cg!);
    const analyzed = await arch.analyzeArchitecture();
    const current = await arch.getArchitecture();
    const coupling = await arch.getCoupling();
    const apiPackage = await arch.getPackage('api');
    const apiPathPackage = await arch.getPackage('packages/api/src');
    const apiPackageLookup = arch.getPackageLookup('api');
    const apiPathLookup = arch.getPackageLookup('packages/api/src');

    expect(current).toEqual(analyzed);
    expect(coupling).toEqual(analyzed.coupling);
    expect(apiPackage).toMatchObject({ name: 'api', root: 'packages/api' });
    expect(apiPathPackage).toMatchObject({ name: 'api', root: 'packages/api' });
    expect(apiPackageLookup).toMatchObject({ kind: 'package', resolvedBy: 'name', package: expect.objectContaining({ name: 'api', root: 'packages/api' }) });
    expect(apiPathLookup).toMatchObject({ kind: 'path', resolvedBy: 'owning_package', matchedPath: 'packages/api/src', matchedFileCount: 1, package: expect.objectContaining({ name: 'api', root: 'packages/api' }) });
  });

  it('clear removes cached architecture rollups', async () => {
    await createProject({
      'packages/api/package.json': JSON.stringify({ name: 'api' }),
      'packages/api/src/index.ts': `export function api(): string { return 'api'; }`,
    });

    const arch = architectureApi(cg!);
    const analyzed = await arch.analyzeArchitecture();
    expect(packageNames(analyzed)).toContain('api');

    cg!.clear();

    const current = await arch.getArchitecture();
    expect(packageNames(current)).not.toContain('api');
    expect(current.packages).toEqual([]);
  });

  it('package lookup keeps manifest names exact and explains path ownership', async () => {
    await createProject({
      'package.json': JSON.stringify({ name: 'solidkg' }),
      'src/index.ts': `export function root(): string { return 'root'; }`,
      'src/scip/index.ts': `export function generateScipIndexes(): string { return 'scip'; }`,
    });

    const handler = new ToolHandler(cg!);
    const analyzed = await handler.execute('solidkg_architecture', { action: 'analyze' });
    expect(analyzed.isError).not.toBe(true);

    const manifestPkg = await handler.execute('solidkg_architecture', { action: 'package', package: 'solidkg' });
    expect(manifestPkg.isError).not.toBe(true);
    expect(manifestPkg.content[0]?.text).toBe(JSON.stringify({
      name: 'solidkg',
      root: '.',
      provenance: 'manifest',
      fileCount: 2,
    }, null, 2));

    const pkg = await handler.execute('solidkg_architecture', { action: 'package', package: 'src/scip' });
    const text = pkg.content[0]?.text ?? '';
    expect(pkg.isError).not.toBe(true);
    expect(text).toContain('Path "src/scip" resolved to owning package "solidkg" at root ".".');
    expect(text).toContain('Matched files under "src/scip": 1.');
    expect(text).toContain('package-level, not scoped only to "src/scip"');
    expect(text).toContain('layersJson=[{"name":"src/scip","paths":["src/scip/**"]}]');
    expect(text).toContain('"name": "solidkg"');
    expect(text).toContain('"root": "."');
    expect(text).not.toContain('not found');

    const missing = await handler.execute('solidkg_architecture', { action: 'package', package: 'missing-package-name' });
    expect(missing.content[0]?.text).toContain('Package "missing-package-name" not found.');

    const missingPath = await handler.execute('solidkg_architecture', { action: 'package', package: 'src/missing' });
    expect(missingPath.content[0]?.text).toContain('No indexed files matched path "src/missing".');
    expect(missingPath.content[0]?.text).toContain('Package lookup returns manifest/root package rollups, not arbitrary path-scoped package metrics.');
  });

  it('MCP architecture tool analyzes rollups and retrieves package details', async () => {
    await createProject({
      'packages/api/package.json': JSON.stringify({ name: 'api' }),
      'packages/api/src/index.ts': `
import { readRecord } from '../../data/src/store';

export function handleRequest(): string {
  return readRecord();
}
`,
      'packages/data/package.json': JSON.stringify({ name: 'data' }),
      'packages/data/src/store.ts': `
export function readRecord(): string {
  return 'record';
}
`,
    });

    const handler = new ToolHandler(cg!);
    const analyzed = await handler.execute('solidkg_architecture', { action: 'analyze' });
    expect(analyzed.isError).not.toBe(true);
    expect(analyzed.content[0]?.text).toContain('Architecture Rollup');
    expect(analyzed.content[0]?.text).toContain('api');
    expect(analyzed.content[0]?.text).toContain('data');

    const coupling = await handler.execute('solidkg_architecture', { action: 'coupling' });
    expect(coupling.isError).not.toBe(true);
    expect(coupling.content[0]?.text).toContain('"packages"');
    expect(coupling.content[0]?.text).toContain('"instability"');

    const pkg = await handler.execute('solidkg_architecture', { action: 'package', package: 'api' });
    expect(pkg.isError).not.toBe(true);
    expect(pkg.content[0]?.text).toContain('"name": "api"');
  });
});

async function createProject(files: Record<string, string>): Promise<void> {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-architecture-rollups-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(testDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content.trimStart());
  }

  cg = await SolidKG.init(testDir, {
    config: { include: ['**/*.ts', '**/package.json'], exclude: [] },
  });
  await cg.indexAll();
  cg.resolveReferences();
}

function architectureApi(instance: SolidKG): ArchitectureSolidKG {
  return instance as unknown as ArchitectureSolidKG;
}

function packageNames(report: ArchitectureReport): string[] {
  return report.packages.map((pkg) => pkg.name).sort();
}

function layerNames(report: ArchitectureReport): string[] {
  return report.layers.map((layer) => layer.name).sort();
}

function couplingFor(metrics: CouplingMetric[], name: string): CouplingMetric {
  const metric = metrics.find((entry) => entry.name === name);
  expect(metric).toBeDefined();
  return metric!;
}

function assignmentFor(report: ArchitectureReport, filePath: string): ArchitectureFileAssignment {
  const assignment = report.fileAssignments.find((entry) => entry.filePath === filePath);
  expect(assignment).toBeDefined();
  return assignment!;
}
