import { describe, expect, it } from 'vitest';
import { isGeneratedFile, isGeneratedFileQuery } from '../src/search/path-classifiers';
import { selectRequiredRetrievalConcepts } from '../src/search/query-concepts';
import {
  buildSourceChunkFtsQuery,
  extractExcludedRetrievalTerms,
  hasProductionRetrievalIntent,
  isNonProductionQuery,
  scorePathRelevance,
  selectRetrievalSearchTerms,
} from '../src/search/query-utils';

describe('search path classifiers', () => {
  it('identifies generated source paths without matching normal source', () => {
    expect(isGeneratedFile('src/__generated__/user.ts')).toBe(true);
    expect(isGeneratedFile('src/api/user.pb.go')).toBe(true);
    expect(isGeneratedFile('src/protos/user_pb2_grpc.py')).toBe(true);
    expect(isGeneratedFile('src/protos/user_grpc_pb.ts')).toBe(true);
    expect(isGeneratedFile('src/forms/MainForm.designer.cs')).toBe(true);
    expect(isGeneratedFile('src/api/user-service.ts')).toBe(false);
    expect(isGeneratedFile('src/api/billing-grpc-client.ts')).toBe(false);
  });

  it('deprioritizes generated files unless the query asks for generated code', () => {
    const sourceScore = scorePathRelevance('src/user/service.ts', 'user service flow');
    const generatedScore = scorePathRelevance('src/__generated__/user/service.ts', 'user service flow');
    const explicitGeneratedScore = scorePathRelevance('src/__generated__/user/service.ts', 'generated user service flow');

    expect(generatedScore).toBeLessThan(sourceScore);
    expect(explicitGeneratedScore).toBeGreaterThan(generatedScore);
    expect(isGeneratedFileQuery('inspect protobuf generated bindings')).toBe(true);
    expect(isGeneratedFileQuery('inspect src/api/user.pb.go')).toBe(true);
    expect(isGeneratedFileQuery('open MainForm.designer.cs')).toBe(true);
    expect(isGeneratedFileQuery('debug user.g.ts')).toBe(true);
  });

  it('bounds long natural-language retrieval queries before SQLite FTS expansion', () => {
    const query = 'How does the VS Code extension host communicate with the main process? Trace startup and bidirectional IPC RPC between renderer workbench ExtensionHostProcessWorker ExtensionHostMain protocol MessagePort NamedPipe socket MainThreadCustomers ExtHostCustomers.';

    const terms = selectRetrievalSearchTerms(query, 8);
    const ftsQuery = buildSourceChunkFtsQuery(query);

    expect(terms).toHaveLength(8);
    expect(ftsQuery.split(' OR ')).toHaveLength(6);
    expect(ftsQuery).not.toContain('ExtHostCustomers');
  });

  it('keeps exclusion clauses out of positive retrieval and does not reinterpret excluded tests as test intent', () => {
    const query = 'Find the production DAG parsing implementation, not the API model or its tests';

    expect(extractExcludedRetrievalTerms(query)).toEqual(['model', 'tests']);
    expect(selectRetrievalSearchTerms(query, 8)).toEqual(['dag', 'parsing']);
    expect(scorePathRelevance('src/dag_processing/dagbag.py', query))
      .toBeGreaterThan(scorePathRelevance('tests/api/models/test_dagbag.py', query));
    expect(scorePathRelevance('tests/api/models/test_dagbag.py', 'inspect DagBag tests'))
      .toBeGreaterThan(scorePathRelevance('tests/api/models/test_dagbag.py', query));
  });

  it('penalizes explicitly excluded metadata paths while preserving implementation terms', () => {
    const query = 'Find the production implementation that sends Azure REST requests, excluding serialized command metadata';

    expect(selectRetrievalSearchTerms(query, 8)).toEqual(['sends', 'azure', 'rest', 'requests']);
    expect(scorePathRelevance('src/Accounts/Rest/InvokeRestMethodCommand.cs', query))
      .toBeGreaterThan(scorePathRelevance('tools/SerializedCmdlets/CommandMetadata.cs', query));
  });

  it('keeps positive non-production intent separate from exclusions', () => {
    const testQuery = 'Show tests excluding snapshots';
    const generatedQuery = 'Inspect generated clients without test fixtures';

    expect(isNonProductionQuery(testQuery)).toBe(true);
    expect(hasProductionRetrievalIntent(testQuery)).toBe(false);
    expect(isNonProductionQuery(generatedQuery)).toBe(true);
    expect(hasProductionRetrievalIntent(generatedQuery)).toBe(false);
    expect(selectRetrievalSearchTerms(testQuery, 8)).toContain('tests');
    expect(selectRetrievalSearchTerms(testQuery, 8)).not.toContain('snapshots');
    expect(selectRetrievalSearchTerms('API command implementation', 8)).toEqual(['api', 'command']);
  });

  it('does not reinterpret ordinary grammatical negation as a retrieval exclusion', () => {
    expect(extractExcludedRetrievalTerms('Explain what happens when the cache is not available')).toEqual([]);
    expect(extractExcludedRetrievalTerms('Find code that does not cache but persists results')).toEqual([]);
    expect(extractExcludedRetrievalTerms('Find not only tests but also production code')).toEqual([]);
    expect(extractExcludedRetrievalTerms('How does the scheduler run tasks without blocking the event loop?')).toEqual([]);
    expect(selectRetrievalSearchTerms('How does the scheduler run tasks without blocking the event loop?', 10))
      .toEqual(['scheduler', 'run', 'tasks', 'blocking', 'event', 'loop']);
  });

  it('keeps qualified identifiers but excludes product subjects and lifecycle prose from required concepts', () => {
    const query = 'How does Alamofire build, send, and validate a request? Trace Session.request creation and Request/RequestTaskMap construction, not tests.';

    expect(selectRequiredRetrievalConcepts(query, 20)).toEqual([
      'session.request',
      'request/requesttaskmap',
    ]);
  });
});
