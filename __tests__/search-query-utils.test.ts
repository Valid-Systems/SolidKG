import { describe, expect, it } from 'vitest';
import { isGeneratedFile, isGeneratedFileQuery } from '../src/search/path-classifiers';
import { scorePathRelevance } from '../src/search/query-utils';

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
});
