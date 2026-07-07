import { spawnSync } from 'child_process';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'agent-eval', 'peer-structural-benchmark.mjs');

function runHelper(expression: string) {
  const source = `import * as benchmark from ${JSON.stringify(new URL(`file://${scriptPath.replace(/\\/g, '/')}`).href)};\n${expression}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: repoRoot, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('peer structural benchmark fairness contracts', () => {
  it('gives SolidKG caller scenarios a peer-comparable caller limit', () => {
    const command = runHelper("console.log(JSON.stringify(benchmark.peerCommand('solidkg', { kind: 'caller_reference', query: 'getNodeText' }, 'D:/repo', 'D:/repo/dist/bin/solidkg.js', 'cartog', 'cartog.db')));");

    expect(command).toContain('--limit 200');
  });

  it('parses SolidKG caller output target metadata as structural evidence without inventing callers', () => {
    const parsed = runHelper(`console.log(JSON.stringify(benchmark.parseSolidKGCallers('solidkg', {
      statusCode: 0,
      durationMs: 12,
      outputBytes: 120,
      stdout: JSON.stringify({
        symbol: 'getNodeText',
        matches: [{ name: 'getNodeText', kind: 'function', filePath: 'src/extraction/tree-sitter-helpers.ts', startLine: 35 }],
        callers: [{ name: 'extractFunction', kind: 'method', filePath: 'src/extraction/tree-sitter.ts', startLine: 1200 }],
      }),
      stderr: '',
    })));`);

    expect(parsed.foundSymbols).toEqual(expect.arrayContaining(['getNodeText', 'extractFunction']));
    expect(parsed.foundFiles).toEqual(expect.arrayContaining(['src/extraction/tree-sitter-helpers.ts', 'src/extraction/tree-sitter.ts']));
    expect(parsed.referenceCount).toBe(1);
  });
});