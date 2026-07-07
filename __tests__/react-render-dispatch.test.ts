import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SolidKG } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('React setState render dispatch synthesis', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('does not synthesize helper to render edges without setState', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-react-render-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    fs.writeFileSync(
      path.join(tmpDir, 'App.tsx'),
      'import React from "react";\n' +
        'export class Counter extends React.Component {\n' +
        '  helper() { return 1; }\n' +
        '  update() { this.setState({ count: 1 }); }\n' +
        '  render() { return <div>{this.helper()}</div>; }\n' +
        '}\n'
    );

    const cg = SolidKG.initSync(tmpDir);
    try {
      await cg.indexAll();

      const methods = cg.getNodesByKind('method');
      const helper = methods.find((node) => node.name === 'helper');
      const update = methods.find((node) => node.name === 'update');
      const render = methods.find((node) => node.name === 'render');
      expect(helper).toBeDefined();
      expect(update).toBeDefined();
      expect(render).toBeDefined();

      const helperRenderEdge = cg
        .getOutgoingEdges(helper!.id)
        .find((edge) => edge.target === render!.id && edge.metadata?.synthesizedBy === 'react-render');
      const updateRenderEdge = cg
        .getOutgoingEdges(update!.id)
        .find((edge) => edge.target === render!.id && edge.metadata?.synthesizedBy === 'react-render');

      expect(helperRenderEdge).toBeUndefined();
      expect(updateRenderEdge).toBeDefined();
    } finally {
      cg.close();
    }
  });
});
