import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types';
import { getMcpServerConfig, jsonDeepEqual, readJsonFile, writeJsonFile } from './shared';

const OMP_SCHEMA = 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json';

function mcpConfigPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.omp', 'agent', 'mcp.json')
    : path.join(process.cwd(), '.omp', 'mcp.json');
}

function configDir(loc: Location): string {
  return path.dirname(mcpConfigPath(loc));
}

class OmpTarget implements AgentTarget {
  readonly id = 'omp' as const;
  readonly displayName = 'OMP / Pi coding agent';
  readonly docsUrl = 'https://github.com/can1357/oh-my-pi/blob/HEAD/docs/mcp-config.md';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpConfigPath(loc);
    const config = readJsonFile(file);
    return {
      installed: fs.existsSync(configDir(loc)) || fs.existsSync(file),
      alreadyConfigured: !!config.mcpServers?.solidkg,
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return { files: [writeMcpEntry(loc)] };
  }

  uninstall(loc: Location): WriteResult {
    const file = mcpConfigPath(loc);
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
    const snippet = JSON.stringify({ $schema: OMP_SCHEMA, mcpServers: { solidkg: getMcpServerConfig() } }, null, 2);
    return `# Add to ${mcpConfigPath(loc)}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpConfigPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpConfigPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.solidkg;
  const after = getMcpServerConfig();
  const schemaBefore = existing.$schema;
  if (jsonDeepEqual(before, after) && schemaBefore === OMP_SCHEMA) return { path: file, action: 'unchanged' };
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  existing.$schema = OMP_SCHEMA;
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.solidkg = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export const ompTarget: AgentTarget = new OmpTarget();
