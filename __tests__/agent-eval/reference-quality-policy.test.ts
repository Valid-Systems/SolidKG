import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const modulePath = path.join(repoRoot, 'scripts', 'agent-eval', 'reference-quality', 'policy.mjs');

function evaluate(expression: string): unknown {
  const source = `import * as policy from ${JSON.stringify(new URL(`file://${modulePath.replace(/\\/g, '/')}`).href)};\nconsole.log(JSON.stringify(${expression}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('reference quality metric policy', () => {
  it('freezes non-gameable coverage predicates', () => {
    const contract = evaluate(`({
      schema: policy.REPORT_SCHEMA,
      policy: policy.METRIC_POLICY_VERSION,
      declarations: policy.DECLARATION_KINDS,
      anyEdges: policy.ANY_EDGE_KINDS,
      semanticEdges: policy.SEMANTIC_EDGE_KINDS,
      statuses: policy.COMPARISON_STATUSES,
      directions: policy.METRIC_DIRECTIONS,
    })`) as {
      schema: string;
      policy: string;
      declarations: string[];
      anyEdges: string[];
      semanticEdges: string[];
      statuses: string[];
      directions: Record<string, string>;
    };

    expect(contract.schema).toBe('solidkg.reference-quality.report.v1');
    expect(contract.policy).toBe('solidkg.reference-quality.metric-policy.v1');
    expect(contract.declarations).toEqual([
      'class', 'struct', 'interface', 'trait', 'protocol', 'function', 'method', 'property', 'field',
      'variable', 'constant', 'enum', 'enum_member', 'type_alias', 'namespace', 'route', 'component',
    ]);
    expect(contract.anyEdges).not.toContain('contains');
    expect(contract.semanticEdges).not.toContain('imports');
    expect(contract.statuses).toContain('changed');
    expect(contract.directions.latencyMs).toBe('neutral');
    expect(contract.directions.anyCrossFileCoverage).toBe('higher');
  });

  it('rejects unknown contract values and absolute paths', () => {
    const result = evaluate(`({
      unknownAvailability: policy.isAvailabilityStatus('invented'),
      knownAvailability: policy.isAvailabilityStatus('available_empty'),
      safePath: policy.isPortablePath('django__django'),
      windowsPath: policy.isPortablePath('D:/private/repo'),
      uncPath: policy.isPortablePath('\\\\server\\share'),
    })`) as Record<string, boolean>;

    expect(result).toEqual({
      unknownAvailability: false,
      knownAvailability: true,
      safePath: true,
      windowsPath: false,
      uncPath: false,
    });
  });
});
