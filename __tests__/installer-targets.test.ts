/**
 * Multi-target installer tests.
 *
 * Each `AgentTarget` is exercised against the same contract:
 *   - `install` writes the expected files
 *   - re-running `install` is byte-identical (idempotent)
 *   - sibling MCP servers / unrelated config is preserved
 *   - `uninstall` reverses `install`
 *   - `printConfig` returns parseable, non-empty content
 *
 * For agent-config destinations we redirect HOME to a tmpdir via
 * `os.homedir` spying, and CWD via `process.chdir` — same pattern as
 * the legacy `installer.test.ts`. No real `~/.claude/` etc. ever
 * touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { parse as parseJsonc } from 'jsonc-parser';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ALL_TARGETS, getTarget, resolveTargetFlag } from '../src/installer/targets/registry';
import { uninstallTargets } from '../src/installer';
import { buildInstallCheckReport, formatInstallCheckReport } from '../src/installer/check';
import { upsertTomlTable, removeTomlTable, removeTomlTablesByPrefix, buildTomlTable } from '../src/installer/targets/toml';
import { cleanupLegacyHooks } from '../src/installer/targets/claude';
import { getSolidKGPermissions } from '../src/installer/targets/shared';
import { INSTRUCTIONS_TEMPLATE } from '../src/installer/instructions-template';

function mkTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-targets-${label}-`));
}

function listBackupsFor(filePath: string): string[] {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) return [];
  const prefix = path.basename(filePath) + '.solidkg-backup.';
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(dir, name));
}

function seedExistingTargetFile(targetId: string, filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let content: string;
  if (/\.jsonc?$/.test(filePath)) {
    if (targetId === 'opencode') {
      content = '{\n  // keep this comment\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "other": { "type": "local", "command": ["x"], "enabled": true }\n  }\n}\n';
    } else {
      content = JSON.stringify({ mcpServers: { other: { command: 'x' } }, keep: true }, null, 2) + '\n';
    }
  } else if (/\.toml$/.test(filePath)) {
    content = '[profile]\nmodel = "gpt-5.5"\n';
  } else if (/\.ya?ml$/.test(filePath)) {
    content = 'model:\n  default: qwen-3.7\n';
  } else {
    content = '# Existing user instructions\n\nKeep this section.\n';
  }
  fs.writeFileSync(filePath, content);
  return content;
}

// `os.homedir` is non-configurable on Node, so we redirect it via the
// `$HOME` (POSIX) / `$USERPROFILE` (Windows) env vars that
// `os.homedir()` reads first. Same trick the rest of the suite uses
// when it needs a mock home.
function setHome(dir: string): { restore: () => void } {
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HERMES_HOME: process.env.HERMES_HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    npm_config_userconfig: process.env.npm_config_userconfig,
    NPM_CONFIG_USERCONFIG: process.env.NPM_CONFIG_USERCONFIG,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.APPDATA = path.join(dir, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(dir, 'AppData', 'Local');
  process.env.XDG_CONFIG_HOME = path.join(dir, '.config');
  process.env.TMPDIR = path.join(dir, 'tmp');
  process.env.TEMP = path.join(dir, 'tmp');
  process.env.TMP = path.join(dir, 'tmp');
  process.env.npm_config_userconfig = path.join(dir, '.npmrc');
  process.env.NPM_CONFIG_USERCONFIG = path.join(dir, '.npmrc');
  delete process.env.HERMES_HOME;
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });
  return {
    restore() {
      if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
      if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
      if (prev.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev.APPDATA;
      if (prev.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prev.LOCALAPPDATA;
      if (prev.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
      if (prev.HERMES_HOME === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = prev.HERMES_HOME;
      if (prev.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev.TMPDIR;
      if (prev.TEMP === undefined) delete process.env.TEMP; else process.env.TEMP = prev.TEMP;
      if (prev.TMP === undefined) delete process.env.TMP; else process.env.TMP = prev.TMP;
      if (prev.npm_config_userconfig === undefined) delete process.env.npm_config_userconfig; else process.env.npm_config_userconfig = prev.npm_config_userconfig;
      if (prev.NPM_CONFIG_USERCONFIG === undefined) delete process.env.NPM_CONFIG_USERCONFIG; else process.env.NPM_CONFIG_USERCONFIG = prev.NPM_CONFIG_USERCONFIG;
    },
  };
}

function assertPathsUnderRoots(paths: string[], roots: string[]): void {
  const normalizedRoots = roots.map((root) => path.resolve(root) + path.sep);
  for (const filePath of paths) {
    const normalizedPath = path.resolve(filePath);
    expect(
      normalizedRoots.some((root) => normalizedPath === root.slice(0, -1) || normalizedPath.startsWith(root)),
      filePath + ' should stay under one of: ' + roots.join(', '),
    ).toBe(true);
  }
}

describe('Installer targets — contract', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  for (const target of ALL_TARGETS) {
    describe(target.id, () => {
      const supportedLocations = (['global', 'local'] as const).filter((l) =>
        target.supportsLocation(l),
      );

      for (const location of supportedLocations) {
        describe(`location=${location}`, () => {
          it('install writes files; detect.alreadyConfigured becomes true', () => {
            expect(target.detect(location).alreadyConfigured).toBe(false);

            const result = target.install(location, { autoAllow: true });
            expect(result.files.length).toBeGreaterThan(0);
            for (const file of result.files) {
              if (file.action !== 'unchanged') {
                expect(fs.existsSync(file.path)).toBe(true);
              }
            }

            expect(target.detect(location).alreadyConfigured).toBe(true);
          });

          it('re-running install is idempotent (no actions other than unchanged)', () => {
            target.install(location, { autoAllow: true });
            const second = target.install(location, { autoAllow: true });
            for (const file of second.files) {
              expect(file.action).toBe('unchanged');
            }
          });

          it('backs up every existing file it mutates and creates no backups on unchanged reruns', () => {
            const originalByPath = new Map<string, string>();
            for (const filePath of target.describePaths(location)) {
              originalByPath.set(filePath, seedExistingTargetFile(target.id, filePath));
              expect(listBackupsFor(filePath)).toEqual([]);
            }

            target.install(location, { autoAllow: true });

            for (const [filePath, original] of originalByPath) {
              const backups = listBackupsFor(filePath);
              expect(backups.length).toBeGreaterThan(0);
              expect(backups.some((backup) => fs.readFileSync(backup, 'utf-8') === original)).toBe(true);
            }

            const backupCounts = new Map(
              [...originalByPath.keys()].map((filePath) => [filePath, listBackupsFor(filePath).length]),
            );
            const second = target.install(location, { autoAllow: true });
            for (const file of second.files) {
              expect(file.action).toBe('unchanged');
            }
            for (const filePath of originalByPath.keys()) {
              expect(listBackupsFor(filePath).length).toBe(backupCounts.get(filePath));
            }
          });

          it('install preserves a pre-existing sibling MCP server (where applicable)', () => {
            // Plant a sibling entry in the same JSON config, install,
            // and verify the sibling survives. Skip for Codex (TOML)
            // and any target with no JSON config — they get covered
            // by their own dedicated tests below.
            const paths = target.describePaths(location);
            // Match .json or .jsonc — opencode prefers .jsonc.
            const jsonPath = paths.find((p) => /\.jsonc?$/.test(p));
            if (!jsonPath) return;

            // Seed pre-existing config.
            fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
            const seed: Record<string, any> = { mcpServers: { other: { command: 'x' } } };
            // opencode uses `mcp` not `mcpServers`. Match its shape too.
            if (target.id === 'opencode') {
              delete seed.mcpServers;
              seed.mcp = { other: { type: 'local', command: ['x'], enabled: true } };
            }
            fs.writeFileSync(jsonPath, JSON.stringify(seed, null, 2) + '\n');

            target.install(location, { autoAllow: true });

            const after = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            if (target.id === 'opencode') {
              expect(after.mcp.other).toBeDefined();
              expect(after.mcp.solidkg).toBeDefined();
            } else {
              expect(after.mcpServers.other).toBeDefined();
              expect(after.mcpServers.solidkg).toBeDefined();
            }
          });

          it('uninstall reverses install (alreadyConfigured returns to false)', () => {
            target.install(location, { autoAllow: true });
            expect(target.detect(location).alreadyConfigured).toBe(true);

            target.uninstall(location);
            expect(target.detect(location).alreadyConfigured).toBe(false);
          });

          it('printConfig returns non-empty output without writing anything', () => {
            const before = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));
            const out = target.printConfig(location);
            expect(out.length).toBeGreaterThan(0);
            const after = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));
            expect(after.sort()).toEqual(before.sort());
          });
        });
      }
    });
  }
});

describe('Installer readiness smoke coverage', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('smoke-home');
    tmpCwd = mkTmpDir('smoke-cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('source checkout smoke runs the built CLI help without publishing or touching config paths', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const cli = path.join(repoRoot, 'dist', 'bin', 'solidkg.js');
    const before = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));

    expect(fs.existsSync(cli), 'run pnpm run build before source checkout smoke tests').toBe(true);
    const output = execFileSync(process.execPath, [cli, '--help'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        APPDATA: path.join(tmpHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(tmpHome, 'AppData', 'Local'),
        XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
        npm_config_userconfig: path.join(tmpHome, '.npmrc'),
        NPM_CONFIG_USERCONFIG: path.join(tmpHome, '.npmrc'),
      },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(output).toContain('solidkg');
    expect(output).toContain('install');
    const after = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));
    expect(after.sort()).toEqual(before.sort());
  });

  it('agent-target install smoke writes and uninstalls opencode only under temp profile paths', () => {
    const opencode = getTarget('opencode')!;
    const before = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));

    const install = opencode.install('global', { autoAllow: true });
    expect(install.files.map((file) => file.action)).toEqual(['created', 'created']);
    assertPathsUnderRoots(install.files.map((file) => file.path), [tmpHome]);
    expect(fs.existsSync(path.join(tmpHome, '.config', 'opencode', 'opencode.jsonc'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.config', 'opencode', 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, 'AppData', 'Roaming', 'opencode'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, 'AppData', 'Local', 'opencode'))).toBe(false);

    const second = opencode.install('global', { autoAllow: true });
    expect(second.files.every((file) => file.action === 'unchanged')).toBe(true);

    const printedBefore = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));
    expect(opencode.printConfig('global')).toContain(path.join(tmpHome, '.config', 'opencode', 'opencode.jsonc'));
    expect(listAllFiles(tmpHome).concat(listAllFiles(tmpCwd)).sort()).toEqual(printedBefore.sort());

    const uninstall = opencode.uninstall('global');
    assertPathsUnderRoots(uninstall.files.map((file) => file.path), [tmpHome]);
    expect(opencode.detect('global').alreadyConfigured).toBe(false);
    expect(listAllFiles(tmpCwd)).toEqual([]);
    expect(before).toEqual([]);
  });
});

describe('Installer instructions template', () => {
  it('documents the compact explore default and explicit advanced profile across public guidance', () => {
    const guidanceSurfaces = {
      serverInstructions: fs.readFileSync(path.join(process.cwd(), 'src', 'mcp', 'server-instructions.ts'), 'utf-8'),
      installerTemplate: fs.readFileSync(path.join(process.cwd(), 'src', 'installer', 'instructions-template.ts'), 'utf-8'),
      cursorRule: fs.readFileSync(path.join(process.cwd(), '.cursor', 'rules', 'solidkg.mdc'), 'utf-8'),
      agents: fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf-8'),
      readme: fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf-8'),
      siteMcpDocs: fs.readFileSync(path.join(process.cwd(), 'site', 'src', 'content', 'docs', 'reference', 'mcp-server.md'), 'utf-8'),
    };

    for (const [surface, content] of Object.entries(guidanceSurfaces)) {
      expect.soft(content, `${surface} should document the compact answer surface`).toMatch(/(?:default|compact) MCP profile[\s\S]{0,180}(?:only|one)[\s\S]{0,100}solidkg_explore/i);
      expect.soft(content, `${surface} should document advanced-tool opt in`).toContain('SOLIDKG_MCP_TOOLS=all');
    }

    expect(guidanceSurfaces.installerTemplate).toContain('ONE call usually answers a structural question.');
    expect(guidanceSurfaces.cursorRule).toContain('ONE call usually answers a structural question.');
  });

  it('keeps package metadata focused on the shipped product rather than unpublished benchmark claims', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')) as {
      description?: string;
    };

    expect(pkg.description).toContain('code intelligence');
    expect(pkg.description).toContain('MCP server');
    expect(pkg.description).not.toMatch(/benchmark|\b35%\b|\b71%\b|\b100%\b/i);
  });

  it('keeps @types/node out of runtime dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf-8')) as {
      packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
    };

    expect(pkg.dependencies).not.toHaveProperty('@types/node');
    expect(pkg.devDependencies).toHaveProperty('@types/node');
    expect(lock.packages[''].dependencies).not.toHaveProperty('@types/node');
    expect(lock.packages[''].devDependencies).toHaveProperty('@types/node');
  });

  it('keeps installer human UI behind the terminal presenter boundary', () => {
    const installerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'installer', 'index.ts'), 'utf-8');

    expect(installerSource).toContain('createTerminalPresenter');
    expect(installerSource).not.toContain('@clack/prompts');
    expect(installerSource).not.toContain('createShimmerProgress');
    expect(installerSource).not.toMatch(/from ['"]ink['"]/);
    expect(installerSource).not.toMatch(/from ['"]react['"]/);
  });

  it('guidance parity: trace instructions are self-sufficient across agent-facing surfaces', () => {
    const guidanceSurfaces = {
      'src/mcp/server-instructions.ts': fs.readFileSync(path.join(process.cwd(), 'src', 'mcp', 'server-instructions.ts'), 'utf-8'),
      'src/installer/instructions-template.ts': fs.readFileSync(path.join(process.cwd(), 'src', 'installer', 'instructions-template.ts'), 'utf-8'),
      'AGENTS.md': fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf-8'),
    };

    const traceInlinesHopBodies = /solidkg_trace[\s\S]{0,240}(?:inlines?|includes?)[\s\S]{0,120}(?:each\s+)?hop['`’s\s-]*bod(?:y|ies)|solidkg_trace[\s\S]{0,240}hop['`’s\s-]*bod(?:y|ies)[\s\S]{0,120}(?:inlined?|included?)/i;
    const staleTraceExploreBodyFetch = /solidkg_trace[\s\S]{0,420}solidkg_explore[\s\S]{0,120}(?:hop\s+)?bod(?:y|ies)|Then\s+(?:use\s+)?ONE\s+`?solidkg_explore`?[\s\S]{0,120}(?:hop\s+)?bod(?:y|ies)/i;

    for (const [surface, content] of Object.entries(guidanceSurfaces)) {
      expect.soft(content, `${surface} should say solidkg_trace inlines hop bodies`).toMatch(traceInlinesHopBodies);
      expect.soft(content, `${surface} should not tell trace users to call solidkg_explore just to fetch hop bodies`).not.toMatch(staleTraceExploreBodyFetch);
    }
  });

  it('documents source-completeness wording consistently on public guidance surfaces', () => {
    const guidanceSurfaces = {
      serverInstructions: fs.readFileSync(path.join(process.cwd(), 'src', 'mcp', 'server-instructions.ts'), 'utf-8'),
      installerTemplate: fs.readFileSync(path.join(process.cwd(), 'src', 'installer', 'instructions-template.ts'), 'utf-8'),
      agents: fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf-8'),
    };
    for (const [surface, content] of Object.entries(guidanceSurfaces)) {
      expect.soft(content, `${surface} should not make absolute trust claims`).not.toContain('Trust solidkg results.');
      expect.soft(content, `${surface} should not prohibit targeted re-checks`).not.toContain('Do NOT re-verify them with grep.');
      expect.soft(content, `${surface} should define source completeness as coverage metadata`).toMatch(/source-completeness fields (?:describe|are) returned-source coverage only/i);
      expect.soft(content, `${surface} should not force continuation for bounded peripheral coverage`).toMatch(/(?:do not|must not) (?:follow up|request another graph call) solely because (?:peripheral )?candidate coverage is partial[\s\S]{0,40}omitted[\s\S]{0,40}truncated/i);
      expect.soft(content, `${surface} should prefer graph-first lookup without overclaiming`).toContain('Prefer SolidKG over broad grep/read loops.');
      expect.soft(content, `${surface} should tie Read fallback to required evidence`).toMatch(/Fall back to targeted Read\s+only when the answer packet is insufficient because required source is stale[\s\S]{0,40}unreadable[\s\S]{0,40}(?:absent|missing)/i);
    }
    expect(guidanceSurfaces.installerTemplate).not.toContain('Claude Code');
  });

  it('documents sufficient answer packets and node-loop avoidance consistently', () => {
    const guidanceSurfaces = {
      serverInstructions: fs.readFileSync(path.join(process.cwd(), 'src', 'mcp', 'server-instructions.ts'), 'utf-8'),
      installerTemplate: fs.readFileSync(path.join(process.cwd(), 'src', 'installer', 'instructions-template.ts'), 'utf-8'),
      agents: fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf-8'),
      siteMcpDocs: fs.readFileSync(path.join(process.cwd(), 'site', 'src', 'content', 'docs', 'reference', 'mcp-server.md'), 'utf-8'),
    };

    for (const [surface, content] of Object.entries(guidanceSurfaces)) {
      expect.soft(content, `${surface} should tell agents to answer from sufficient returned context`).toContain('When an answer packet says the returned context is sufficient, answer from that context instead of drilling further.');
      expect.soft(content, `${surface} should reserve node for one missing hop`).toMatch(/(?:Use )?`?solidkg_node`? (?:is )?for one specific missing symbol or hop, not (?:as )?a loop over many symbols/i);
    }
  });

  it('documents source chunk ranking evidence and disabled hybrid defaults consistently', () => {
    const guidanceSurfaces = {
      serverInstructions: fs.readFileSync(path.join(process.cwd(), 'src', 'mcp', 'server-instructions.ts'), 'utf-8'),
      installerTemplate: fs.readFileSync(path.join(process.cwd(), 'src', 'installer', 'instructions-template.ts'), 'utf-8'),
      agents: fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf-8'),
      cursorRules: fs.readFileSync(path.join(process.cwd(), '.cursor', 'rules', 'solidkg.mdc'), 'utf-8'),
      readme: fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf-8'),
      siteMcpDocs: fs.readFileSync(path.join(process.cwd(), 'site', 'src', 'content', 'docs', 'reference', 'mcp-server.md'), 'utf-8'),
    };

    for (const [surface, content] of Object.entries(guidanceSurfaces)) {
      expect.soft(content, `${surface} should document source_body_chunk evidence`).toContain('source_body_chunk');
      expect.soft(content, `${surface} should describe local source-body chunk retrieval`).toMatch(/source-body\/code-token chunks?/i);
      expect.soft(content, `${surface} should not imply external retrieval is default`).toContain('not enabled by default');
      expect.soft(content, `${surface} should mention disabled hybrid retrieval seams`).toMatch(/hybrid retrieval (?:providers are not enabled by default|seams remain disabled)/i);
      expect.soft(content, `${surface} should not claim LanceDB is enabled`).not.toMatch(/LanceDB\s+(?:is|are)\s+(?:enabled|active|required|default)/i);
    }
  });

  it('documents exclusion constraints and missing query concepts consistently', () => {
    const guidanceSurfaces = {
      serverInstructions: fs.readFileSync(path.join(process.cwd(), 'src', 'mcp', 'server-instructions.ts'), 'utf-8'),
      installerTemplate: fs.readFileSync(path.join(process.cwd(), 'src', 'installer', 'instructions-template.ts'), 'utf-8'),
      agents: fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf-8'),
      cursorRules: fs.readFileSync(path.join(process.cwd(), '.cursor', 'rules', 'solidkg.mdc'), 'utf-8'),
      readme: fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf-8'),
      siteMcpDocs: fs.readFileSync(path.join(process.cwd(), 'site', 'src', 'content', 'docs', 'reference', 'mcp-server.md'), 'utf-8'),
    };

    for (const [surface, content] of Object.entries(guidanceSurfaces)) {
      expect.soft(content, `${surface} should treat exclusions as constraints`).toMatch(/exclusions?[\s\S]{0,120}(?:retrieval )?constraints/i);
      expect.soft(content, `${surface} should define missing-query calibration`).toContain('missing_query_concept');
    }
  });

  it('documents overview guidance consistently on public guidance surfaces', () => {
    const guidanceSurfaces = {
      serverInstructions: fs.readFileSync(path.join(process.cwd(), 'src', 'mcp', 'server-instructions.ts'), 'utf-8'),
      installerTemplate: fs.readFileSync(path.join(process.cwd(), 'src', 'installer', 'instructions-template.ts'), 'utf-8'),
      agents: fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf-8'),
      cursorRules: fs.readFileSync(path.join(process.cwd(), '.cursor', 'rules', 'solidkg.mdc'), 'utf-8'),
      siteMcpDocs: fs.readFileSync(path.join(process.cwd(), 'site', 'src', 'content', 'docs', 'reference', 'mcp-server.md'), 'utf-8'),
    };
    const overviewFormat = /format(?:[:=])\s*(?:["']overview["']|overview)/;
    const overviewProvenance = /derived from (?:the current |the )?(?:`?\.solidkg\/?`? )?index|derived from indexed facts/i;

    for (const [surface, content] of Object.entries(guidanceSurfaces)) {
      expect.soft(content, `${surface} should document overview format`).toMatch(overviewFormat);
      expect.soft(content, `${surface} should describe indexed overview provenance`).toMatch(overviewProvenance);
    }
  });

  it('documents SCIP generation status in installed agent guidance', () => {
    expect(INSTRUCTIONS_TEMPLATE).toContain('SCIP');
    expect(INSTRUCTIONS_TEMPLATE).toContain('generation state');
    expect(INSTRUCTIONS_TEMPLATE).toContain('solidkg_precise_refs');
  });

  it('documents provider-neutral natural-language and precise explore input', () => {
    expect(INSTRUCTIONS_TEMPLATE).toContain('natural-language structural question');
    expect(INSTRUCTIONS_TEMPLATE).toContain('precise symbol/file/code terms');
    expect(INSTRUCTIONS_TEMPLATE).not.toContain('run solidkg_search first');
    expect(INSTRUCTIONS_TEMPLATE).not.toContain('Claude Code');
  });

  it('documents raw tool names without encouraging double prefixes', () => {
    expect(INSTRUCTIONS_TEMPLATE).toContain('raw MCP server tool names');
    expect(INSTRUCTIONS_TEMPLATE).toContain('solidkg_*');
    expect(INSTRUCTIONS_TEMPLATE).toContain('host-specific server prefix');
    expect(INSTRUCTIONS_TEMPLATE).toContain('do not add another');
    expect(INSTRUCTIONS_TEMPLATE).not.toContain('solidkg_solidkg_context');
  });

  it('tells agents not to re-read explore source', () => {
    expect(INSTRUCTIONS_TEMPLATE).toContain('Treat returned source as already Read');
  });
});

describe('Installer target permissions', () => {
  it('allows the generic SCIP precise refs MCP tool', () => {
    expect(getSolidKGPermissions()).toContain('mcp__solidkg__solidkg_precise_refs');
  });
});

describe('Installer setup health check', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('install --check style report is read-only on a clean slate', () => {
    const before = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));

    const report = buildInstallCheckReport({ target: 'all', location: 'local' });
    const output = formatInstallCheckReport(report);

    expect(output).toContain('SolidKG install setup check');
    expect(output).toContain('No files were modified.');
    expect(output).toContain('solidkg init');
    expect(report.projectInitialized).toBe(false);
    expect(report.rows.length).toBe(ALL_TARGETS.length);
    expect(report.rows.some((row) => row.mcp === 'missing')).toBe(true);
    const after = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));
    expect(after.sort()).toEqual(before.sort());
  });

  it('reports configured MCP, present guidance, and initialized project without writing', () => {
    const mcpJson = path.join(tmpCwd, '.mcp.json');
    const claudeMd = path.join(tmpCwd, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
    fs.mkdirSync(path.join(tmpCwd, '.solidkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpCwd, '.solidkg', 'solidkg.db'), '');
    fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: { solidkg: { command: 'solidkg' } } }, null, 2));
    fs.writeFileSync(claudeMd, INSTRUCTIONS_TEMPLATE + '\n');
    const beforeMcp = fs.readFileSync(mcpJson, 'utf-8');
    const beforeGuidance = fs.readFileSync(claudeMd, 'utf-8');

    const report = buildInstallCheckReport({ target: 'claude', location: 'local' });
    const output = formatInstallCheckReport(report);

    expect(report.projectInitialized).toBe(true);
    expect(output).toContain('[ok] Project initialized: yes');
    expect(output).toContain('[ok] Claude Code: MCP configured; guidance present');
    expect(output).toContain('No action needed.');
    expect(fs.readFileSync(mcpJson, 'utf-8')).toBe(beforeMcp);
    expect(fs.readFileSync(claudeMd, 'utf-8')).toBe(beforeGuidance);
  });

  it('warns on corrupted JSON config without creating backups or rewriting', () => {
    const mcpJson = path.join(tmpCwd, '.mcp.json');
    fs.writeFileSync(mcpJson, '{ this is not valid json !!!');

    const report = buildInstallCheckReport({ target: 'claude', location: 'local' });
    const output = formatInstallCheckReport(report);

    expect(output).toContain('[warn] Claude Code: MCP warning');
    expect(output).toContain('Fix manually; check mode did not rewrite or back it up.');
    expect(fs.readFileSync(mcpJson, 'utf-8')).toBe('{ this is not valid json !!!');
    expect(listBackupsFor(mcpJson)).toEqual([]);
    expect(listAllFiles(tmpCwd).filter((file) => file.includes('.tmp.'))).toEqual([]);
  });
});

describe('Installer targets — partial-state idempotency', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('codex: install after only config.toml exists — second pass is fully unchanged', () => {
    const codex = getTarget('codex')!;
    // First install creates both files.
    codex.install('global', { autoAllow: false });
    // Delete the AGENTS.md to simulate partial state (user wiped one file).
    const agentsMd = path.join(tmpHome, '.codex', 'AGENTS.md');
    expect(fs.existsSync(agentsMd)).toBe(true);
    fs.unlinkSync(agentsMd);
    // Reinstall — TOML stays unchanged, AGENTS.md is recreated.
    const second = codex.install('global', { autoAllow: false });
    const tomlEntry = second.files.find((f) => f.path.endsWith('config.toml'))!;
    const mdEntry = second.files.find((f) => f.path.endsWith('AGENTS.md'))!;
    expect(tomlEntry.action).toBe('unchanged');
    expect(mdEntry.action).toBe('created');
    // Third install — both unchanged (full idempotency restored).
    const third = codex.install('global', { autoAllow: false });
    for (const f of third.files) expect(f.action).toBe('unchanged');
  });

  it('codex: install writes bounded MCP startup and tool timeouts', () => {
    const codex = getTarget('codex')!;
    codex.install('global', { autoAllow: false });
    const body = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(body).toContain('[mcp_servers.solidkg]');
    expect(body).toContain('startup_timeout_sec = 10');
    expect(body).toContain('tool_timeout_sec = 35');
  });

  it('codex: install removes legacy codegraph server tables', () => {
    const codex = getTarget('codex')!;
    const dir = path.join(tmpHome, '.codex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.toml'), [
      '[profile]',
      'model = "gpt-5.5"',
      '',
      '[mcp_servers.codegraph]',
      'command = "codegraph"',
      'args = ["serve", "--mcp"]',
      '',
      '[mcp_servers.codegraph.tools.codegraph_status]',
      'approval_mode = "approve"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
    ].join('\n'));

    const result = codex.install('global', { autoAllow: false });
    const configEntry = result.files.find((file) => file.path.endsWith('config.toml'))!;
    expect(configEntry.action).toBe('updated');

    const body = fs.readFileSync(path.join(dir, 'config.toml'), 'utf-8');
    expect(body).toContain('[mcp_servers.solidkg]');
    expect(body).toContain('command = "solidkg"');
    expect(body).toContain('[mcp_servers.other]');
    expect(body).not.toContain('mcp_servers.codegraph');
    expect(body).not.toContain('command = "codegraph"');
  });

  it('opencode: prefers .jsonc when both .json and .jsonc exist', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'opencode.json'), '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');
    fs.writeFileSync(path.join(dir, 'opencode.jsonc'), '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');

    const result = opencode.install('global', { autoAllow: true });
    const written = result.files.find((f) => /\.jsonc$/.test(f.path))!;
    expect(written).toBeDefined();
    expect(written.action).not.toBe('not-found');
    // The .json file is left alone.
    const jsonText = fs.readFileSync(path.join(dir, 'opencode.json'), 'utf-8');
    expect(jsonText).not.toContain('solidkg');
  });

  it('opencode: uses .json when only .json exists (no .jsonc)', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'opencode.json'), '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');

    const result = opencode.install('global', { autoAllow: true });
    expect(result.files[0].path).toMatch(/opencode\.json$/);
    expect(fs.existsSync(path.join(dir, 'opencode.jsonc'))).toBe(false);
  });

  it('opencode: defaults to .jsonc for fresh installs (no existing file)', () => {
    const opencode = getTarget('opencode')!;
    const result = opencode.install('global', { autoAllow: true });
    expect(result.files[0].path).toMatch(/opencode\.jsonc$/);
    expect(result.files[0].action).toBe('created');
  });

  it('opencode: global install uses home .config instead of APPDATA on Windows-style environments', () => {
    const opencode = getTarget('opencode')!;
    process.env.APPDATA = path.join(tmpHome, 'AppData', 'Roaming');
    delete process.env.XDG_CONFIG_HOME;

    const result = opencode.install('global', { autoAllow: true });
    const configEntry = result.files.find((file) => file.path.endsWith('opencode.jsonc'))!;
    const agentsEntry = result.files.find((file) => file.path.endsWith('AGENTS.md'))!;
    const expectedDir = path.join(tmpHome, '.config', 'opencode');
    const appDataDir = path.join(tmpHome, 'AppData', 'Roaming', 'opencode');

    expect(configEntry.path).toBe(path.join(expectedDir, 'opencode.jsonc'));
    expect(agentsEntry.path).toBe(path.join(expectedDir, 'AGENTS.md'));
    expect(fs.existsSync(path.join(expectedDir, 'opencode.jsonc'))).toBe(true);
    expect(fs.existsSync(appDataDir)).toBe(false);
  });

  it('opencode: preserves line and block comments through install + idempotent re-run', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'opencode.jsonc');
    const original = [
      '{',
      '  // top-level note about my opencode setup',
      '  "$schema": "https://opencode.ai/config.json",',
      '  /* multi-line block comment',
      '     describing the providers section */',
      '  "providers": {',
      '    "anthropic": { "model": "claude-opus-4-7" } // pinned',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(file, original);

    opencode.install('global', { autoAllow: true });
    const afterInstall = fs.readFileSync(file, 'utf-8');
    expect(afterInstall).toContain('// top-level note about my opencode setup');
    expect(afterInstall).toContain('/* multi-line block comment');
    expect(afterInstall).toContain('// pinned');
    expect(afterInstall).toContain('"solidkg"');
    expect(afterInstall).toContain('"providers"');

    // Idempotent re-run reports unchanged, file is byte-identical.
    const second = opencode.install('global', { autoAllow: true });
    expect(second.files[0].action).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf-8')).toBe(afterInstall);
  });

  it('opencode: install removes legacy mcp.codegraph while preserving siblings', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'opencode.jsonc');
    fs.writeFileSync(file, [
      '{',
      '  // keep user comments',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"], "enabled": true },',
      '    "other": { "type": "local", "command": ["x"], "enabled": true }',
      '  }',
      '}',
      '',
    ].join('\n'));

    const result = opencode.install('global', { autoAllow: true });
    expect(result.files[0].action).toBe('updated');

    const after = fs.readFileSync(file, 'utf-8');
    const parsed = parseJsonc(after);
    expect(after).toContain('// keep user comments');
    expect(parsed.mcp.codegraph).toBeUndefined();
    expect(parsed.mcp.other).toBeDefined();
    expect(parsed.mcp.solidkg).toEqual({
      type: 'local',
      command: ['solidkg', 'serve', '--mcp'],
      enabled: true,
    });
  });

  it('opencode: install writes AGENTS.md with the marker-delimited solidkg block', () => {
    const opencode = getTarget('opencode')!;
    opencode.install('global', { autoAllow: true });
    const agentsMd = path.join(tmpHome, '.config', 'opencode', 'AGENTS.md');
    expect(fs.existsSync(agentsMd)).toBe(true);
    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('<!-- SOLIDKG_START -->');
    expect(body).toContain('<!-- SOLIDKG_END -->');
    expect(body).toContain('solidkg_callers');
    expect(body).toMatch(/Source-completeness fields are returned-source coverage only/i);
    expect(body).toContain('Do not follow up solely because candidate coverage is partial, omitted, or truncated.');
  });

  it('opencode: install removes legacy CodeGraph instructions block', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, [
      '# My personal opencode instructions',
      '',
      '<!-- CODEGRAPH_START -->',
      '## CodeGraph',
      '`codegraph_search`',
      '<!-- CODEGRAPH_END -->',
      '',
      'Keep this.',
      '',
    ].join('\n'));

    opencode.install('global', { autoAllow: true });

    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My personal opencode instructions');
    expect(body).toContain('Keep this.');
    expect(body).toContain('<!-- SOLIDKG_START -->');
    expect(body).toContain('solidkg_search');
    expect(body).not.toContain('CODEGRAPH_START');
    expect(body).not.toContain('codegraph_search');
  });

  it('opencode: AGENTS.md install preserves pre-existing user content outside markers', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, '# My personal opencode instructions\n\nAlways respond in pirate.\n');

    opencode.install('global', { autoAllow: true });
    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My personal opencode instructions');
    expect(body).toContain('Always respond in pirate.');
    expect(body).toContain('<!-- SOLIDKG_START -->');
  });

  it('opencode: uninstall strips only the solidkg block from AGENTS.md', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, '# My personal opencode instructions\n\nAlways respond in pirate.\n');

    opencode.install('global', { autoAllow: true });
    opencode.uninstall('global');

    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My personal opencode instructions');
    expect(body).toContain('Always respond in pirate.');
    expect(body).not.toContain('SOLIDKG_START');
    expect(body).not.toContain('solidkg_callers');
  });

  it('opencode: local install writes ./opencode.jsonc and ./AGENTS.md in cwd', () => {
    const opencode = getTarget('opencode')!;
    const result = opencode.install('local', { autoAllow: true });
    const paths = result.files.map((f) => f.path.replace(/\\/g, '/'));
    // macOS realpath shenanigans (/var vs /private/var) — suffix match.
    expect(paths.some((p) => p.endsWith('/opencode.jsonc'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/AGENTS.md'))).toBe(true);
  });

  it('antigravity: global install writes documented mcp_config.json without a type field', () => {
    const antigravity = getTarget('antigravity')!;
    antigravity.install('global', { autoAllow: true });
    const config = JSON.parse(fs.readFileSync(path.join(tmpHome, '.gemini', 'antigravity', 'mcp_config.json'), 'utf-8'));
    expect(config.mcpServers.solidkg).toEqual({ command: 'solidkg', args: ['serve', '--mcp'] });
  });

  it('omp: local install writes the native schema-tagged .omp/mcp.json', () => {
    const omp = getTarget('omp')!;
    omp.install('local', { autoAllow: true });
    const config = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.omp', 'mcp.json'), 'utf-8'));
    expect(config.$schema).toContain('oh-my-pi');
    expect(config.mcpServers.solidkg).toEqual({ type: 'stdio', command: 'solidkg', args: ['serve', '--mcp'] });
  });

  it('kimi: global install writes the auto-loaded ~/.kimi/mcp.json without a type field', () => {
    const kimi = getTarget('kimi')!;
    kimi.install('global', { autoAllow: true });
    const config = JSON.parse(fs.readFileSync(path.join(tmpHome, '.kimi', 'mcp.json'), 'utf-8'));
    expect(config.mcpServers.solidkg).toEqual({ command: 'solidkg', args: ['serve', '--mcp'] });
  });

  it('hermes: install adds solidkg MCP server and cli toolset, preserving existing yaml', () => {
    const hermes = getTarget('hermes')!;
    const config = path.join(tmpHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, [
      'model:',
      '  default: qwen-3.7',
      'mcp_servers:',
      '  other:',
      '    command: other',
      'platform_toolsets:',
      '  cli:',
      '    - hermes-cli',
      '  discord:',
      '    - hermes-discord',
      '',
    ].join('\n'));

    const result = hermes.install('global', { autoAllow: true });
    expect(result.files[0].action).toBe('updated');
    const body = fs.readFileSync(config, 'utf-8');
    expect(body).toContain('model:\n  default: qwen-3.7');
    expect(body).toContain('mcp_servers:\n  other:\n    command: other');
    expect(body).toContain('  solidkg:\n    command: solidkg');
    expect(body).toContain('    - hermes-cli');
    expect(body).toContain('    - mcp-solidkg');
    expect(body).toContain('  discord:\n    - hermes-discord');

    const second = hermes.install('global', { autoAllow: true });
    expect(second.files[0].action).toBe('unchanged');
  });

  it('hermes: preserves two-space YAML sequence indentation inside platform_toolsets.cli', () => {
    const hermes = getTarget('hermes')!;
    const config = path.join(tmpHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, [
      'model:',
      '  default: qwen-3.7',
      'mcp_servers:',
      '  other:',
      '    command: other',
      '    nested:',
      '      keep: true',
      'platform_toolsets:',
      '  cli:',
      '  - hermes-cli',
      '  - custom-cli',
      '  discord:',
      '  - hermes-discord',
      'other_top:',
      '  keep: yes',
      '',
    ].join('\n'));

    hermes.install('global', { autoAllow: true });
    const body = fs.readFileSync(config, 'utf-8');

    expect(body).toContain('  cli:\n  - hermes-cli\n  - custom-cli\n  - mcp-solidkg\n  discord:');
    expect(body).not.toContain('    - mcp-solidkg');
    expect(body).toContain('  discord:\n  - hermes-discord');
    expect(body).toContain('other_top:\n  keep: yes');
    expect(body).toContain('    nested:\n      keep: true');

    const second = hermes.install('global', { autoAllow: true });
    expect(second.files[0].action).toBe('unchanged');
  });

  it('hermes: uninstall removes only solidkg MCP server and toolset entry', () => {
    const hermes = getTarget('hermes')!;
    const config = path.join(tmpHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(config), { recursive: true });

    hermes.install('global', { autoAllow: true });
    fs.appendFileSync(config, 'custom:\n  keep: true\n');

    hermes.uninstall('global');
    const body = fs.readFileSync(config, 'utf-8');
    expect(body).not.toContain('solidkg:');
    expect(body).not.toContain('mcp-solidkg');
    expect(body).toContain('custom:\n  keep: true');
  });

  it('opencode: uninstall removes only mcp.solidkg, preserves comments and siblings', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'opencode.jsonc');
    fs.writeFileSync(file, [
      '{',
      '  // important comment',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "other": { "type": "local", "command": ["x"], "enabled": true }',
      '  }',
      '}',
      '',
    ].join('\n'));

    opencode.install('global', { autoAllow: true });
    const afterInstall = fs.readFileSync(file, 'utf-8');
    expect(afterInstall).toContain('"solidkg"');
    expect(afterInstall).toContain('"other"');

    opencode.uninstall('global');
    const afterUninstall = fs.readFileSync(file, 'utf-8');
    expect(afterUninstall).not.toContain('solidkg');
    expect(afterUninstall).toContain('// important comment');
    expect(afterUninstall).toContain('"other"');
  });

  it('codex: user-added key inside [mcp_servers.solidkg] survives idempotent re-install', () => {
    const codex = getTarget('codex')!;
    codex.install('global', { autoAllow: false });
    const tomlPath = path.join(tmpHome, '.codex', 'config.toml');
    const original = fs.readFileSync(tomlPath, 'utf-8');
    // User edits the block to add a custom key.
    const edited = original.replace(
      'args = ["serve", "--mcp"]',
      'args = ["serve", "--mcp"]\nenabled = true',
    );
    fs.writeFileSync(tomlPath, edited);
    // Re-install: our serializer doesn't know `enabled = true`, so
    // the block no longer matches the canonical form — we'll
    // overwrite it. This is the documented contract: we own the
    // solidkg block exclusively.
    const second = codex.install('global', { autoAllow: false });
    const tomlEntry = second.files.find((f) => f.path.endsWith('config.toml'))!;
    expect(tomlEntry.action).toBe('updated');
    const after = fs.readFileSync(tomlPath, 'utf-8');
    expect(after).not.toContain('enabled = true');
  });

  it('codex: install removes legacy CodeGraph instructions block', () => {
    const codex = getTarget('codex')!;
    const dir = path.join(tmpHome, '.codex');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, [
      '# My personal Codex instructions',
      '',
      '<!-- CODEGRAPH_START -->',
      '## CodeGraph',
      '`codegraph_search`',
      '<!-- CODEGRAPH_END -->',
      '',
    ].join('\n'));

    codex.install('global', { autoAllow: false });

    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My personal Codex instructions');
    expect(body).toContain('<!-- SOLIDKG_START -->');
    expect(body).toContain('solidkg_search');
    expect(body).not.toContain('CODEGRAPH_START');
    expect(body).not.toContain('codegraph_search');
  });

  it('claude: local install writes ./.mcp.json (project scope), not ./.claude.json', () => {
    const claude = getTarget('claude')!;
    const result = claude.install('local', { autoAllow: false });
    // The MCP entry lands in ./.mcp.json — the file Claude Code reads.
    expect(result.files.some((f) => f.path.replace(/\\/g, '/').endsWith('/.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpCwd, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpCwd, '.claude.json'))).toBe(false);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
    expect(cfg.mcpServers.solidkg).toBeDefined();
  });

  it('claude: global install targets ~/.claude.json (user scope)', () => {
    const claude = getTarget('claude')!;
    claude.install('global', { autoAllow: false });
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf-8'));
    expect(cfg.mcpServers.solidkg).toBeDefined();
  });

  it('claude: local install migrates a legacy ./.claude.json solidkg entry into ./.mcp.json', () => {
    const claude = getTarget('claude')!;
    const legacy = path.join(tmpCwd, '.claude.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify({ mcpServers: { solidkg: { type: 'stdio', command: 'solidkg', args: ['serve', '--mcp'] } } }, null, 2),
    );

    claude.install('local', { autoAllow: false });

    // solidkg now lives in .mcp.json; the legacy file (which held only
    // solidkg) is gone.
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.solidkg).toBeDefined();
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('claude: legacy ./.claude.json migration preserves sibling servers and unrelated keys', () => {
    const claude = getTarget('claude')!;
    const legacy = path.join(tmpCwd, '.claude.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        mcpServers: {
          solidkg: { type: 'stdio', command: 'solidkg', args: ['serve', '--mcp'] },
          other: { command: 'x' },
        },
        somethingElse: true,
      }, null, 2),
    );

    claude.install('local', { autoAllow: false });

    // Only solidkg is stripped from the legacy file; siblings survive.
    const after = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
    expect(after.mcpServers.solidkg).toBeUndefined();
    expect(after.mcpServers.other).toBeDefined();
    expect(after.somethingElse).toBe(true);
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.solidkg).toBeDefined();
  });

  it('claude: uninstall strips solidkg from ./.mcp.json and a legacy ./.claude.json', () => {
    const claude = getTarget('claude')!;
    // A user left with both the working .mcp.json and a stale .claude.json.
    fs.writeFileSync(
      path.join(tmpCwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { solidkg: { command: 'solidkg' } } }, null, 2),
    );
    fs.writeFileSync(
      path.join(tmpCwd, '.claude.json'),
      JSON.stringify({ mcpServers: { solidkg: { command: 'solidkg' }, other: { command: 'x' } } }, null, 2),
    );

    claude.uninstall('local');

    const mcp = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers).toBeUndefined();
    const legacy = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.claude.json'), 'utf-8'));
    expect(legacy.mcpServers.solidkg).toBeUndefined();
    expect(legacy.mcpServers.other).toBeDefined();
  });

  // ---- Legacy auto-sync hook cleanup ----
  // Pre-0.8 installs wrote `solidkg mark-dirty` / `sync-if-dirty`
  // hooks to settings.json. Both subcommands were removed from the CLI,
  // so the Stop hook fails every turn ("unknown command
  // 'sync-if-dirty'"). The installer must strip them on upgrade and
  // uninstall — without touching the user's unrelated hooks.

  function seedSettings(loc: 'global' | 'local', settings: Record<string, any>): string {
    const dir = path.join(loc === 'global' ? tmpHome : tmpCwd, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    return file;
  }

  // Realistic pre-0.8 settings.json: our two auto-sync hooks plus an
  // unrelated GitKraken Stop hook the user added (matches the report).
  function legacyHookSettings(): Record<string, any> {
    return {
      hooks: {
        PostToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'solidkg mark-dirty', async: true }] },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: 'solidkg sync-if-dirty' }] },
          { hooks: [{ type: 'command', command: '"/Users/me/gk" ai hook run --host claude-code' }] },
        ],
      },
    };
  }

  it('claude: install strips stale solidkg auto-sync hooks but keeps the user\'s GitKraken hook', () => {
    const claude = getTarget('claude')!;
    const file = seedSettings('global', legacyHookSettings());

    claude.install('global', { autoAllow: true });

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // The only PostToolUse group held mark-dirty → the event is gone.
    expect(after.hooks?.PostToolUse).toBeUndefined();
    const stopCommands = (after.hooks?.Stop ?? []).flatMap((g: any) =>
      (g.hooks ?? []).map((h: any) => h.command),
    );
    expect(stopCommands).not.toContain('solidkg sync-if-dirty');
    // The unrelated GitKraken hook survives untouched.
    expect(stopCommands.some((c: string) => c.includes('gk') && c.includes('ai hook run'))).toBe(true);
    // Permissions still written as normal alongside the cleanup.
    expect(after.permissions?.allow).toContain('mcp__solidkg__solidkg_search');
  });

  it('claude: cleanupLegacyHooks preserves a sibling hook sharing our matcher group', () => {
    const file = seedSettings('global', {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'solidkg sync-if-dirty' },
              { type: 'command', command: 'gk ai hook run --host claude-code' },
            ],
          },
        ],
      },
    });

    expect(cleanupLegacyHooks('global').action).toBe('removed');

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after.hooks.Stop[0].hooks.map((h: any) => h.command)).toEqual([
      'gk ai hook run --host claude-code',
    ]);
  });

  it('claude: cleanupLegacyHooks is a byte-for-byte no-op without solidkg hooks', () => {
    const original =
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'gk ai hook run' }] }] } }, null, 2) + '\n';
    const file = seedSettings('global', JSON.parse(original));

    expect(cleanupLegacyHooks('global').action).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
  });

  it('claude: cleanupLegacyHooks reports not-found when settings.json is absent', () => {
    expect(cleanupLegacyHooks('global').action).toBe('not-found');
  });

  it('claude: re-running install after a legacy cleanup leaves settings.json unchanged', () => {
    const claude = getTarget('claude')!;
    const file = seedSettings('global', legacyHookSettings());
    claude.install('global', { autoAllow: true });
    const firstPass = fs.readFileSync(file, 'utf-8');
    claude.install('global', { autoAllow: true });
    expect(fs.readFileSync(file, 'utf-8')).toBe(firstPass);
  });

  it('claude: uninstall strips stale hooks written in the npx form (local)', () => {
    const claude = getTarget('claude')!;
    const file = seedSettings('local', {
      hooks: {
        PostToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx solidkg mark-dirty', async: true }] },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: 'npx solidkg sync-if-dirty' }] },
        ],
      },
    });

    claude.uninstall('local');

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // Both events emptied → the whole `hooks` object is removed.
    expect(after.hooks).toBeUndefined();
  });
});

describe('Installer targets — registry', () => {
  it('getTarget returns the right target for each id', () => {
    expect(getTarget('claude')?.id).toBe('claude');
    expect(getTarget('cursor')?.id).toBe('cursor');
    expect(getTarget('codex')?.id).toBe('codex');
    expect(getTarget('opencode')?.id).toBe('opencode');
    expect(getTarget('hermes')?.id).toBe('hermes');
    expect(getTarget('antigravity')?.id).toBe('antigravity');
    expect(getTarget('omp')?.id).toBe('omp');
    expect(getTarget('kimi')?.id).toBe('kimi');
    expect(getTarget('not-a-real-target')).toBeUndefined();
  });

  it('resolveTargetFlag handles auto/all/none/csv', () => {
    expect(resolveTargetFlag('none', 'global')).toEqual([]);
    expect(resolveTargetFlag('all', 'global').length).toBe(ALL_TARGETS.length);
    const csv = resolveTargetFlag('claude,cursor', 'global');
    expect(csv.map((t) => t.id)).toEqual(['claude', 'cursor']);
  });

  it('resolveTargetFlag throws on unknown id', () => {
    expect(() => resolveTargetFlag('claude,bogus', 'global')).toThrow(/Unknown --target/);
  });
});

describe('Installer targets — TOML serializer (Codex backbone)', () => {
  it('builds a [mcp_servers.solidkg] block with command + args', () => {
    const block = buildTomlTable('mcp_servers.solidkg', {
      command: 'solidkg',
      args: ['serve', '--mcp'],
      startup_timeout_sec: 10,
      tool_timeout_sec: 35,
    });
    expect(block).toContain('[mcp_servers.solidkg]');
    expect(block).toContain('command = "solidkg"');
    expect(block).toContain('args = ["serve", "--mcp"]');
    expect(block).toContain('startup_timeout_sec = 10');
    expect(block).toContain('tool_timeout_sec = 35');
  });

  it('upsert inserts into empty content', () => {
    const block = buildTomlTable('mcp_servers.solidkg', { command: 'solidkg', args: ['serve'] });
    const { content, action } = upsertTomlTable('', 'mcp_servers.solidkg', block);
    expect(action).toBe('inserted');
    expect(content.startsWith('[mcp_servers.solidkg]')).toBe(true);
  });

  it('upsert is idempotent — second call returns unchanged', () => {
    const block = buildTomlTable('mcp_servers.solidkg', { command: 'solidkg', args: ['serve'] });
    const first = upsertTomlTable('', 'mcp_servers.solidkg', block);
    const second = upsertTomlTable(first.content, 'mcp_servers.solidkg', block);
    expect(second.action).toBe('unchanged');
    expect(second.content).toBe(first.content);
  });

  it('upsert replaces an existing block in place, preserving sibling tables', () => {
    const existing = [
      '[other_table]',
      'foo = "bar"',
      '',
      '[mcp_servers.solidkg]',
      'command = "old-solidkg"',
      'args = ["old"]',
      '',
      '[zzz]',
      'baz = "qux"',
      '',
    ].join('\n');
    const newBlock = buildTomlTable('mcp_servers.solidkg', {
      command: 'solidkg',
      args: ['serve', '--mcp'],
    });
    const { content, action } = upsertTomlTable(existing, 'mcp_servers.solidkg', newBlock);
    expect(action).toBe('replaced');
    expect(content).toContain('[other_table]');
    expect(content).toContain('foo = "bar"');
    expect(content).toContain('[zzz]');
    expect(content).toContain('baz = "qux"');
    expect(content).toContain('command = "solidkg"');
    expect(content).not.toContain('old-solidkg');
  });

  it('removeTomlTable strips the block and preserves siblings', () => {
    const existing = [
      '[other_table]',
      'foo = "bar"',
      '',
      '[mcp_servers.solidkg]',
      'command = "solidkg"',
      'args = ["serve"]',
    ].join('\n');
    const { content, action } = removeTomlTable(existing, 'mcp_servers.solidkg');
    expect(action).toBe('removed');
    expect(content).toContain('[other_table]');
    expect(content).toContain('foo = "bar"');
    expect(content).not.toContain('mcp_servers.solidkg');
  });

  it('removeTomlTable on missing table returns not-found, no content change', () => {
    const existing = '[other]\nfoo = "bar"\n';
    const { content, action } = removeTomlTable(existing, 'mcp_servers.solidkg');
    expect(action).toBe('not-found');
    expect(content).toBe(existing);
  });

  it('removeTomlTablesByPrefix strips a server table and nested tool tables only', () => {
    const existing = [
      '[mcp_servers.codegraph]',
      'command = "codegraph"',
      '',
      '[mcp_servers.codegraph.tools.codegraph_status]',
      'approval_mode = "approve"',
      '',
      '[mcp_servers.codegraph_extra]',
      'command = "keep"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
    ].join('\n');
    const { content, action } = removeTomlTablesByPrefix(existing, 'mcp_servers.codegraph');
    expect(action).toBe('removed');
    expect(content).not.toContain('[mcp_servers.codegraph]');
    expect(content).not.toContain('[mcp_servers.codegraph.tools.codegraph_status]');
    expect(content).toContain('[mcp_servers.codegraph_extra]');
    expect(content).toContain('[mcp_servers.other]');
  });

  it('upsert preserves an array-of-tables sibling [[foo]]', () => {
    const existing = [
      '[[foo]]',
      'name = "a"',
      '',
      '[[foo]]',
      'name = "b"',
      '',
    ].join('\n');
    const block = buildTomlTable('mcp_servers.solidkg', { command: 'solidkg', args: ['serve'] });
    const { content } = upsertTomlTable(existing, 'mcp_servers.solidkg', block);
    expect(content.match(/\[\[foo\]\]/g)?.length).toBe(2);
    expect(content).toContain('[mcp_servers.solidkg]');
  });
});

describe('Installer — uninstallTargets sweep (solidkg uninstall)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('un-home');
    tmpCwd = mkTmpDir('un-cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('sweeps every agent it was installed on and reports removed for each (global)', () => {
    for (const t of ALL_TARGETS) {
      if (t.supportsLocation('global')) t.install('global', { autoAllow: true });
    }

    const reports = uninstallTargets(ALL_TARGETS, 'global');

    for (const t of ALL_TARGETS) {
      const r = reports.find((x) => x.id === t.id)!;
      expect(r.status).toBe('removed');
      expect(r.removedPaths.length).toBeGreaterThan(0);
      // The actual config is gone afterward.
      expect(t.detect('global').alreadyConfigured).toBe(false);
    }
  });

  it('is safe on a clean slate — every agent reports not-configured, nothing removed', () => {
    const reports = uninstallTargets(ALL_TARGETS, 'global');
    for (const r of reports) {
      expect(r.status).toBe('not-configured');
      expect(r.removedPaths).toEqual([]);
    }
  });

  it('reports removed only for agents that were actually configured', () => {
    // Install on Claude only; the rest stay untouched.
    getTarget('claude')!.install('global', { autoAllow: true });

    const reports = uninstallTargets(ALL_TARGETS, 'global');

    const claude = reports.find((r) => r.id === 'claude')!;
    expect(claude.status).toBe('removed');
    expect(claude.displayName).toBe(getTarget('claude')!.displayName);

    for (const r of reports.filter((x) => x.id !== 'claude')) {
      expect(r.status).toBe('not-configured');
    }
  });

  it('marks global-only agents as unsupported for a local sweep (and never touches them)', () => {
    const reports = uninstallTargets(ALL_TARGETS, 'local');
    for (const t of ALL_TARGETS) {
      const r = reports.find((x) => x.id === t.id)!;
      if (t.supportsLocation('local')) {
        expect(r.status).toBe('not-configured');
      } else {
        expect(r.status).toBe('unsupported');
        expect(r.removedPaths).toEqual([]);
        expect(r.notes[0]).toMatch(/global-only/);
      }
    }
  });

  it('is idempotent — a second sweep finds nothing left to remove', () => {
    for (const t of ALL_TARGETS) {
      if (t.supportsLocation('global')) t.install('global', { autoAllow: true });
    }
    const first = uninstallTargets(ALL_TARGETS, 'global');
    expect(first.some((r) => r.status === 'removed')).toBe(true);

    const second = uninstallTargets(ALL_TARGETS, 'global');
    for (const r of second) {
      expect(r.status).toBe('not-configured');
      expect(r.removedPaths).toEqual([]);
    }
  });

  it('a --target subset removes only the chosen agents, leaving siblings configured', () => {
    getTarget('claude')!.install('global', { autoAllow: true });
    getTarget('cursor')!.install('global', { autoAllow: true });

    const reports = uninstallTargets(resolveTargetFlag('claude', 'global'), 'global');

    expect(reports.map((r) => r.id)).toEqual(['claude']);
    expect(reports[0].status).toBe('removed');
    // Cursor was not in the subset — still configured.
    expect(getTarget('cursor')!.detect('global').alreadyConfigured).toBe(true);
    expect(getTarget('claude')!.detect('global').alreadyConfigured).toBe(false);
  });
});

describe('Installer — Cursor rules file cleanup on uninstall', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };
  const cursor = getTarget('cursor')!;

  beforeEach(() => {
    tmpHome = mkTmpDir('cur-home');
    tmpCwd = mkTmpDir('cur-cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  const rulesFile = () => path.join(process.cwd(), '.cursor', 'rules', 'solidkg.mdc');

  it('deletes the dedicated solidkg.mdc entirely (no orphaned frontmatter left behind)', () => {
    cursor.install('local', { autoAllow: true });
    expect(fs.existsSync(rulesFile())).toBe(true);

    cursor.uninstall('local');

    // The whole file — frontmatter included — is gone, not just the block.
    expect(fs.existsSync(rulesFile())).toBe(false);
    expect(cursor.detect('local').alreadyConfigured).toBe(false);
  });

  it('preserves user content added outside the solidkg markers (strips only our block)', () => {
    cursor.install('local', { autoAllow: true });
    const withUserContent =
      fs.readFileSync(rulesFile(), 'utf-8') + '\n## My own rule\nkeep me\n';
    fs.writeFileSync(rulesFile(), withUserContent);

    cursor.uninstall('local');

    expect(fs.existsSync(rulesFile())).toBe(true);
    const after = fs.readFileSync(rulesFile(), 'utf-8');
    expect(after).toContain('keep me');
    // Our tool-usage block is gone.
    expect(after).not.toContain('solidkg_search');
    expect(after).not.toContain('SOLIDKG_START');
  });
});

function listAllFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listAllFiles(full));
    else out.push(full);
  }
  return out;
}
