#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const readmePath = path.join(repoRoot, 'README.md');
const claimsRegisterPath = path.join(repoRoot, 'docs', 'design', 'claims-register.md');
const evidenceDir = path.join(repoRoot, '.omo', 'evidence');
const claimsEvidencePath = path.join(evidenceDir, 'task-11-readme-claims-audit.txt');
const toneEvidencePath = path.join(evidenceDir, 'task-11-readme-tone-audit.txt');

const readme = fs.readFileSync(readmePath, 'utf8');
const claimsRegister = fs.readFileSync(claimsRegisterPath, 'utf8');

const checks = [];
const toneChecks = [];

function includesCheck(name, haystack, needle) {
  return {
    name,
    pass: haystack.includes(needle),
    detail: needle,
  };
}

function regexCheck(name, haystack, regex, detail) {
  return {
    name,
    pass: regex.test(haystack),
    detail: detail || String(regex),
  };
}

function forbiddenCheck(name, haystack, patterns) {
  const matches = [];
  for (const pattern of patterns) {
    const regex = new RegExp(pattern, 'gi');
    const found = haystack.match(regex) || [];
    for (const match of found) matches.push(match);
  }
  return {
    name,
    pass: matches.length === 0,
    detail: matches.length ? matches.join(', ') : 'none found',
  };
}

const requiredReadmeSections = [
  '# SolidKG',
  '## Why It Exists',
  '## What SolidKG Does Today',
  '## Repository And Release Status',
  '## Attribution And Alternative Credit',
  '## Install And Run Modes',
  '## CLI Overview',
  '## MCP Overview',
  '## TypeScript API',
  '## Supported Inputs',
  '## Evaluation Evidence And Caveats',
  '## Release And Distribution Boundary',
  '## Non-Goals',
  '## Evaluation Checklist For Buyers',
];

for (const section of requiredReadmeSections) {
  checks.push(includesCheck(`README section present: ${section}`, readme, section));
}

const requiredClaimAnchors = [
  'TypeScript MCP server, CLI, and SDK that turns source repositories into a local SQLite code graph',
  'AI coding agents and internal engineering tools',
  'deterministic AST-derived facts',
  'MCP tools',
  'CLI commands',
  'TypeScript API',
  'In our benchmark runs on the tested repos and prompts, median of 4 runs per arm',
  'evidence for evaluation, not a guarantee',
  'The current product is TypeScript and Node',
  'KiroGraph publicly says it is inspired by SolidKG',
  'Graphify appears in the reviewed README as a separate knowledge-graph assistant skill',
  'Unsupported claims should be removed until evidence exists',
  'Current local evidence shows support for the listed languages, framework patterns, MCP tools, installer targets, and tests',
];

for (const anchor of requiredClaimAnchors) {
  checks.push(includesCheck(`README claim anchor present: ${anchor}`, readme, anchor));
}

const requiredRegisterAnchors = [
  'Allowed wording',
  'Forbidden wording',
  'Verification command/source',
  'In our benchmark runs on the tested repos and prompts',
  'These numbers are evidence for evaluation, not a guarantee',
  'The current product is TypeScript and Node',
  'KiroGraph may be described as inspired by SolidKG',
  'Graphify must be described as a separate project',
  'Unsupported claims must be removed',
];

for (const anchor of requiredRegisterAnchors) {
  checks.push(includesCheck(`Claims register anchor present: ${anchor}`, claimsRegister, anchor));
}

checks.push(regexCheck(
  'Package boundary states private package',
  readme,
  /private source tree[\s\S]*private: true[\s\S]*prepublishOnly/i,
  'private source tree, private: true, prepublishOnly'
));

checks.push(regexCheck(
  'Install modes mention source, local link, standalone installers, npm shim, and agent installer',
  readme,
  /Source Checkout[\s\S]*Local Global Link[\s\S]*Standalone Shell Installer[\s\S]*Standalone PowerShell Installer[\s\S]*npm Shim[\s\S]*Agent Integration Installer/,
  'all required install modes in order'
));

checks.push(regexCheck(
  'Static analysis limits are explicit',
  readme,
  /does not mean SolidKG handles every language feature[\s\S]*Static extraction cannot prove every runtime behavior/,
  'language and runtime limits present'
));

const forbiddenClaims = [
  'always makes agents faster',
  'guaranteed fewer tokens',
  'guaranteed.*faster',
  'best code graph for every',
  'works with every agent',
  'complete language coverage',
  'handles every framework',
  'Rust-powered speedup',
  'publicly available on npm',
];

checks.push(forbiddenCheck('Unsupported or out-of-scope README claims absent', readme, forbiddenClaims));

const competitorInsults = [
  '\binferior\b',
  '\bcopycat\b',
  '\bdestroy\b',
  '\bcrush\b',
  '\bobsolete\b',
  '\bworse\b',
  '\bkills\b',
  '\bdominates\b',
  '\bthe only serious option\b',
  '\bbetter overall\b',
  '\bcopied SolidKG\b',
];

const aiSlopPhrases = [
  'delve',
  "it's important to note",
  "I'd be happy to",
  'certainly',
  "please don't hesitate",
  'leverage',
  'utilize',
  'in order to',
  'moving forward',
  'circle back',
  'at the end of the day',
  'robust',
  'streamline',
  'facilitate',
];

toneChecks.push(forbiddenCheck('Competitor insulting phrases absent', readme, competitorInsults));
toneChecks.push(forbiddenCheck('AI-slop phrases absent', readme, aiSlopPhrases));
toneChecks.push(forbiddenCheck('Em dash and en dash absent', readme, ['—', '–']));
toneChecks.push(includesCheck('Attribution section present', readme, '## Attribution And Alternative Credit'));
toneChecks.push(includesCheck('KiroGraph credited respectfully', readme, 'KiroGraph publicly says it is inspired by SolidKG and credits Colby McHenry\'s SolidKG concept'));
toneChecks.push(includesCheck('Graphify described neutrally', readme, 'Graphify appears in the reviewed README as a separate knowledge-graph assistant skill'));
toneChecks.push(includesCheck('Fork language is conservative', readme, 'Fork, derived-from, based-on, or copied-from language needs maintainer confirmation'));

function formatReport(title, list) {
  const lines = [];
  lines.push(title);
  lines.push(`timestamp=${new Date().toISOString()}`);
  lines.push(`readme=${path.relative(repoRoot, readmePath)}`);
  lines.push(`claimsRegister=${path.relative(repoRoot, claimsRegisterPath)}`);
  lines.push('');
  for (const check of list) {
    lines.push(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}`);
    lines.push(`  detail: ${check.detail}`);
  }
  lines.push('');
  lines.push(`summary=${list.every((check) => check.pass) ? 'pass' : 'fail'}`);
  lines.push('');
  return lines.join('\n');
}

fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(claimsEvidencePath, formatReport('Task 11 README claims audit', checks));
fs.writeFileSync(toneEvidencePath, formatReport('Task 11 README tone audit', toneChecks));

const failed = checks.concat(toneChecks).filter((check) => !check.pass);
if (failed.length) {
  for (const check of failed) {
    process.stderr.write(`FAIL ${check.name}: ${check.detail}\n`);
  }
  process.stderr.write(`Wrote ${claimsEvidencePath}\n`);
  process.stderr.write(`Wrote ${toneEvidencePath}\n`);
  process.exit(1);
}

process.stdout.write(`README claims audit passed: ${claimsEvidencePath}\n`);
process.stdout.write(`README tone audit passed: ${toneEvidencePath}\n`);