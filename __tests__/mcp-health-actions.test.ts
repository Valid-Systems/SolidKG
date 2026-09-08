import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import SolidKG, { getDatabasePath } from '../src/index';
import { getExploreOutputBudget, ToolHandler, tools } from '../src/mcp/tools';

describe('MCP architecture health and snapshot drift actions', () => {
  let projectDir: string | undefined;
  let graph: SolidKG | undefined;

  afterEach(() => {
    graph?.close();
    graph = undefined;
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  it('uses scoped read-only handles instead of the default graph or writable cache', async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-health-'));
    fs.mkdirSync(path.join(projectDir!, 'src'));
    fs.writeFileSync(path.join(projectDir!, 'src', 'index.ts'), 'export function hello(): string { return "hello"; }\n');
    graph = await SolidKG.init(projectDir!, { includePatterns: ['**/*.ts'], excludePatterns: [] });
    await graph.indexAll();
    await graph.createSnapshot('baseline', {
      architecture: { layers: [{ name: 'source', paths: ['src/**'] }] },
    });

    const handler = new ToolHandler(graph);
    const defaultHealth = vi.spyOn(graph, 'getArchitectureHealth').mockImplementation(() => {
      throw new Error('default graph must not serve MCP health');
    });
    const defaultDrift = vi.spyOn(graph, 'getSnapshotHealthDrift').mockImplementation(async () => {
      throw new Error('default graph must not serve MCP drift');
    });

    const health = await handler.execute('solidkg_architecture', {
      action: 'health',
      projectPath: projectDir,
      layersJson: JSON.stringify([{ name: 'source', paths: ['src/**'] }]),
    });
    const drift = await handler.execute('solidkg_snapshot', {
      action: 'drift',
      label: 'baseline',
      projectPath: projectDir,
    });

    expect(health.isError).not.toBe(true);
    expect(health.content[0]?.text).toContain('Architecture Health');
    expect(drift.isError).not.toBe(true);
    expect(drift.content[0]?.text).toContain('Snapshot Health Drift: baseline');
    expect(defaultHealth).not.toHaveBeenCalled();
    expect(defaultDrift).not.toHaveBeenCalled();
    expect((handler as unknown as { projectCache: Map<string, SolidKG> }).projectCache.size).toBe(0);
  });

  it('validates health/drift inputs and exposes the new schema actions', async () => {
    const handler = new ToolHandler(null);

    const missingLabel = await handler.execute('solidkg_snapshot', { action: 'drift' });
    const invalidLayers = await handler.execute('solidkg_architecture', {
      action: 'health',
      layersJson: '{',
    });
    const snapshot = tools.find((tool) => tool.name === 'solidkg_snapshot');
    const architecture = tools.find((tool) => tool.name === 'solidkg_architecture');

    expect(missingLabel.content[0]?.text).toContain('label must be a non-empty string');
    expect(invalidLayers.content[0]?.text).toContain('layersJson is invalid JSON');
    expect(snapshot?.inputSchema.properties.action.enum).toContain('drift');
    expect(snapshot?.inputSchema.properties.layersJson).toBeDefined();
    expect(architecture?.inputSchema.properties.action.enum).toContain('health');
  });

  it('augments explicit explore health with bounded read-only evidence while preserving source', async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-explore-health-'));
    fs.mkdirSync(path.join(projectDir!, 'src'));
    fs.writeFileSync(path.join(projectDir!, 'src', 'index.ts'), [
      'export function hello(): string { return "hello"; }',
      'export function callHello(): string { return hello(); }',
      '',
    ].join('\n'));
    graph = await SolidKG.init(projectDir!, { includePatterns: ['**/*.ts'], excludePatterns: [] });
    await graph.indexAll();

    const handler = new ToolHandler(graph);
    const defaultHealth = vi.spyOn(graph, 'getArchitectureHealth').mockImplementation(() => {
      throw new Error('default graph must not serve explore health');
    });

    const result = await handler.execute('solidkg_explore', {
      projectPath: projectDir,
      query: 'Show repository architecture health for hello',
    });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).not.toBe(true);
    expect(text).toContain('Architecture Health');
    expect(text).toContain('Evidence Anchors');
    expect(text).toContain('hello');
    expect(text).toContain('Answer Packet');
    expect(text).toContain('architecture_health_partial');
    expect(text.length).toBeLessThanOrEqual(getExploreOutputBudget(1).maxOutputChars);
    expect(defaultHealth).not.toHaveBeenCalled();
    expect((handler as unknown as { projectCache: Map<string, SolidKG> }).projectCache.size).toBe(0);
  });

  it('keeps generic service-health exploration on the ordinary retrieval path', async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-generic-health-'));
    fs.writeFileSync(path.join(projectDir!, 'index.ts'), 'export function hello(): string { return "hello"; }\n');
    graph = await SolidKG.init(projectDir!, { includePatterns: ['**/*.ts'], excludePatterns: [] });
    await graph.indexAll();

    const handler = new ToolHandler(graph);
    const health = vi.spyOn(graph, 'getArchitectureHealth');
    const result = await handler.execute('solidkg_explore', { query: 'check service health for hello' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).not.toContain('## Architecture Health');
    expect(health).not.toHaveBeenCalled();
  });

  it('requires exactly one case-sensitive saved snapshot label for explore drift', async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-explore-drift-'));
    fs.writeFileSync(path.join(projectDir!, 'index.ts'), 'export function hello(): string { return "hello"; }\n');
    graph = await SolidKG.init(projectDir!, { includePatterns: ['**/*.ts'], excludePatterns: [] });
    await graph.indexAll();
    await graph.createSnapshot('baseline');
    await graph.createSnapshot('before');

    const handler = new ToolHandler(graph);
    const defaultDrift = vi.spyOn(graph, 'getSnapshotHealthDrift').mockImplementation(async () => {
      throw new Error('default graph must not serve explore drift');
    });

    const exact = await handler.execute('solidkg_explore', {
      projectPath: projectDir,
      query: 'What architecture health drifted since snapshot baseline?',
    });
    const missing = await handler.execute('solidkg_explore', {
      projectPath: projectDir,
      query: 'What architecture health drifted?',
    });
    const caseMismatch = await handler.execute('solidkg_explore', {
      projectPath: projectDir,
      query: 'What architecture health drifted since snapshot Baseline?',
    });
    const ambiguous = await handler.execute('solidkg_explore', {
      projectPath: projectDir,
      query: 'What architecture health drifted since baseline and before?',
    });

    expect(exact.content[0]?.text).toContain('Snapshot Health Drift: baseline');
    expect(missing.content[0]?.text).toContain('snapshot_label_required');
    expect(missing.content[0]?.text).toContain('`baseline`');
    expect(caseMismatch.content[0]?.text).toContain('snapshot_label_required');
    expect(caseMismatch.content[0]?.text).not.toContain('Snapshot Health Drift: baseline');
    expect(ambiguous.content[0]?.text).toContain('ambiguous_snapshot_label');
    expect(defaultDrift).not.toHaveBeenCalled();
  });

  it('does not resolve a writable graph for explicit explore health or drift without a default graph', async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-explore-readonly-null-'));
    fs.writeFileSync(path.join(projectDir!, 'index.ts'), 'export function hello(): string { return "hello"; }\n');
    graph = await SolidKG.init(projectDir!, { index: true });
    await graph.createSnapshot('baseline');

    const handler = new ToolHandler(null);
    const writableResolver = vi.spyOn(
      handler as unknown as { getSolidKG: () => SolidKG },
      'getSolidKG',
    ).mockImplementation(() => {
      throw new Error('explicit explore health must not use the writable resolver');
    });

    const health = await handler.execute('solidkg_explore', {
      projectPath: projectDir!,
      query: 'Show repository architecture health',
    });
    const drift = await handler.execute('solidkg_explore', {
      projectPath: projectDir!,
      query: 'What architecture health drifted since baseline?',
    });

    expect(health.isError).not.toBe(true);
    expect(health.content[0]?.text).toContain('Architecture Health');
    expect(drift.isError).not.toBe(true);
    expect(drift.content[0]?.text).toContain('Snapshot Health Drift: baseline');
    expect(writableResolver).not.toHaveBeenCalled();
    expect((handler as unknown as { projectCache: Map<string, SolidKG> }).projectCache.size).toBe(0);
  });

  it('does not resolve a writable graph for explicit explore health or drift across projects', async () => {
    const defaultProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-explore-readonly-default-'));
    const targetProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-explore-readonly-target-'));
    const defaultGraph = await SolidKG.init(defaultProjectDir, { index: true });
    const targetGraph = await SolidKG.init(targetProjectDir, { index: true });
    try {
      await targetGraph.createSnapshot('baseline');
      const handler = new ToolHandler(defaultGraph);
      const writableResolver = vi.spyOn(
        handler as unknown as { getSolidKG: () => SolidKG },
        'getSolidKG',
      ).mockImplementation(() => {
        throw new Error('cross-project explore health must not use the writable resolver');
      });

      const health = await handler.execute('solidkg_explore', {
        projectPath: targetProjectDir,
        query: 'Show repository architecture health',
      });
      const drift = await handler.execute('solidkg_explore', {
        projectPath: targetProjectDir,
        query: 'What architecture health drifted since baseline?',
      });

      expect(health.isError).not.toBe(true);
      expect(health.content[0]?.text).toContain('Architecture Health');
      expect(drift.isError).not.toBe(true);
      expect(drift.content[0]?.text).toContain('Snapshot Health Drift: baseline');
      expect(writableResolver).not.toHaveBeenCalled();
      expect((handler as unknown as { projectCache: Map<string, SolidKG> }).projectCache.size).toBe(0);
    } finally {
      defaultGraph.close();
      targetGraph.close();
      fs.rmSync(defaultProjectDir, { recursive: true, force: true });
      fs.rmSync(targetProjectDir, { recursive: true, force: true });
    }
  });

  it('does not resolve a writable graph for explicit explore health or drift on the default project', async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-explore-readonly-default-control-'));
    fs.writeFileSync(path.join(projectDir!, 'index.ts'), 'export function hello(): string { return "hello"; }\n');
    graph = await SolidKG.init(projectDir!, { index: true });
    await graph.createSnapshot('baseline');

    const handler = new ToolHandler(graph);
    const writableResolver = vi.spyOn(
      handler as unknown as { getSolidKG: () => SolidKG },
      'getSolidKG',
    ).mockImplementation(() => {
      throw new Error('default-project explore health must not use the writable resolver');
    });

    const health = await handler.execute('solidkg_explore', {
      projectPath: projectDir!,
      query: 'Show repository architecture health',
    });
    const drift = await handler.execute('solidkg_explore', {
      projectPath: projectDir!,
      query: 'What architecture health drifted since baseline?',
    });

    expect(health.isError).not.toBe(true);
    expect(health.content[0]?.text).toContain('Architecture Health');
    expect(drift.isError).not.toBe(true);
    expect(drift.content[0]?.text).toContain('Snapshot Health Drift: baseline');
    expect(writableResolver).not.toHaveBeenCalled();
    expect((handler as unknown as { projectCache: Map<string, SolidKG> }).projectCache.size).toBe(0);
  });

  it('returns schema-v10 remediation for explicit explore health and drift without a writable resolver', async () => {
    const schemaProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-explore-readonly-schema-v10-'));
    const schemaGraph = await SolidKG.init(schemaProjectDir, { index: true });
    schemaGraph.close();
    const connection = DatabaseConnection.open(getDatabasePath(schemaProjectDir));
    try {
      connection.getDb().exec('DELETE FROM schema_versions');
      connection.getDb().prepare(
        'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)',
      ).run(10, Date.now(), 'schema v10 test fixture');
    } finally {
      connection.close();
    }

    try {
      const handler = new ToolHandler(null);
      const writableResolver = vi.spyOn(
        handler as unknown as { getSolidKG: () => SolidKG },
        'getSolidKG',
      ).mockImplementation(() => {
        throw new Error('schema-v10 explore health must not use the writable resolver');
      });

      const health = await handler.execute('solidkg_explore', {
        projectPath: schemaProjectDir,
        query: 'Show repository architecture health',
      });
      const drift = await handler.execute('solidkg_explore', {
        projectPath: schemaProjectDir,
        query: 'What architecture health drifted since baseline?',
      });

      expect(health.content[0]?.text).toContain('SolidKG schema 10 must be upgraded to 11');
      expect(drift.content[0]?.text).toContain('SolidKG schema 10 must be upgraded to 11');
      expect(writableResolver).not.toHaveBeenCalled();
      expect((handler as unknown as { projectCache: Map<string, SolidKG> }).projectCache.size).toBe(0);
    } finally {
      fs.rmSync(schemaProjectDir, { recursive: true, force: true });
    }
  });
});
