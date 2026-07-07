import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { runRealisticBaselineFixture } from './realistic-baselines';

describe('realistic baseline harness', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = undefined;
  });

  it('emits JSON-compatible arms for realistic targeted baselines', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-realistic-baselines-'));
    const report = await runRealisticBaselineFixture(tempDir);

    expect(report.schemaName).toBe('solidkg.realistic-agent-baselines.v1');
    expect(report.rejectedBaselines).toContainEqual(
      expect.objectContaining({ baselineKind: 'whole_repo_read', status: 'rejected_unfair_antipattern' })
    );

    const armsByKind = new Map(report.arms.map((arm) => [arm.baselineKind, arm]));
    expect([...armsByKind.keys()].sort()).toEqual(['diff_read', 'rg_read', 'solidkg_context']);

    for (const arm of report.arms) {
      expect(arm).toMatchObject({
        baselineKind: expect.any(String),
        prompt: report.prompt,
        toolCalls: expect.any(Array),
        filesRead: expect.any(Array),
        estimatedTokens: expect.any(Number),
        success: true,
      });
      expect(arm.toolCalls.length).toBeGreaterThan(0);
      expect(arm.estimatedTokens).toBeGreaterThan(0);
    }

    expect(armsByKind.get('rg_read')?.filesRead).toEqual([
      'src/checkout.ts',
      'src/notifications.ts',
      'src/payments.ts',
    ]);
    expect(armsByKind.get('diff_read')?.toolCalls[0]).toEqual(
      expect.objectContaining({ tool: 'git diff' })
    );
    expect(armsByKind.get('solidkg_context')?.filesRead).toEqual([]);
    expect(armsByKind.get('solidkg_context')?.toolCalls).toEqual([
      { tool: 'solidkg_context', input: report.prompt },
    ]);
  });

  it('keeps the standalone fixture script offline and schema-compatible', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'agent-eval', 'realistic-baselines.mjs');
    const output = execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
    const parsed = JSON.parse(output) as { arms: Array<Record<string, unknown>>; rejectedBaselines: Array<Record<string, unknown>> };

    expect(parsed.arms.map((arm) => arm.baselineKind).sort()).toEqual([
      'diff_read',
      'rg_read',
      'solidkg_context',
    ]);
    for (const arm of parsed.arms) {
      expect(arm).toEqual(
        expect.objectContaining({
          baselineKind: expect.any(String),
          prompt: expect.any(String),
          toolCalls: expect.any(Array),
          filesRead: expect.any(Array),
          estimatedTokens: expect.any(Number),
          success: expect.any(Boolean),
        })
      );
    }
    expect(parsed.rejectedBaselines).toContainEqual(
      expect.objectContaining({ baselineKind: 'whole_repo_read', status: 'rejected_unfair_antipattern' })
    );
  });
});
