import * as crypto from 'crypto';
import type { HyperedgeKind } from '../types';

export type StableJsonValue =
  | null
  | boolean
  | number
  | string
  | StableJsonValue[]
  | { [key: string]: StableJsonValue };

export function stableJson(value: StableJsonValue): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value);
    case 'object': {
      const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
      return `{${entries
        .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
        .join(',')}}`;
    }
  }
}

export function hyperedgeId(kind: HyperedgeKind, identity: StableJsonValue): string {
  const payload = stableJson({ kind, identity });
  const hash = crypto.createHash('sha1').update(payload).digest('hex');
  return `he:${kind}:${hash}`;
}