import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(__dirname, '../src');

function staticDependencies(filePath: string): string[] {
  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  return source.statements.flatMap((statement) => {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [statement.moduleSpecifier.text];
    }
    return [];
  });
}

function dependsOn(dependencies: string[], boundary: string): boolean {
  return dependencies.some(
    (specifier) => specifier === boundary || specifier.startsWith(`${boundary}/`),
  );
}

describe('architecture dependency boundaries', () => {
  it('keeps reference resolution independent from the extraction orchestrator', () => {
    const dependencies = staticDependencies(path.join(SOURCE_ROOT, 'resolution/index.ts'));

    expect(dependsOn(dependencies, '../extraction')).toBe(false);
  });

  it('keeps shared source-root construction below extraction and resolution', () => {
    const filePath = path.join(SOURCE_ROOT, 'source-roots.ts');

    expect(fs.existsSync(filePath)).toBe(true);
    const dependencies = staticDependencies(filePath);
    expect(dependsOn(dependencies, './extraction')).toBe(false);
    expect(dependsOn(dependencies, './resolution')).toBe(false);
  });
});
