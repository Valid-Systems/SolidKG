import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SolidKG } from '../src';

describe('callback synthesizer dedupe', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-callback-dedupe-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves distinct synthesized mechanisms between the same source and target', async () => {
    fs.writeFileSync(
      path.join(dir, 'Widget.vue'),
      `<template>
  <same-target @click="SameTarget" />
</template>

<script>
export default {
  name: 'Widget',
};
</script>
`
    );
    fs.writeFileSync(
      path.join(dir, 'same-target.ts'),
      `export function SameTarget() {
  return null;
}
`
    );

    const graph = await SolidKG.init(dir, { silent: true });
    try {
      await graph.indexAll();

      const component = graph.getNodesByKind('component').find((node) => node.name === 'Widget');
      const target = graph.getNodesByKind('function').find((node) => node.name === 'SameTarget');
      expect(component).toBeDefined();
      expect(target).toBeDefined();
      if (!component || !target) throw new Error('fixture nodes were not indexed');

      const mechanisms = graph
        .getOutgoingEdges(component.id)
        .filter((edge) => edge.target === target.id)
        .map((edge) => edge.metadata?.synthesizedBy)
        .sort();

      expect(mechanisms).toEqual(['jsx-render', 'vue-handler']);
    } finally {
      graph.close();
    }
  });
});
