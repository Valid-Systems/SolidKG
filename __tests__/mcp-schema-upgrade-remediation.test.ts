import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import SolidKG, { getDatabasePath } from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

const SCHEMA_UPGRADE_REMEDIATION = 'SolidKG schema 10 must be upgraded to 11 before architecture health or snapshot drift can be read. Run "solidkg sync <project>" once with write access, then retry.';

describe('MCP schema-upgrade remediation', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-schema-v10-'));
    fs.writeFileSync(path.join(projectDir, 'index.ts'), 'export const version = 10;\n');
    const graph = await SolidKG.init(projectDir, { index: true });
    graph.destroy();

    const connection = DatabaseConnection.open(getDatabasePath(projectDir));
    try {
      connection.getDb().exec('DELETE FROM schema_versions');
      connection.getDb().prepare(
        'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)',
      ).run(10, Date.now(), 'schema v10 test fixture');
    } finally {
      connection.close();
    }
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns the exact schema-v10 remediation for architecture health', async () => {
    const handler = new ToolHandler(null);

    const result = await handler.execute('solidkg_architecture', {
      action: 'health',
      projectPath: projectDir,
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: SCHEMA_UPGRADE_REMEDIATION }],
      isError: true,
    });
  });

  it('returns the exact schema-v10 remediation for snapshot drift', async () => {
    const handler = new ToolHandler(null);

    const result = await handler.execute('solidkg_snapshot', {
      action: 'drift',
      label: 'baseline',
      projectPath: projectDir,
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: SCHEMA_UPGRADE_REMEDIATION }],
      isError: true,
    });
  });

  it('returns the exact schema-v10 remediation for explicit explore health and drift intent', async () => {
    const handler = new ToolHandler(null);

    const health = await handler.execute('solidkg_explore', {
      projectPath: projectDir,
      query: 'Show repository architecture health',
    });
    const drift = await handler.execute('solidkg_explore', {
      projectPath: projectDir,
      query: 'What architecture health drifted since baseline?',
    });

    expect(health).toEqual({
      content: [{ type: 'text', text: SCHEMA_UPGRADE_REMEDIATION }],
      isError: true,
    });
    expect(drift).toEqual({
      content: [{ type: 'text', text: SCHEMA_UPGRADE_REMEDIATION }],
      isError: true,
    });
  });

  it('preserves generic error formatting', async () => {
    const handler = new ToolHandler(null);

    const result = await handler.execute('solidkg_unknown', {});

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: Unknown tool: solidkg_unknown' }],
      isError: true,
    });
  });

});
