import { createHash } from 'crypto';
import type { CapabilityAssertion } from './types';

export function capabilityAssertionId(input: Omit<CapabilityAssertion, 'id'>): string {
  const stable = [
    input.subjectNodeId,
    input.operation,
    input.resourceKind,
    input.resourceKey,
    input.targetNodeId ?? '',
    input.scope,
    input.filePath,
    input.startLine,
    input.startColumn,
    input.endLine,
    input.endColumn,
    input.origin,
    input.certainty,
    input.producerId,
    input.ruleId,
    input.producerVersion,
    input.supportingHyperedgeId ?? '',
  ].join('\0');
  return `capability:${createHash('sha256').update(stable).digest('hex').slice(0, 24)}`;
}
