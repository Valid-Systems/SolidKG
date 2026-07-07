import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'fixtures', 'evaluation-corpus', 'manifest.json');
const policyPath = path.join(repoRoot, 'docs', 'design', 'evaluation-corpus-policy.md');
const hasPolicyDoc = fs.existsSync(policyPath);

type CorpusEntry = {
  name?: unknown;
  sourceUrl?: unknown;
  revision?: unknown;
  license?: unknown;
  purpose?: unknown;
  fetchCommand?: unknown;
  installCommand?: unknown;
  buildCommand?: unknown;
  smokeCommand?: unknown;
  expectedArtifacts?: unknown;
  inclusionPolicy?: unknown;
  cleanupCommand?: unknown;
};

type CorpusManifest = {
  $schema?: unknown;
  manifestVersion?: unknown;
  policyVersion?: unknown;
  description?: unknown;
  corpora?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateCorpusEntry(entry: CorpusEntry): string[] {
  const errors: string[] = [];
  const requiredStringFields = [
    'name',
    'sourceUrl',
    'revision',
    'license',
    'purpose',
    'fetchCommand',
    'installCommand',
    'buildCommand',
    'smokeCommand',
    'cleanupCommand',
  ] as const;

  for (const field of requiredStringFields) {
    if (!isNonEmptyString(entry[field])) errors.push(`${field} is required`);
  }

  if (!Array.isArray(entry.expectedArtifacts) || entry.expectedArtifacts.length === 0) {
    errors.push('expectedArtifacts is required');
  } else if (!entry.expectedArtifacts.every(isNonEmptyString)) {
    errors.push('expectedArtifacts must contain only non-empty strings');
  }

  if (!entry.inclusionPolicy || typeof entry.inclusionPolicy !== 'object' || Array.isArray(entry.inclusionPolicy)) {
    errors.push('inclusionPolicy is required');
  } else {
    const policy = entry.inclusionPolicy as { shipInRelease?: unknown; licenseApproval?: unknown };
    if (typeof policy.shipInRelease !== 'boolean') errors.push('inclusionPolicy.shipInRelease is required');
    if (policy.shipInRelease && !isNonEmptyString(policy.licenseApproval)) {
      errors.push('inclusionPolicy.licenseApproval is required when shipInRelease is true');
    }
  }

  return errors;
}

function validateManifest(manifest: CorpusManifest): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(manifest.$schema)) errors.push('$schema is required');
  if (typeof manifest.manifestVersion !== 'number') errors.push('manifestVersion is required');
  if (!isNonEmptyString(manifest.policyVersion)) errors.push('policyVersion is required');
  if (!isNonEmptyString(manifest.description)) errors.push('description is required');
  if (!Array.isArray(manifest.corpora)) {
    errors.push('corpora must be an array');
    return errors;
  }

  manifest.corpora.forEach((entry, index) => {
    for (const error of validateCorpusEntry(entry as CorpusEntry)) errors.push(`corpora[${index}].${error}`);
  });

  return errors;
}

function completeCorpusEntry(): CorpusEntry {
  return {
    name: 'example-corpus',
    sourceUrl: 'https://example.invalid/repository.git',
    revision: '0123456789abcdef0123456789abcdef01234567',
    license: 'MIT',
    purpose: 'Synthetic validator fixture only; not a real corpus approval.',
    fetchCommand: 'none',
    installCommand: 'none',
    buildCommand: 'none',
    smokeCommand: 'node --version',
    expectedArtifacts: ['README.md'],
    inclusionPolicy: {
      shipInRelease: false,
      licenseApproval: null,
    },
    cleanupCommand: 'none',
  };
}

describe('evaluation corpus manifest policy', () => {
  it('starts with schema/version metadata and no approved corpora', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CorpusManifest;

    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest.$schema).toContain('evaluation-corpus-manifest.v1.json');
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.policyVersion).toBe('2026-06-04');
    expect(manifest.corpora).toEqual([]);
  });

  it.each(['license', 'revision', 'buildCommand', 'smokeCommand', 'inclusionPolicy'] as const)(
    'rejects a corpus entry missing %s',
    (field) => {
      const entry = completeCorpusEntry();
      delete entry[field];

      expect(validateCorpusEntry(entry)).toContain(`${field} is required`);
    },
  );

  it('requires release shipping to include an explicit license approval record', () => {
    const entry = completeCorpusEntry();
    entry.inclusionPolicy = { shipInRelease: true, licenseApproval: '' };

    expect(validateCorpusEntry(entry)).toContain(
      'inclusionPolicy.licenseApproval is required when shipInRelease is true',
    );
  });

  it.skipIf(!hasPolicyDoc)('documents explicit opt-in fetching and incomplete Step B readiness', () => {
    const policy = fs.readFileSync(policyPath, 'utf8');

    expect(policy).toContain('must be fetched or installed only when explicitly requested');
    expect(policy).toContain('excluded from npm and release artifacts');
    expect(policy).toContain('shipInRelease');
    expect(policy).toContain('licenseApproval');
    expect(policy).toContain('Synthetic fixtures and policy documents do not satisfy vendored-codebase install readiness');
    expect(policy).toContain('Step B');
  });

  it('keeps corpus paths out of current package and bundle allowlists by default', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    const buildBundle = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-bundle.sh'), 'utf8');
    const packNpm = fs.readFileSync(path.join(repoRoot, 'scripts', 'pack-npm.sh'), 'utf8');

    expect(packageJson.files).not.toContain('fixtures');
    expect(packageJson.files).not.toContain('fixtures/evaluation-corpus');
    expect(buildBundle).toContain('cp -R "$ROOT/dist" "$STAGE/lib/dist"');
    expect(buildBundle).not.toContain('fixtures/evaluation-corpus');
    expect(packNpm).toContain('files: [process.env.NODEFILE, "lib", "bin"]');
    expect(packNpm).toContain('files: ["npm-shim.js","README.md"]');
    expect(packNpm).not.toContain('fixtures/evaluation-corpus');
  });
});
