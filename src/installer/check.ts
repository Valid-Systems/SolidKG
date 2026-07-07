import * as fs from 'fs';
import * as path from 'path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { isInitialized } from '../directory';
import { SOLIDKG_SECTION_END, SOLIDKG_SECTION_START } from './instructions-template';
import { ALL_TARGETS, resolveTargetFlag } from './targets/registry';
import type { AgentTarget, Location, TargetId } from './targets/types';

type CheckLabel = 'ok' | 'warn' | 'check';

export interface RunInstallCheckOptions {
  target?: string;
  location?: Location;
}

export interface InstallCheckRow {
  id: TargetId;
  displayName: string;
  label: CheckLabel;
  mcp: 'configured' | 'missing' | 'unsupported' | 'warning';
  guidance: 'present' | 'legacy' | 'missing' | 'not-applicable';
  paths: string[];
  warnings: string[];
  nextCommands: string[];
}

export interface InstallCheckReport {
  location: Location;
  projectPath: string;
  projectInitialized: boolean;
  rows: InstallCheckRow[];
  nextCommands: string[];
}

interface ReadResult {
  exists: boolean;
  content: string;
  warning?: string;
}

export function buildInstallCheckReport(options: RunInstallCheckOptions = {}): InstallCheckReport {
  const location = options.location ?? 'global';
  const targets = options.target === undefined
    ? [...ALL_TARGETS]
    : resolveTargetFlag(options.target, location);
  const projectPath = process.cwd();
  const projectInitialized = isInitialized(projectPath);
  const rows = targets.map((target) => inspectTarget(target, location));
  const nextCommands = buildNextCommands(projectInitialized, rows);

  return {
    location,
    projectPath,
    projectInitialized,
    rows,
    nextCommands,
  };
}

export function formatInstallCheckReport(report: InstallCheckReport): string {
  const lines: string[] = [];
  lines.push('SolidKG install setup check');
  lines.push(`Scope: ${report.location} (read-only; default target set is all supported targets)`);
  lines.push(`Project: ${report.projectPath}`);
  lines.push(`${statusLabel(report.projectInitialized ? 'ok' : 'check')} Project initialized: ${report.projectInitialized ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('Targets:');

  for (const row of report.rows) {
    const guidance = row.guidance === 'not-applicable'
      ? 'guidance n/a'
      : `guidance ${row.guidance}`;
    lines.push(`${statusLabel(row.label)} ${row.displayName}: MCP ${row.mcp}; ${guidance}`);
    if (row.paths.length > 0) {
      lines.push(`    paths: ${row.paths.join(', ')}`);
    }
    for (const warning of row.warnings) {
      lines.push(`    warning: ${warning}`);
    }
  }

  lines.push('');
  lines.push('Next commands:');
  if (report.nextCommands.length === 0) {
    lines.push('  No action needed.');
  } else {
    for (const command of report.nextCommands) {
      lines.push(`  ${command}`);
    }
  }
  lines.push('');
  lines.push('No files were modified.');
  return lines.join('\n') + '\n';
}

export function runInstallCheck(options: RunInstallCheckOptions = {}): void {
  process.stdout.write(formatInstallCheckReport(buildInstallCheckReport(options)));
}

function inspectTarget(target: AgentTarget, location: Location): InstallCheckRow {
  if (!target.supportsLocation(location)) {
    return {
      id: target.id,
      displayName: target.displayName,
      label: 'check',
      mcp: 'unsupported',
      guidance: 'not-applicable',
      paths: [],
      warnings: [`${target.displayName} does not support --location=${location}.`],
      nextCommands: [],
    };
  }

  const paths = target.describePaths(location);
  const mcpPath = findMcpPath(target, paths);
  const guidancePath = findGuidancePath(target, paths);
  const warnings: string[] = [];
  const mcp = inspectMcp(target, mcpPath);
  if (mcp.warning) warnings.push(mcp.warning);
  const guidance = guidancePath ? inspectGuidance(guidancePath) : 'not-applicable';
  const label: CheckLabel = warnings.length > 0
    ? 'warn'
    : mcp.configured && (guidance === 'present' || guidance === 'legacy' || guidance === 'not-applicable')
      ? 'ok'
      : 'check';
  const nextCommands = label === 'ok'
    ? []
    : [`solidkg install --target ${target.id} --location ${location}`];

  return {
    id: target.id,
    displayName: target.displayName,
    label,
    mcp: warnings.length > 0 ? 'warning' : mcp.configured ? 'configured' : 'missing',
    guidance,
    paths,
    warnings,
    nextCommands,
  };
}

function inspectMcp(target: AgentTarget, filePath: string | undefined): { configured: boolean; warning?: string } {
  if (!filePath) return { configured: false };
  const read = readText(filePath);
  if (!read.exists) return { configured: false };
  if (read.warning) return { configured: false, warning: read.warning };

  if (target.id === 'codex') {
    const warning = validateTomlEnoughForCheck(filePath, read.content);
    if (warning) return { configured: false, warning };
    return { configured: read.content.includes('[mcp_servers.solidkg]') };
  }

  if (target.id === 'hermes') {
    const warning = validateYamlEnoughForCheck(filePath, read.content);
    if (warning) return { configured: false, warning };
    return { configured: hasYamlSolidKGServer(read.content) };
  }

  if (target.id === 'opencode') {
    const parsed = parseJsonLike(filePath, read.content, true);
    if (parsed.warning) return { configured: false, warning: parsed.warning };
    return { configured: !!parsed.value?.mcp?.solidkg };
  }

  const parsed = parseJsonLike(filePath, read.content, false);
  if (parsed.warning) return { configured: false, warning: parsed.warning };
  return { configured: !!parsed.value?.mcpServers?.solidkg };
}

function inspectGuidance(filePath: string): InstallCheckRow['guidance'] {
  const read = readText(filePath);
  if (!read.exists || read.warning) return 'missing';
  const hasStart = read.content.includes(SOLIDKG_SECTION_START);
  const hasEnd = read.content.includes(SOLIDKG_SECTION_END);
  if (hasStart && hasEnd) return 'present';
  if (/^## SolidKG\s*$/m.test(read.content)) return 'legacy';
  return 'missing';
}

function findMcpPath(target: AgentTarget, paths: string[]): string | undefined {
  if (target.id === 'claude') return paths.find((p) => path.basename(p) !== 'settings.json' && isConfigPath(p));
  return paths.find(isConfigPath);
}

function findGuidancePath(target: AgentTarget, paths: string[]): string | undefined {
  if (target.id === 'claude') return paths.find((p) => path.basename(p) === 'CLAUDE.md');
  if (target.id === 'cursor') return paths.find((p) => path.basename(p) === 'solidkg.mdc');
  if (target.id === 'codex' || target.id === 'opencode') return paths.find((p) => path.basename(p) === 'AGENTS.md');
  return undefined;
}

function isConfigPath(filePath: string): boolean {
  return /\.(json|jsonc|toml|ya?ml)$/i.test(filePath);
}

function readText(filePath: string): ReadResult {
  if (!fs.existsSync(filePath)) return { exists: false, content: '' };
  try {
    return { exists: true, content: fs.readFileSync(filePath, 'utf-8') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exists: true, content: '', warning: `Could not read ${filePath}: ${msg}. Fix manually; check mode did not rewrite it.` };
  }
}

function parseJsonLike(filePath: string, content: string, jsonc: boolean): { value?: Record<string, any>; warning?: string } {
  try {
    if (!content.trim()) return { value: {} };
    if (jsonc) {
      const errors: ParseError[] = [];
      const value = parseJsonc(content, errors, { allowTrailingComma: true });
      if (errors.length > 0 || value == null || typeof value !== 'object' || Array.isArray(value)) {
        return { warning: `Could not parse ${filePath}. Fix manually; check mode did not rewrite or back it up.` };
      }
      return { value: value as Record<string, any> };
    }
    const value = JSON.parse(content);
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      return { warning: `Could not parse ${filePath} as an object. Fix manually; check mode did not rewrite or back it up.` };
    }
    return { value: value as Record<string, any> };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { warning: `Could not parse ${filePath}: ${msg}. Fix manually; check mode did not rewrite or back it up.` };
  }
}

function validateTomlEnoughForCheck(filePath: string, content: string): string | undefined {
  const badHeader = content.split(/\r?\n/).find((line) => line.trim().startsWith('[') && !line.trim().endsWith(']'));
  return badHeader
    ? `Could not parse ${filePath}: malformed TOML table header. Fix manually; check mode did not rewrite or back it up.`
    : undefined;
}

function validateYamlEnoughForCheck(filePath: string, content: string): string | undefined {
  const tabIndented = content.split(/\r?\n/).find((line) => /^\t+\S/.test(line));
  return tabIndented
    ? `Could not parse ${filePath}: tab-indented YAML is unsupported. Fix manually; check mode did not rewrite or back it up.`
    : undefined;
}

function hasYamlSolidKGServer(content: string): boolean {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const parentIndex = lines.findIndex((line) => line.trim() === 'mcp_servers:');
  if (parentIndex === -1) return false;
  for (let index = parentIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_-]*:\s*(?:#.*)?$/.test(line)) break;
    if (/^\s{2}solidkg:\s*(?:#.*)?$/.test(line)) return true;
  }
  return false;
}

function buildNextCommands(projectInitialized: boolean, rows: InstallCheckRow[]): string[] {
  const commands = new Set<string>();
  for (const row of rows) {
    for (const command of row.nextCommands) commands.add(command);
  }
  if (!projectInitialized) commands.add('solidkg init');
  const hasInstallerAction = [...commands].some((command) => command.startsWith('solidkg install '));
  if (hasInstallerAction) commands.add('restart your agent after installer changes');
  return [...commands];
}

function statusLabel(label: CheckLabel): string {
  return `[${label}]`;
}
