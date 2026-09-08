/// <reference types="node" />

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { MemberCallEvidence, UnresolvedReference } from '../src/types';

describe('member-call binding persistence', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('round-trips every binding variant and preserves legacy binding absence after reopening', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-member-call-binding-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'graph.db');
    const memberCalls = [
      {
        receiver: 'service',
        member: 'run',
        binding: {
          kind: 'local',
          ownerFilePath: 'src/service.ts',
          ownerStartLine: 4,
          ownerStartColumn: 6,
          access: 'instance',
        },
      },
      {
        receiver: 'Service',
        member: 'build',
        binding: {
          kind: 'local',
          ownerFilePath: 'src/service.ts',
          ownerStartLine: 4,
          ownerStartColumn: 6,
          access: 'static',
        },
      },
      {
        receiver: 'namespace',
        member: 'run',
        binding: {
          kind: 'import',
          localName: 'namespace',
          exportPath: ['Service'],
          access: 'namespace',
        },
      },
      {
        receiver: 'NativeModule',
        member: 'perform',
        binding: {
          kind: 'native',
          moduleName: 'ExpoHaptics',
        },
      },
      {
        receiver: 'uncertain',
        member: 'run',
        binding: { kind: 'unknown' },
      },
      {
        receiver: 'legacy',
        member: 'run',
      },
    ] satisfies readonly MemberCallEvidence[];
    const references = memberCalls.map((memberCall, index) => ({
      fromNodeId: 'function:caller',
      referenceName: `${memberCall.receiver}.${memberCall.member}`,
      referenceKind: 'calls',
      line: index + 1,
      column: 0,
      candidates: [`candidate-${index}`],
      filePath: 'src/caller.ts',
      language: 'typescript',
      memberCall,
    })) satisfies readonly UnresolvedReference[];

    const initialized = DatabaseConnection.initialize(databasePath);
    try {
      const queries = new QueryBuilder(initialized.getDb());
      queries.insertNode({
        id: 'function:caller',
        kind: 'function',
        name: 'caller',
        qualifiedName: 'caller',
        filePath: 'src/caller.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      });
      queries.insertUnresolvedRefsBatch([...references]);
    } finally {
      initialized.close();
    }

    const reopened = DatabaseConnection.open(databasePath);
    try {
      const persisted = new QueryBuilder(reopened.getDb()).getUnresolvedReferences();

      expect(persisted.map((reference) => reference.memberCall)).toEqual(memberCalls);
      expect(persisted.map((reference) => reference.candidates)).toEqual(
        references.map((reference) => reference.candidates),
      );
      expect(persisted[4]?.memberCall?.binding).toEqual({ kind: 'unknown' });
      expect(persisted[5]?.memberCall?.binding).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it('normalizes a malformed tagged binding to explicit unknown evidence instead of legacy absence', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-member-call-binding-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'graph.db');
    const initialized = DatabaseConnection.initialize(databasePath);
    try {
      const queries = new QueryBuilder(initialized.getDb());
      queries.insertNode({
        id: 'function:caller',
        kind: 'function',
        name: 'caller',
        qualifiedName: 'caller',
        filePath: 'src/caller.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      });
      initialized.getDb().prepare(
        'INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'function:caller',
        'service.run',
        'calls',
        1,
        0,
        JSON.stringify(['__solidkg_member_call__:{"receiver":"service","member":"run","binding":{"kind":"local"}}']),
        'src/caller.ts',
        'typescript',
      );
    } finally {
      initialized.close();
    }

    const reopened = DatabaseConnection.open(databasePath);
    try {
      expect(new QueryBuilder(reopened.getDb()).getUnresolvedReferences()[0]?.memberCall).toEqual({
        receiver: 'service',
        member: 'run',
        binding: { kind: 'unknown' },
      });
    } finally {
      reopened.close();
    }
  });
});
