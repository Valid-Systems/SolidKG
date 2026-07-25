import * as path from 'path';

export interface SourceRootInput {
  path: string;
  label?: string;
}

export interface SourceRoot {
  rootDir: string;
  label: string;
  prefix: string;
}

export interface SourceRootOptions {
  extraRoots?: Array<string | SourceRootInput>;
}

function slugRootLabel(label: string): string {
  const slug = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'root';
}

export function buildSourceRoots(
  projectRoot: string,
  extraRoots: Array<string | SourceRootInput> = [],
): SourceRoot[] {
  const inputs: SourceRootInput[] = [
    { path: projectRoot },
    ...extraRoots.map((entry) => typeof entry === 'string' ? { path: entry } : entry),
  ];
  const resolved = inputs.map((entry) => ({
    rootDir: path.resolve(entry.path),
    requestedLabel: entry.label,
  }));
  const multiRoot = resolved.length > 1;
  const labelCounts = new Map<string, number>();

  return resolved.map((entry, index) => {
    const base = slugRootLabel(entry.requestedLabel ?? path.basename(entry.rootDir) ?? `root${index + 1}`);
    const count = labelCounts.get(base) ?? 0;
    labelCounts.set(base, count + 1);
    const label = count === 0 ? base : `${base}-${count + 1}`;
    return {
      rootDir: entry.rootDir,
      label,
      prefix: multiRoot ? `@${label}/` : '',
    };
  });
}
