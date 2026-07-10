import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SolidKG } from '../src';
import { MCPEngine } from '../src/mcp/engine';

const temporaryDirectories: string[] = [];
const engines: MCPEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('MCPEngine catch-up sync scheduling', () => {
  it('waits for an idle window after tool execution before syncing', async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-mcp-engine-'));
    temporaryDirectories.push(projectPath);
    fs.writeFileSync(path.join(projectPath, 'entry.ts'), 'export function entry(): number { return 1; }\n');
    const indexed = await SolidKG.init(projectPath, { index: true });
    indexed.close();

    vi.useFakeTimers();
    const syncSpy = vi.spyOn(SolidKG.prototype, 'sync').mockResolvedValue({
      filesChecked: 0,
      filesAdded: 0,
      filesModified: 0,
      filesRemoved: 0,
      nodesUpdated: 0,
      durationMs: 0,
    });
    const engine = new MCPEngine({ watch: false });
    engines.push(engine);
    engine.setProjectPathHint(projectPath);
    await engine.ensureInitialized(projectPath);

    expect(syncSpy).not.toHaveBeenCalled();
    engine.beginToolCall();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncSpy).not.toHaveBeenCalled();

    engine.endToolCall();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(syncSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(syncSpy).toHaveBeenCalledOnce();
  });
});
