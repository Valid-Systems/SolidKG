import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types';
import { jsonDeepEqual, readJsonFile, writeJsonFile } from './shared';

function configDir(): string {
  return path.join(os.homedir(), '.kimi');
}

function mcpConfigPath(): string {
  return path.join(configDir(), 'mcp.json');
}

function solidkgServerConfig(): { command: string; args: string[] } {
  return { command: 'solidkg', args: ['serve', '--mcp'] };
}

class KimiTarget implements AgentTarget {
  readonly id = 'kimi' as const;
  readonly displayName = 'Kimi Code';
  readonly docsUrl = 'https://github.com/MoonshotAI/kimi-cli';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') return { installed: false, alreadyConfigured: false };
    const file = mcpConfigPath();
    const config = readJsonFile(file);
    return {
      installed: fs.existsSync(configDir()) || fs.existsSync(file),
      alreadyConfigured: !!config.mcpServers?.solidkg,
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return { files: [], notes: ['Kimi Code auto-loads ~/.kimi/mcp.json; re-run with --location=global.'] };
    }
    return { files: [writeMcpEntry()] };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const file = mcpConfigPath();
    const config = readJsonFile(file);
    if (config.mcpServers?.solidkg) {
      delete config.mcpServers.solidkg;
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeJsonFile(file, config);
      return { files: [{ path: file, action: 'removed' }] };
    }
    return { files: [{ path: file, action: 'not-found' }] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') return '# Kimi Code auto-loads ~/.kimi/mcp.json; use --location=global.\n';
    const snippet = JSON.stringify({ mcpServers: { solidkg: solidkgServerConfig() } }, null, 2);
    return `# Add to ${mcpConfigPath()}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [mcpConfigPath()] : [];
  }
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = mcpConfigPath();
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.solidkg;
  const after = solidkgServerConfig();
  if (jsonDeepEqual(before, after)) return { path: file, action: 'unchanged' };
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.solidkg = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export const kimiTarget: AgentTarget = new KimiTarget();
