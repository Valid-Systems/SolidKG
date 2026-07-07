import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getScipGenerationStatus, generateScipIndexes, importScipIndexes, resolveScipIndexerAvailability } from '../src/scip';
import { cleanupTempDirs, createQueries, writeEmptyScipFixture, writeScipFixture } from './scip-test-helpers';
import { afterEach } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

afterEach(() => cleanupTempDirs());

describe('SCIP indexer orchestration', () => {
  it('missing indexers are reported as unavailable without failing normal indexing', async () => {
    const availability = await resolveScipIndexerAvailability({
      typescript: { command: 'definitely-not-a-scip-indexer-command', files: ['**/*.ts'] },
    });

    expect(availability.typescript?.available).toBe(false);
    expect(availability.typescript?.reason).toMatch(/not found/i);
  });

  it('commands that fail the availability probe are reported as unavailable', async () => {
    const { conn, root } = createQueries();
    try {
      const failingCommand = path.join(root, process.platform === 'win32' ? 'failing-indexer.cmd' : 'failing-indexer.sh');
      fs.writeFileSync(failingCommand, process.platform === 'win32' ? '@echo off\r\necho nope 1>&2\r\nexit /b 7\r\n' : '#!/bin/sh\necho nope >&2\nexit 7\n');
      if (process.platform !== 'win32') fs.chmodSync(failingCommand, 0o755);

      const availability = await resolveScipIndexerAvailability({
        typescript: { command: failingCommand, files: ['**/*.ts'] },
      });

      expect(availability.typescript?.available).toBe(false);
      expect(availability.typescript?.reason).toMatch(/probe failed|nope/i);
    } finally {
      conn.close();
    }
  });

  it('auto records missing indexers as degraded without throwing', async () => {
    const { conn, queries, root, dbPath } = createQueries();
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'auto',
        indexers: {
          typescript: { command: 'definitely-not-a-scip-indexer-command', args: ['--output', '{output}'], files: ['**/*.ts'] },
        },
      });

      expect(result.success).toBe(true);
      expect(result.generatedFiles).toHaveLength(0);
      expect(result.status.languages.typescript?.state).toBe('indexer-missing');
      expect(getScipGenerationStatus(queries).languages.typescript?.state).toBe('indexer-missing');
    } finally {
      conn.close();
    }
  });

  it('off records skipped state and does not run configured commands', async () => {
    const { conn, queries, root, dbPath } = createQueries();
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const marker = path.join(root, 'marker.txt');
      const script = path.join(root, 'marker.js');
      fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'off',
        indexers: {
          typescript: { command: process.execPath, args: [script, '{output}'], files: ['**/*.ts'] },
        },
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
      expect(result.status.languages.typescript?.state).toBe('skipped');
    } finally {
      conn.close();
    }
  });

  it('generates SCIP files with literal arguments and persists generated state', async () => {
    const { conn, queries, root, dbPath } = createQueries();
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const fixture = writeScipFixture(root, 'fixture.scip');
      const argsFile = path.join(root, 'args.json');
      const script = path.join(root, 'copy-scip.js');
      fs.writeFileSync(script, [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
        "fs.copyFileSync(process.argv[2], process.argv[3]);",
      ].join('\n'));

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'auto',
        indexers: {
          typescript: { command: process.execPath, args: [script, fixture, '{output}'], files: ['**/*.ts'] },
        },
      });

      expect(result.success).toBe(true);
      expect(result.generatedFiles).toHaveLength(1);
      expect(fs.existsSync(result.generatedFiles[0]!)).toBe(true);
      expect(JSON.parse(fs.readFileSync(argsFile, 'utf8'))).toEqual([fixture, result.generatedFiles[0]]);
      expect(getScipGenerationStatus(queries).languages.typescript?.state).toBe('generated');
      conn.close();
      const reopened = DatabaseConnection.open(dbPath);
      try {
        expect(getScipGenerationStatus(new QueryBuilder(reopened.getDb())).languages.typescript?.state).toBe('generated');
      } finally {
        reopened.close();
      }
    } finally {
      try { conn.close(); } catch (err) { void err; }
    }
  });

  it('passes --infer-tsconfig to the default TypeScript indexer', async () => {
    const { conn, queries, root } = createQueries();
    const oldPath = process.env.PATH;
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const bin = path.join(path.dirname(root), 'typescript-tools', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      const fixture = writeScipFixture(root, 'typescript-default.scip');
      const argsFile = path.join(root, 'typescript-args.json');
      const script = path.join(bin, 'fake-scip-typescript.js');
      fs.writeFileSync(script, [
        "const fs = require('fs');",
        'const args = process.argv.slice(2);',
        "if (args.includes('--version')) process.exit(0);",
        "if (args.includes('--infer-tsconfig') && !fs.existsSync('tsconfig.json')) fs.writeFileSync('tsconfig.json', '{}');",
        `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));`,
        "const output = args[args.indexOf('--output') + 1];",
        `fs.copyFileSync(${JSON.stringify(fixture)}, output);`,
      ].join('\n'));
      const shim = path.join(bin, process.platform === 'win32' ? 'scip-typescript.cmd' : 'scip-typescript');
      fs.writeFileSync(shim, process.platform === 'win32'
        ? ['@echo off', `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n')
        : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
      if (process.platform !== 'win32') fs.chmodSync(shim, 0o755);
      process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'auto',
        outputDir: path.join(root, 'out'),
      });

      expect(result.status.languages.typescript?.state).toBe('generated');
      expect(JSON.parse(fs.readFileSync(argsFile, 'utf8'))).toContain('--infer-tsconfig');
      expect(fs.existsSync(path.join(root, 'tsconfig.json'))).toBe(false);
    } finally {
      process.env.PATH = oldPath;
      conn.close();
    }
  });

  it('runs the default Go indexer from nested go.mod module roots', async () => {
    const { conn, queries, root } = createQueries();
    const oldPath = process.env.PATH;
    try {
      const moduleDir = path.join(root, 'RemarkableeYours-Qt', 'tablet-tools');
      fs.mkdirSync(moduleDir, { recursive: true });
      fs.writeFileSync(path.join(moduleDir, 'go.mod'), 'module example.com/tablet-tools\n');
      queries.upsertFile({ path: 'RemarkableeYours-Qt/tablet-tools/main.go', contentHash: 'hash', language: 'go', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const bin = path.join(path.dirname(root), 'go-tools', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      const fixture = writeScipFixture(root, 'go-default.scip', { projectRoot: moduleDir, relativePath: 'main.go', language: 'go', symbol: 'go example.com/tablet-tools main.', displayName: 'main' });
      const cwdFile = path.join(root, 'go-cwd.txt');
      const script = path.join(bin, 'fake-scip-go.js');
      fs.writeFileSync(script, [
        "const fs = require('fs');",
        'const args = process.argv.slice(2);',
        "if (args.includes('--version')) process.exit(0);",
        `fs.writeFileSync(${JSON.stringify(cwdFile)}, process.cwd());`,
        "const output = args[args.indexOf('--output') + 1];",
        `fs.copyFileSync(${JSON.stringify(fixture)}, output);`,
      ].join('\n'));
      const shim = path.join(bin, process.platform === 'win32' ? 'scip-go.cmd' : 'scip-go');
      fs.writeFileSync(shim, process.platform === 'win32'
        ? ['@echo off', `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n')
        : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
      if (process.platform !== 'win32') fs.chmodSync(shim, 0o755);
      process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'auto',
        outputDir: path.join(root, 'out'),
      });

      expect(result.status.languages.go?.state).toBe('generated');
      expect(fs.realpathSync(fs.readFileSync(cwdFile, 'utf8'))).toBe(fs.realpathSync(moduleDir));
    } finally {
      process.env.PATH = oldPath;
      conn.close();
    }
  });

  it('replacing an index removes stale facts when indexer metadata changes', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const indexFile = writeScipFixture(root, 'metadata-changing.scip', { localCollision: true, toolVersion: '1.0.0' });

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      expect(queries.searchScipSymbols('localValue')).toHaveLength(1);

      writeScipFixture(root, 'metadata-changing.scip', { toolVersion: '2.0.0' });
      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });

      expect(queries.getScipStats().indexes).toBe(1);
      expect(queries.searchScipSymbols('localValue')).toHaveLength(0);
    } finally {
      conn.close();
    }
  });

  it('replacing an index removes stale facts when SCIP project root metadata changes representation', async () => {
    const { conn, queries, root } = createQueries();
    try {
      const indexFile = writeScipFixture(root, 'metadata-root-changing.scip', { localCollision: true });

      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });
      expect(queries.searchScipSymbols('localValue')).toHaveLength(1);

      writeScipFixture(root, 'metadata-root-changing.scip', { projectRoot: `file:///${root.replace(/\\/g, '/')}` });
      await importScipIndexes(queries, { projectRoot: root, indexFiles: [indexFile] });

      expect(queries.getScipStats().indexes).toBe(1);
      expect(queries.searchScipSymbols('localValue')).toHaveLength(0);
    } finally {
      conn.close();
    }
  });

  it('kills SCIP indexer subprocess trees on timeout', async () => {
    const { conn, queries, root } = createQueries();
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const marker = path.join(root, 'child-survived.txt');
      const script = path.join(root, 'spawn-child.js');
      fs.writeFileSync(script, [
        "const { spawn } = require('child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 700);`)}], { stdio: 'ignore' });`,
        'setInterval(() => {}, 1000);',
      ].join('\n'));

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'auto',
        indexers: {
          typescript: { command: process.execPath, args: [script, '{output}'], files: ['**/*.ts'], timeoutMs: 100 },
        },
      });

      expect(result.status.languages.typescript?.state).toBe('failed');
      expect(result.status.languages.typescript?.message).toMatch(/timed out/i);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      conn.close();
    }
  });

  it.runIf(process.platform === 'win32')('does not resolve taskkill from project PATH during timeout cleanup', async () => {
    const { conn, queries, root } = createQueries();
    const oldPath = process.env.PATH;
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      const marker = path.join(root, 'fake-taskkill-ran.txt');
      fs.writeFileSync(path.join(bin, 'taskkill.cmd'), `@echo off\r\necho ran > ${JSON.stringify(marker)}\r\nexit /b 0\r\n`);
      process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
      const script = path.join(root, 'hang.js');
      fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'auto',
        indexers: {
          typescript: { command: process.execPath, args: [script, '{output}'], files: ['**/*.ts'], timeoutMs: 100 },
        },
      });

      expect(result.status.languages.typescript?.state).toBe('failed');
      expect(result.status.languages.typescript?.message).toMatch(/timed out/i);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = oldPath;
      conn.close();
    }
  });

  it('required mode fails on configured generator failure', async () => {
    const { conn, queries, root } = createQueries();
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const script = path.join(root, 'fail.js');
      fs.writeFileSync(script, "console.error('boom'); process.exit(7);\n");

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'required',
        indexers: {
          typescript: { command: process.execPath, args: [script, '{output}'], files: ['**/*.ts'] },
        },
      });

      expect(result.success).toBe(false);
      expect(result.status.languages.typescript?.state).toBe('failed');
      expect(result.errors[0]?.message).toMatch(/boom|exit code 7/i);
    } finally {
      conn.close();
    }
  });

  it('does not treat stale output as newly generated SCIP', async () => {
    const { conn, queries, root } = createQueries();
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const outputDir = path.join(root, 'scip-out');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'typescript.scip'), 'stale');
      const script = path.join(root, 'noop.js');
      fs.writeFileSync(script, 'process.exit(0);\n');

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'auto',
        outputDir,
        indexers: {
          typescript: { command: process.execPath, args: [script, '{output}'], files: ['**/*.ts'] },
        },
      });

      expect(result.success).toBe(true);
      expect(result.generatedFiles).toHaveLength(0);
      expect(result.status.languages.typescript?.state).toBe('failed');
      expect(result.status.languages.typescript?.message).toMatch(/did not write/i);
    } finally {
      conn.close();
    }
  });

  it('rejects empty generated SCIP indexes', async () => {
    const { conn, queries, root } = createQueries();
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const emptyIndex = writeEmptyScipFixture(root, 'empty.scip');
      const script = path.join(root, 'copy-empty-scip.js');
      fs.writeFileSync(script, "const fs = require('fs'); fs.copyFileSync(process.argv[2], process.argv[3]);\n");

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'required',
        indexers: {
          typescript: { command: process.execPath, args: [script, emptyIndex, '{output}'], files: ['**/*.ts'] },
        },
      });

      expect(result.success).toBe(false);
      expect(result.generatedFiles).toHaveLength(0);
      expect(result.status.languages.typescript?.state).toBe('failed');
      expect(result.errors[0]?.message).toMatch(/empty index/i);
    } finally {
      conn.close();
    }
  });

  it('refuses to write generated SCIP output outside the project root', async () => {
    const { conn, queries, root } = createQueries();
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const fixture = writeScipFixture(root, 'fixture.scip');
      const script = path.join(root, 'copy-scip.js');
      fs.writeFileSync(script, "const fs = require('fs'); fs.copyFileSync(process.argv[2], process.argv[3]);\n");

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'required',
        outputDir: path.join(path.dirname(root), 'outside-scip-out'),
        indexers: {
          typescript: { command: process.execPath, args: [script, fixture, '{output}'], files: ['**/*.ts'] },
        },
      });

      expect(result.success).toBe(false);
      expect(result.status.languages.typescript?.state).toBe('failed');
      expect(result.errors[0]?.message).toMatch(/outside project root/i);
    } finally {
      conn.close();
    }
  });

  it('required mode fails when a detected language has no configured generator', async () => {
    const { conn, queries, root } = createQueries();
    try {
      queries.upsertFile({ path: 'src/main.lua', contentHash: 'hash', language: 'lua', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'required',
        indexers: {},
      });

      expect(result.success).toBe(false);
      expect(result.status.languages.lua?.state).toBe('unsupported');
      expect(result.errors[0]?.message).toMatch(/No SCIP indexer configured/i);
    } finally {
      conn.close();
    }
  });

  it.runIf(process.platform === 'win32')('allows isolated external node_modules shims for default indexers', async () => {
    const { conn, queries, root } = createQueries();
    const oldPath = process.env.PATH;
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const externalRoot = path.join(path.dirname(root), 'external-tools');
      const bin = path.join(externalRoot, 'node_modules', '.bin');
      fs.mkdirSync(bin, { recursive: true });
      const fixture = writeScipFixture(root, 'external.scip');
      const copier = path.join(externalRoot, 'copy-scip.js');
      fs.writeFileSync(copier, "const fs = require('fs'); fs.copyFileSync(process.argv[2], process.argv.at(-1));\n");
      fs.writeFileSync(path.join(bin, 'scip-typescript'), '#!/bin/sh\nexit 1\n');
      const shim = path.join(bin, 'scip-typescript.cmd');
      fs.writeFileSync(shim, ['@echo off', `${JSON.stringify(process.execPath)} ${JSON.stringify(copier)} ${JSON.stringify(fixture)} %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n'));
      process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'auto',
        outputDir: path.join(root, 'out'),
      });

      expect(result.success).toBe(true);
      expect(result.status.languages.typescript?.message).toBeUndefined();
      expect(result.status.languages.typescript).toMatchObject({ state: 'generated' });
    } finally {
      process.env.PATH = oldPath;
      conn.close();
    }
  });

  it.runIf(process.platform === 'win32')('skips unsafe project-local default shims and uses a later external shim', async () => {
    const { conn, queries, root } = createQueries();
    const oldPath = process.env.PATH;
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const localBin = path.join(root, 'node_modules', '.bin');
      fs.mkdirSync(localBin, { recursive: true });
      fs.writeFileSync(path.join(localBin, 'scip-typescript.cmd'), '@echo off\r\nexit /b 99\r\n');

      const externalRoot = path.join(path.dirname(root), 'external-tools-later');
      const externalBin = path.join(externalRoot, 'node_modules', '.bin');
      fs.mkdirSync(externalBin, { recursive: true });
      const fixture = writeScipFixture(root, 'external-later.scip');
      const copier = path.join(externalRoot, 'copy-scip.js');
      fs.writeFileSync(copier, "const fs = require('fs'); fs.copyFileSync(process.argv[2], process.argv.at(-1));\n");
      fs.writeFileSync(path.join(externalBin, 'scip-typescript.cmd'), ['@echo off', `${JSON.stringify(process.execPath)} ${JSON.stringify(copier)} ${JSON.stringify(fixture)} %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n'));
      process.env.PATH = `${localBin}${path.delimiter}${externalBin}${path.delimiter}${oldPath ?? ''}`;

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'auto',
      });

      expect(result.success).toBe(true);
      expect(result.status.languages.typescript?.message).toBeUndefined();
      expect(result.status.languages.typescript).toMatchObject({ state: 'generated' });
      expect(result.status.languages.typescript?.command).toContain(externalBin);
    } finally {
      process.env.PATH = oldPath;
      conn.close();
    }
  });

  it.runIf(process.platform === 'win32')('passes metacharacter output paths to cmd shims literally', async () => {
    const { conn, queries, root } = createQueries();
    const oldPath = process.env.PATH;
    try {
      queries.upsertFile({ path: 'src/service.ts', contentHash: 'hash', language: 'typescript', size: 10, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      const externalRoot = path.join(path.dirname(root), 'external-tools-metachar');
      const bin = path.join(externalRoot, 'node_modules', '.bin');
      fs.mkdirSync(bin, { recursive: true });
      const fixture = writeScipFixture(root, 'external-metachar.scip');
      const argsFile = path.join(root, 'shim-args.json');
      const copier = path.join(externalRoot, 'copy-scip.js');
      fs.writeFileSync(copier, [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
        "fs.copyFileSync(process.argv[2], process.argv.at(-1));",
      ].join('\n'));
      fs.writeFileSync(path.join(bin, 'scip-typescript.cmd'), ['@echo off', `${JSON.stringify(process.execPath)} ${JSON.stringify(copier)} ${JSON.stringify(fixture)} %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n'));
      process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
      const outputDir = path.join(root, 'out & still literal');

      const result = await generateScipIndexes(queries, {
        projectRoot: root,
        mode: 'auto',
        outputDir,
      });

      expect(result.success).toBe(true);
      expect(result.status.languages.typescript?.message).toBeUndefined();
      expect(result.status.languages.typescript).toMatchObject({ state: 'generated' });
      expect(JSON.parse(fs.readFileSync(argsFile, 'utf8')).at(-1)).toBe(result.generatedFiles[0]);
    } finally {
      process.env.PATH = oldPath;
      conn.close();
    }
  });

  it.runIf(process.platform === 'win32')('detects Windows .cmd indexer shims on PATH', async () => {
    const { conn, root } = createQueries();
    const oldPath = process.env.PATH;
    try {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'fake-scip.cmd'), '@echo off\r\nexit /b 0\r\n');
      process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;

      const availability = await resolveScipIndexerAvailability({
        typescript: { command: 'fake-scip', files: ['**/*.ts'] },
      });

      expect(availability.typescript?.available).toBe(true);
    } finally {
      process.env.PATH = oldPath;
      conn.close();
    }
  });
});
