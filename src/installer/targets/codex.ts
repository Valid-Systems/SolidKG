/**
 * OpenAI Codex CLI target.
 *
 *   - MCP server entry to `~/.codex/config.toml` as the dotted-key
 *     table `[mcp_servers.solidkg]`. TOML — not JSON — handled by
 *     the narrow serializer in `./toml.ts`.
 *   - Instructions to `~/.codex/AGENTS.md`.
 *
 * Codex CLI as of 2026-05 has no project-local config concept —
 * everything lives under `~/.codex/`. `supportsLocation('local')`
 * returns false; the orchestrator skips Codex when the user picks
 * the local install location.
 *
 * No permissions concept.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  getMcpServerConfig,
  removeMarkedSection,
  replaceOrAppendMarkedSection,
  unlinkFileWithBackup,
} from './shared';
import {
  SOLIDKG_SECTION_END,
  SOLIDKG_SECTION_START,
  LEGACY_CODEGRAPH_SECTION_END,
  LEGACY_CODEGRAPH_SECTION_START,
  INSTRUCTIONS_TEMPLATE,
} from '../instructions-template';
import { buildTomlTable, removeTomlTable, removeTomlTablesByPrefix, upsertTomlTable } from './toml';

const TOML_HEADER = 'mcp_servers.solidkg';
const LEGACY_TOML_HEADER = 'mcp_servers.codegraph';
const CODEX_STARTUP_TIMEOUT_SEC = 10;
const CODEX_TOOL_TIMEOUT_SEC = 35;

function configDir(): string {
  return path.join(os.homedir(), '.codex');
}
function tomlConfigPath(): string {
  return path.join(configDir(), 'config.toml');
}
function instructionsPath(): string {
  return path.join(configDir(), 'AGENTS.md');
}

class CodexTarget implements AgentTarget {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly docsUrl = 'https://github.com/openai/codex';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const tomlPath = tomlConfigPath();
    let alreadyConfigured = false;
    if (fs.existsSync(tomlPath)) {
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        alreadyConfigured = content.includes(`[${TOML_HEADER}]`);
      } catch { /* ignore */ }
    }
    const installed = fs.existsSync(configDir());
    return { installed, alreadyConfigured, configPath: tomlPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Codex CLI has no project-local config — re-run with --location=global to install.'],
      };
    }
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry());
    files.push(writeInstructionsEntry());

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const files: WriteResult['files'] = [];

    const tomlPath = tomlConfigPath();
    if (fs.existsSync(tomlPath)) {
      const content = fs.readFileSync(tomlPath, 'utf-8');
      const { content: nextContent, action } = removeTomlTable(content, TOML_HEADER);
      if (action === 'removed') {
        if (nextContent.trim() === '') {
          try { unlinkFileWithBackup(tomlPath); } catch { /* ignore */ }
        } else {
          atomicWriteFileSync(tomlPath, nextContent.trimEnd() + '\n');
        }
        files.push({ path: tomlPath, action: 'removed' });
      } else {
        files.push({ path: tomlPath, action: 'not-found' });
      }
    } else {
      files.push({ path: tomlPath, action: 'not-found' });
    }

    const instr = instructionsPath();
    const instrAction = removeMarkedSection(instr, SOLIDKG_SECTION_START, SOLIDKG_SECTION_END);
    files.push({ path: instr, action: instrAction });

    return { files };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Codex CLI has no project-local config — use --location=global.\n';
    }
    const block = buildSolidKGBlock();
    return `# Add to ${tomlConfigPath()}\n\n${block}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    return [tomlConfigPath(), instructionsPath()];
  }
}

function buildSolidKGBlock(): string {
  const mcp = getMcpServerConfig();
  return buildTomlTable(TOML_HEADER, {
    command: mcp.command,
    args: mcp.args,
    startup_timeout_sec: CODEX_STARTUP_TIMEOUT_SEC,
    tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC,
  });
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = tomlConfigPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const block = buildSolidKGBlock();
  // Single read — `existing === ''` derives both "is the file empty
  // or absent" and "what was its content," avoiding a TOCTOU window
  // between two `fs.existsSync` calls.
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const created = existing.length === 0;
  const legacyCleanup = removeTomlTablesByPrefix(existing, LEGACY_TOML_HEADER);
  const { content: nextContent, action } = upsertTomlTable(legacyCleanup.content, TOML_HEADER, block);

  if (action === 'unchanged' && legacyCleanup.action === 'not-found') {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, nextContent);
  return { path: file, action: created ? 'created' : 'updated' };
}

function writeInstructionsEntry(): WriteResult['files'][number] {
  const file = instructionsPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  removeMarkedSection(file, LEGACY_CODEGRAPH_SECTION_START, LEGACY_CODEGRAPH_SECTION_END);
  const action = replaceOrAppendMarkedSection(
    file,
    INSTRUCTIONS_TEMPLATE,
    SOLIDKG_SECTION_START,
    SOLIDKG_SECTION_END,
  );
  const mapped: 'created' | 'updated' | 'unchanged' =
    action === 'created' ? 'created'
      : action === 'unchanged' ? 'unchanged'
        : 'updated';
  return { path: file, action: mapped };
}

export const codexTarget: AgentTarget = new CodexTarget();
