#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INPUT_SCHEMA = 'solidkg.peer-structural-benchmark.results.v1';
const REPORT_SCHEMA = 'solidkg.peer-structural-benchmark.report.v1';
const DEFAULT_OUT = 'D:/tmp/opencode/cg-peer-bench/report';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizePathText(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function estimateTokens(bytes) {
  return Math.ceil(Math.max(0, bytes) / 4);
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function validateResults(results) {
  const errors = [];
  if (!isRecord(results)) return ['results must be a JSON object'];
  if (results.schemaName !== INPUT_SCHEMA) errors.push(`schemaName must be ${INPUT_SCHEMA}`);
  if (!isRecord(results.repo)) errors.push('repo is required');
  if (!Array.isArray(results.peers) || results.peers.length === 0) errors.push('peers must include at least one peer');
  if (!Array.isArray(results.scenarios) || results.scenarios.length === 0) errors.push('scenarios must include at least one scenario');

  const peerIds = new Set();
  if (Array.isArray(results.peers)) {
    results.peers.forEach((peer, index) => {
      if (!isRecord(peer)) {
        errors.push(`peers[${index}] must be an object`);
        return;
      }
      if (!hasText(peer.id)) errors.push(`peers[${index}].id is required`);
      if (!hasText(peer.name)) errors.push(`peers[${index}].name is required`);
      if (hasText(peer.id)) peerIds.add(peer.id);
      if (!Array.isArray(peer.commands)) errors.push(`peers[${index}].commands must be an array`);
      if (!Array.isArray(peer.cleanupNotes)) errors.push(`peers[${index}].cleanupNotes must be an array`);
    });
  }

  if (Array.isArray(results.scenarios)) {
    results.scenarios.forEach((scenario, scenarioIndex) => {
      if (!isRecord(scenario)) {
        errors.push(`scenarios[${scenarioIndex}] must be an object`);
        return;
      }
      if (!hasText(scenario.id)) errors.push(`scenarios[${scenarioIndex}].id is required`);
      if (!isRecord(scenario.expected)) errors.push(`scenarios[${scenarioIndex}].expected is required`);
      if (!Array.isArray(scenario.runs) || scenario.runs.length === 0) {
        errors.push(`scenarios[${scenarioIndex}].runs must include at least one run`);
        return;
      }
      scenario.runs.forEach((run, runIndex) => {
        const path = `scenarios[${scenarioIndex}].runs[${runIndex}]`;
        if (!isRecord(run)) {
          errors.push(`${path} must be an object`);
          return;
        }
        if (!peerIds.has(run.peerId)) errors.push(`${path}.peerId must match a peer id`);
        for (const field of ['queryCount', 'durationMs', 'outputBytes', 'referenceCount']) {
          if (typeof run[field] !== 'number' || !Number.isFinite(run[field]) || run[field] < 0) errors.push(`${path}.${field} must be a non-negative number`);
        }
        if (!Array.isArray(run.foundSymbols)) errors.push(`${path}.foundSymbols must be an array`);
        if (!Array.isArray(run.foundFiles)) errors.push(`${path}.foundFiles must be an array`);
        if (!Array.isArray(run.notes)) errors.push(`${path}.notes must be an array`);
        if (!hasText(run.status)) errors.push(`${path}.status is required`);
        if (!hasText(run.sourceFidelity)) errors.push(`${path}.sourceFidelity is required`);
      });
    });
  }

  return errors;
}

function scoreRun(run, expected, maxReferenceCount) {
  const expectedSymbols = Array.isArray(expected?.symbols) ? expected.symbols : [];
  const expectedFiles = Array.isArray(expected?.files) ? expected.files : [];
  const foundSymbols = new Set((run.foundSymbols ?? []).map((item) => String(item).toLowerCase()));
  const foundFiles = new Set((run.foundFiles ?? []).map((item) => normalizePathText(item).toLowerCase()));

  const symbolHits = expectedSymbols.filter((symbol) => foundSymbols.has(String(symbol).toLowerCase())).length;
  const fileHits = expectedFiles.filter((file) => foundFiles.has(normalizePathText(file).toLowerCase())).length;
  const expectedTotal = expectedSymbols.length + expectedFiles.length;
  const evidenceHitRate = expectedTotal === 0 ? 0 : (symbolHits + fileHits) / expectedTotal;

  const fidelityScore = run.sourceFidelity === 'exact' ? 1 : run.sourceFidelity === 'partial' ? 0.5 : 0;
  const statusScore = run.status === 'pass' ? 1 : run.status === 'partial' ? 0.5 : 0;
  const referenceCoverage = maxReferenceCount > 0 ? Math.min(run.referenceCount / maxReferenceCount, 1) : statusScore;
  const structuralScore = Math.round(100 * ((0.45 * evidenceHitRate) + (0.25 * fidelityScore) + (0.2 * referenceCoverage) + (0.1 * statusScore)));

  return {
    peerId: run.peerId,
    status: run.status,
    evidenceHitRate: Number(evidenceHitRate.toFixed(3)),
    sourceFidelity: run.sourceFidelity,
    sourceFidelityScore: fidelityScore,
    referenceCount: run.referenceCount,
    referenceCoverage: Number(referenceCoverage.toFixed(3)),
    queryCount: run.queryCount,
    durationMs: run.durationMs,
    outputBytes: run.outputBytes,
    estimatedTokens: estimateTokens(run.outputBytes),
    structuralScore,
    foundSymbols: run.foundSymbols,
    foundFiles: run.foundFiles,
    notes: run.notes,
  };
}

function buildReport(results) {
  const peers = results.peers;
  const scenarioSummaries = results.scenarios.map((scenario) => {
    const maxReferenceCount = scenario.expected?.comparableReferences === false ? 0 : Math.max(0, ...scenario.runs.map((run) => run.referenceCount));
    const peerScores = scenario.runs.map((run) => scoreRun(run, scenario.expected, maxReferenceCount));
    const comparableScores = peerScores.filter((score) => score.status !== 'not_run');
    const maxScore = Math.max(...(comparableScores.length > 0 ? comparableScores : peerScores).map((score) => score.structuralScore));
    return {
      id: scenario.id,
      title: scenario.title,
      kind: scenario.kind,
      expected: scenario.expected,
      comparableReferences: scenario.expected?.comparableReferences !== false,
      winnerPeerIds: peerScores.filter((score) => score.structuralScore === maxScore).map((score) => score.peerId),
      peerScores,
    };
  });

  const aggregateScores = peers.map((peer) => {
    const scores = scenarioSummaries.flatMap((scenario) => scenario.peerScores.filter((score) => score.peerId === peer.id && score.status !== 'not_run'));
    const averageStructuralScore = scores.length > 0 ? Math.round(scores.reduce((sum, score) => sum + score.structuralScore, 0) / scores.length) : 0;
    const averageEvidenceHitRate = scores.length > 0 ? Number((scores.reduce((sum, score) => sum + score.evidenceHitRate, 0) / scores.length).toFixed(3)) : 0;
    const totalReferences = scores.reduce((sum, score) => sum + score.referenceCount, 0);
    const totalEstimatedTokens = scores.reduce((sum, score) => sum + score.estimatedTokens, 0);
    const totalQueries = scores.reduce((sum, score) => sum + score.queryCount, 0);
    return {
      peerId: peer.id,
      peerName: peer.name,
      averageStructuralScore,
      averageEvidenceHitRate,
      totalReferences,
      totalEstimatedTokens,
      totalQueries,
      measuredScenarios: scores.length,
    };
  }).sort((a, b) => b.averageStructuralScore - a.averageStructuralScore || b.totalReferences - a.totalReferences);

  const findings = [];
  findings.push('Fairness fix: every peer is measured on every scenario, so aggregate scores use the same scenario denominator.');
  const callerScenario = scenarioSummaries.find((scenario) => scenario.id === 'callers-findRelevantContext');
  if (callerScenario) {
    const solidkg = callerScenario.peerScores.find((score) => score.peerId === 'solidkg');
    const tilth = callerScenario.peerScores.find((score) => score.peerId === 'tilth');
    if (solidkg && tilth && tilth.referenceCount > solidkg.referenceCount) {
      findings.push(`SolidKG gap: Tilth reported ${tilth.referenceCount} findRelevantContext caller references while SolidKG direct caller query reported ${solidkg.referenceCount}.`);
    }
  }
  for (const aggregate of aggregateScores) {
    findings.push(`${aggregate.peerName}: average structural score ${aggregate.averageStructuralScore}/100 across ${aggregate.measuredScenarios} measured scenarios.`);
  }

  return {
    schemaName: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    repo: results.repo,
    methodology: {
      headline: 'Structural retrieval quality, caller/reference coverage, and source fidelity are primary. Speed is secondary because indexes are paid once and then updated incrementally.',
      metrics: ['structuralScore', 'evidenceHitRate', 'sourceFidelity', 'referenceCoverage', 'estimatedTokens', 'queryCount', 'durationMs'],
      caveat: 'Scores compare the measured scenarios only. They do not prove universal superiority across every repository, prompt, model, or agent workflow.',
    },
    peers,
    aggregateScores,
    scenarioSummaries,
    findings,
    cleanup: results.cleanup ?? { safeToRemove: [], doNotRemoveAutomatically: [] },
    rawNotes: results.notes ?? [],
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderBars(rows, valueKey, labelKey, title) {
  const width = 760;
  const rowHeight = 34;
  const height = 48 + rows.length * rowHeight;
  const max = Math.max(1, ...rows.map((row) => Number(row[valueKey]) || 0));
  const body = rows.map((row, index) => {
    const value = Number(row[valueKey]) || 0;
    const barWidth = Math.round((value / max) * 520);
    const y = 38 + index * rowHeight;
    return `<text x="12" y="${y + 17}" font-size="13">${escapeHtml(row[labelKey])}</text><rect x="190" y="${y}" width="${barWidth}" height="20" rx="4"></rect><text x="${200 + barWidth}" y="${y + 15}" font-size="12">${escapeHtml(value)}</text>`;
  }).join('');
  return `<svg role="img" aria-label="${escapeHtml(title)}" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"><style>rect{fill:#2563eb} text{font-family:system-ui,Segoe UI,sans-serif;fill:#111827}</style><text x="12" y="22" font-size="16" font-weight="700">${escapeHtml(title)}</text>${body}</svg>`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Peer Structural Benchmark');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(`Repository: ${report.repo.name ?? basename(report.repo.path ?? 'unknown')} (${report.repo.path ?? 'unknown path'})`);
  lines.push('');
  lines.push(`Methodology: ${report.methodology.headline}`);
  lines.push('');
  lines.push('Speed is secondary; structural evidence quality, source fidelity, caller/reference coverage, and output economy are primary.');
  lines.push('');
  lines.push('## Aggregate Scores');
  lines.push('');
  lines.push('| Peer | Structural score | Evidence hit rate | References | Est. tokens | Queries |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const row of report.aggregateScores) {
    lines.push(`| ${row.peerName} | ${row.averageStructuralScore} | ${pct(row.averageEvidenceHitRate)} | ${row.totalReferences} | ${row.totalEstimatedTokens} | ${row.totalQueries} |`);
  }
  lines.push('');
  lines.push('## Scenario Results');
  for (const scenario of report.scenarioSummaries) {
    lines.push('');
    lines.push(`### ${scenario.title}`);
    lines.push('');
    lines.push(`Winner(s): ${scenario.winnerPeerIds.join(', ')}`);
    if (!scenario.comparableReferences) lines.push('Reference counts are diagnostic only for this scenario because peers report different structural units.');
    lines.push('');
    lines.push('| Peer | Status | Score | Hit rate | Fidelity | References | Est. tokens | Notes |');
    lines.push('|---|---|---:|---:|---|---:|---:|---|');
    for (const score of scenario.peerScores) {
      lines.push(`| ${score.peerId} | ${score.status} | ${score.structuralScore} | ${pct(score.evidenceHitRate)} | ${score.sourceFidelity} | ${score.referenceCount} | ${score.estimatedTokens} | ${score.notes.join('; ')} |`);
    }
  }
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  for (const finding of report.findings) lines.push(`- ${finding}`);
  lines.push('');
  lines.push('## Cleanup');
  lines.push('');
  lines.push(`Safe temp paths to remove: ${(report.cleanup.safeToRemove ?? []).join(', ') || 'none recorded'}`);
  lines.push('');
  lines.push(`Do not remove automatically: ${(report.cleanup.doNotRemoveAutomatically ?? []).join(', ') || 'none recorded'}`);
  lines.push('');
  lines.push('## Caveat');
  lines.push('');
  lines.push(report.methodology.caveat);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function renderHtml(report) {
  const scoreChart = renderBars(report.aggregateScores, 'averageStructuralScore', 'peerName', 'Average structural score');
  const referenceChart = renderBars(report.aggregateScores, 'totalReferences', 'peerName', 'Reference coverage count');
  const tokenChart = renderBars(report.aggregateScores, 'totalEstimatedTokens', 'peerName', 'Estimated output tokens');
  const rows = report.aggregateScores.map((row) => `<tr><td>${escapeHtml(row.peerName)}</td><td>${row.averageStructuralScore}</td><td>${pct(row.averageEvidenceHitRate)}</td><td>${row.totalReferences}</td><td>${row.totalEstimatedTokens}</td><td>${row.totalQueries}</td></tr>`).join('');
  const scenarioSections = report.scenarioSummaries.map((scenario) => {
    const peerRows = scenario.peerScores.map((score) => `<tr><td>${escapeHtml(score.peerId)}</td><td>${escapeHtml(score.status)}</td><td>${score.structuralScore}</td><td>${pct(score.evidenceHitRate)}</td><td>${escapeHtml(score.sourceFidelity)}</td><td>${score.referenceCount}</td><td>${score.estimatedTokens}</td><td>${escapeHtml(score.notes.join('; '))}</td></tr>`).join('');
    const referenceNote = scenario.comparableReferences ? '' : '<p><em>Reference counts are diagnostic only for this scenario because peers report different structural units.</em></p>';
    return `<section><h3>${escapeHtml(scenario.title)}</h3><p><strong>Winner(s):</strong> ${escapeHtml(scenario.winnerPeerIds.join(', '))}</p>${referenceNote}<table><thead><tr><th>Peer</th><th>Status</th><th>Structural score</th><th>Hit rate</th><th>Fidelity</th><th>References</th><th>Est. tokens</th><th>Notes</th></tr></thead><tbody>${peerRows}</tbody></table></section>`;
  }).join('\n');
  const findings = report.findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Peer Structural Benchmark</title>
<style>
:root{color-scheme:light;--bg:#f8fafc;--card:#fff;--text:#111827;--muted:#4b5563;--line:#d1d5db;--accent:#2563eb}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,Segoe UI,sans-serif;line-height:1.5}main{max-width:1120px;margin:0 auto;padding:32px}section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:18px 0;box-shadow:0 1px 2px rgba(15,23,42,.06)}h1{font-size:34px;margin:0 0 8px}h2{margin-top:0}.muted{color:var(--muted)}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}th{background:#f3f4f6}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.chart{background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px;overflow:hidden}code{background:#eef2ff;padding:2px 4px;border-radius:4px}</style>
</head>
<body><main>
<h1>Peer Structural Benchmark</h1>
<p class="muted">Generated ${escapeHtml(report.generatedAt)} for <code>${escapeHtml(report.repo.path ?? report.repo.name)}</code>.</p>
<section><h2>Methodology</h2><p>${escapeHtml(report.methodology.headline)}</p><p><strong>Speed is secondary.</strong> Structural score combines expected evidence hits, source fidelity, caller/reference coverage, and run status. Tokens and duration are diagnostics, not the headline.</p><p>${escapeHtml(report.methodology.caveat)}</p></section>
<section><h2>Aggregate Results</h2><table><thead><tr><th>Peer</th><th>Structural score</th><th>Evidence hit rate</th><th>References</th><th>Est. tokens</th><th>Queries</th></tr></thead><tbody>${rows}</tbody></table></section>
<section><h2>Graphics</h2><div class="charts"><div class="chart">${scoreChart}</div><div class="chart">${referenceChart}</div><div class="chart">${tokenChart}</div></div></section>
${scenarioSections}
<section><h2>Findings</h2><ul>${findings}</ul></section>
<section><h2>Cleanup</h2><p><strong>Safe temp paths:</strong> ${escapeHtml((report.cleanup.safeToRemove ?? []).join(', ') || 'none recorded')}</p><p><strong>Do not remove automatically:</strong> ${escapeHtml((report.cleanup.doNotRemoveAutomatically ?? []).join(', ') || 'none recorded')}</p></section>
</main></body></html>
`;
}

function writeArtifacts(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'peer-structural-benchmark.json');
  const markdownPath = join(outDir, 'peer-structural-benchmark.md');
  const htmlPath = join(outDir, 'peer-structural-benchmark.html');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(report));
  writeFileSync(htmlPath, renderHtml(report));
  return { json: jsonPath, markdown: markdownPath, html: htmlPath };
}

function runCommand(command, cwd) {
  const start = performance.now();
  const psCommand = command.replace(/^"([^"]+\.exe)"/, '& "$1"');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-Command', psCommand], { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const durationMs = Math.round(performance.now() - start);
  return {
    command,
    statusCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    durationMs,
    outputBytes: Buffer.byteLength(`${result.stdout ?? ''}${result.stderr ?? ''}`, 'utf8'),
  };
}

function findJsonArray(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('[')) return [];
  try {
    return JSON.parse(trimmed);
  } catch {
    return [];
  }
}

function pathsFromJsonItems(items) {
  return [...new Set(items.map((item) => normalizePathText(item?.node?.filePath ?? item?.file_path ?? item?.source?.file_path)).filter(Boolean))];
}

function symbolsFromJsonItems(items) {
  return [...new Set(items.map((item) => item?.node?.name ?? item?.name ?? item?.source?.name).filter(Boolean))];
}

function buildRun(peerId, commandResult, expected, parser) {
  if (commandResult.statusCode !== 0) {
    return {
      peerId,
      status: 'fail',
      queryCount: 1,
      durationMs: commandResult.durationMs,
      outputBytes: commandResult.outputBytes,
      foundSymbols: [],
      foundFiles: [],
      referenceCount: 0,
      sourceFidelity: 'missing',
      notes: [`Command failed: ${commandResult.stderr.trim().slice(0, 300)}`],
    };
  }
  return parser(commandResult, expected);
}

function parseSolidKGSearch(peerId, commandResult, expected) {
  const items = findJsonArray(commandResult.stdout);
  const foundSymbols = symbolsFromJsonItems(items);
  const foundFiles = pathsFromJsonItems(items);
  return {
    peerId,
    status: foundFiles.length > 0 ? 'pass' : 'partial',
    queryCount: 1,
    durationMs: commandResult.durationMs,
    outputBytes: commandResult.outputBytes,
    foundSymbols,
    foundFiles,
    referenceCount: foundSymbols.length,
    sourceFidelity: foundFiles.length > 0 ? 'exact' : 'missing',
    notes: ['Local SolidKG CLI JSON output.'],
  };
}

export function parseSolidKGCallers(peerId, commandResult) {
  try {
    const parsed = JSON.parse(commandResult.stdout);
    const callers = Array.isArray(parsed.callers) ? parsed.callers : [];
    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const evidenceNodes = [...matches, ...callers];
    const foundSymbols = [...new Set(evidenceNodes.map((node) => node.name).filter(Boolean))];
    const foundFiles = [...new Set(evidenceNodes.map((node) => normalizePathText(node.filePath)).filter(Boolean))];
    return {
      peerId,
      status: foundSymbols.length > 0 || foundFiles.length > 0 ? 'pass' : 'partial',
      queryCount: 1,
      durationMs: commandResult.durationMs,
      outputBytes: commandResult.outputBytes,
      foundSymbols,
      foundFiles,
      referenceCount: callers.length,
      sourceFidelity: foundFiles.length > 0 ? 'exact' : 'missing',
      notes: callers.length > 0 ? ['Local SolidKG caller output with target match metadata.'] : ['Direct caller query returned no callers; target match metadata retained.'],
    };
  } catch {
    return { peerId, status: 'partial', queryCount: 1, durationMs: commandResult.durationMs, outputBytes: commandResult.outputBytes, foundSymbols: [], foundFiles: [], referenceCount: 0, sourceFidelity: 'missing', notes: ['SolidKG caller output was not JSON parseable.'] };
  }
}

function parseTilthText(peerId, commandResult, expected) {
  const text = normalizePathText(commandResult.stdout);
  const expectedSymbols = expected.symbols ?? [];
  const expectedFiles = expected.files ?? [];
  const foundSymbols = expectedSymbols.filter((symbol) => text.toLowerCase().includes(String(symbol).toLowerCase()));
  const foundFiles = expectedFiles.filter((file) => text.toLowerCase().includes(normalizePathText(file).toLowerCase()));
  const callerMatch = text.match(/Callers of .*? — (\d+) call sites/i);
  const usageMatch = text.match(/(\d+) usages/i);
  const referenceCount = callerMatch ? Number(callerMatch[1]) : usageMatch ? Number(usageMatch[1]) : foundSymbols.length;
  return {
    peerId,
    status: foundFiles.length > 0 || foundSymbols.length > 0 ? 'pass' : 'partial',
    queryCount: 1,
    durationMs: commandResult.durationMs,
    outputBytes: commandResult.outputBytes,
    foundSymbols,
    foundFiles,
    referenceCount,
    sourceFidelity: foundFiles.length > 0 ? 'exact' : 'missing',
    notes: ['Tilth CLI structural output.'],
  };
}

function parseCartogJson(peerId, commandResult) {
  const items = findJsonArray(commandResult.stdout);
  const foundSymbols = symbolsFromJsonItems(items);
  const foundFiles = pathsFromJsonItems(items);
  return {
    peerId,
    status: foundSymbols.length > 0 || foundFiles.length > 0 ? 'pass' : 'partial',
    queryCount: 1,
    durationMs: commandResult.durationMs,
    outputBytes: commandResult.outputBytes,
    foundSymbols,
    foundFiles,
    referenceCount: items.length,
    sourceFidelity: foundFiles.length > 0 ? 'exact' : 'missing',
    notes: ['Cartog CLI JSON output.'],
  };
}

function parseSolidKGImpact(peerId, commandResult, expected) {
  try {
    const parsed = JSON.parse(commandResult.stdout);
    const affected = Array.isArray(parsed.affected) ? parsed.affected : [];
    return {
      peerId,
      status: affected.length > 0 ? 'pass' : 'partial',
      queryCount: 1,
      durationMs: commandResult.durationMs,
      outputBytes: commandResult.outputBytes,
      foundSymbols: [...new Set(affected.map((item) => item.name).filter(Boolean))],
      foundFiles: [...new Set(affected.map((item) => normalizePathText(item.filePath)).filter(Boolean))],
      referenceCount: affected.length,
      sourceFidelity: affected.length > 0 ? 'exact' : 'missing',
      notes: [`Local SolidKG impact output with ${parsed.nodeCount ?? affected.length} affected nodes.`],
    };
  } catch {
    return { peerId, status: 'partial', queryCount: 1, durationMs: commandResult.durationMs, outputBytes: commandResult.outputBytes, foundSymbols: [], foundFiles: [], referenceCount: 0, sourceFidelity: 'missing', notes: ['SolidKG impact output was not JSON parseable.'] };
  }
}

function symbolFromCartogId(value) {
  const text = String(value ?? '');
  const parts = text.split(':');
  return parts.length >= 3 ? parts.slice(2).join(':') : '';
}

function fileFromCartogId(value) {
  const text = String(value ?? '');
  const marker = text.indexOf(':');
  return marker > 0 ? normalizePathText(text.slice(0, marker)) : '';
}

function parseCartogImpact(peerId, commandResult) {
  const items = findJsonArray(commandResult.stdout);
  const edges = items.map((item) => item?.edge).filter(Boolean);
  const foundSymbols = [...new Set(edges.flatMap((edge) => [edge.target_name, symbolFromCartogId(edge.source_id), symbolFromCartogId(edge.target_id)]).filter(Boolean))];
  const foundFiles = [...new Set(edges.flatMap((edge) => [edge.file_path, fileFromCartogId(edge.source_id), fileFromCartogId(edge.target_id)]).map(normalizePathText).filter(Boolean))];
  return {
    peerId,
    status: edges.length > 0 ? 'pass' : 'partial',
    queryCount: 1,
    durationMs: commandResult.durationMs,
    outputBytes: commandResult.outputBytes,
    foundSymbols,
    foundFiles,
    referenceCount: items.length,
    sourceFidelity: foundFiles.length > 0 ? 'exact' : 'missing',
    notes: ['Cartog impact JSON edge output.'],
  };
}

function parseSverkloProof(peerId, commandResult, expected) {
  const text = normalizePathText(commandResult.stdout);
  const foundSymbols = (expected.symbols ?? []).filter((symbol) => text.toLowerCase().includes(String(symbol).toLowerCase()));
  const foundFiles = (expected.files ?? []).filter((file) => text.toLowerCase().includes(normalizePathText(file).toLowerCase()));
  const referenceMatch = text.match(/found\s+(\d+)\s+references/i);
  return {
    peerId,
    status: foundSymbols.length > 0 || foundFiles.length > 0 ? 'pass' : 'partial',
    queryCount: 1,
    durationMs: commandResult.durationMs,
    outputBytes: commandResult.outputBytes,
    foundSymbols,
    foundFiles,
    referenceCount: referenceMatch ? Number(referenceMatch[1]) : 0,
    sourceFidelity: foundFiles.length > 0 ? 'exact' : 'missing',
    notes: ['Sverklo no-write proof output; model/index cache may be under the user profile.'],
  };
}

const FAIR_PEER_IDS = ['solidkg', 'tilth', 'cartog', 'sverklo'];

const FAIR_SCENARIOS = [
  {
    id: 'symbol-source-getNodeText',
    title: 'Find getNodeText definition and source',
    kind: 'symbol_source',
    query: 'getNodeText',
    primaryFile: 'src/extraction/tree-sitter-helpers.ts',
    expected: { symbols: ['getNodeText'], files: ['src/extraction/tree-sitter-helpers.ts'] },
  },
  {
    id: 'symbol-source-SolidKG',
    title: 'Find SolidKG class definition and source',
    kind: 'symbol_source',
    query: 'SolidKG',
    primaryFile: 'src/index.ts',
    expected: { symbols: ['SolidKG'], files: ['src/index.ts'] },
  },
  {
    id: 'symbol-source-ToolHandler',
    title: 'Find ToolHandler class definition and source',
    kind: 'symbol_source',
    query: 'ToolHandler',
    primaryFile: 'src/mcp/tools.ts',
    expected: { symbols: ['ToolHandler'], files: ['src/mcp/tools.ts'] },
  },
  {
    id: 'symbol-source-writeArtifacts',
    title: 'Find benchmark artifact writer',
    kind: 'symbol_source',
    query: 'writeArtifacts',
    primaryFile: 'scripts/agent-eval/peer-structural-benchmark.mjs',
    expected: { symbols: ['writeArtifacts'], files: ['scripts/agent-eval/peer-structural-benchmark.mjs'] },
  },
  {
    id: 'callers-findRelevantContext',
    title: 'Find callers of findRelevantContext',
    kind: 'caller_reference',
    query: 'findRelevantContext',
    primaryFile: 'src/context/index.ts',
    expected: { symbols: ['findRelevantContext'], files: ['src/context/index.ts', 'src/index.ts', '__tests__/evaluation/runner.ts'], comparableReferences: false },
  },
  {
    id: 'callers-getNodeText',
    title: 'Find callers of getNodeText',
    kind: 'caller_reference',
    query: 'getNodeText',
    primaryFile: 'src/extraction/tree-sitter-helpers.ts',
    expected: { symbols: ['getNodeText'], files: ['src/extraction/tree-sitter-helpers.ts', 'src/extraction/languages/typescript.ts', 'src/extraction/tree-sitter.ts'], comparableReferences: false },
  },
  {
    id: 'callers-buildReport',
    title: 'Find callers of buildReport',
    kind: 'caller_reference',
    query: 'buildReport',
    primaryFile: 'scripts/agent-eval/peer-structural-benchmark.mjs',
    expected: { symbols: ['buildReport'], files: ['scripts/agent-eval/peer-structural-benchmark.mjs'], comparableReferences: false },
  },
  {
    id: 'impact-getNodeText',
    title: 'Find blast radius for changing getNodeText',
    kind: 'impact_radius',
    query: 'getNodeText',
    primaryFile: 'src/extraction/tree-sitter-helpers.ts',
    expected: { symbols: ['getNodeText'], files: ['src/extraction/tree-sitter-helpers.ts', 'src/extraction/languages/typescript.ts'], comparableReferences: false },
  },
  {
    id: 'impact-buildReport',
    title: 'Find blast radius for changing buildReport',
    kind: 'impact_radius',
    query: 'buildReport',
    primaryFile: 'scripts/agent-eval/peer-structural-benchmark.mjs',
    expected: { symbols: ['buildReport', 'renderMarkdown', 'renderHtml'], files: ['scripts/agent-eval/peer-structural-benchmark.mjs'], comparableReferences: false },
  },
  {
    id: 'impact-ToolHandler',
    title: 'Find blast radius for changing ToolHandler',
    kind: 'impact_radius',
    query: 'ToolHandler',
    primaryFile: 'src/mcp/tools.ts',
    expected: { symbols: ['ToolHandler'], files: ['src/mcp/tools.ts'], comparableReferences: false },
  },
];

export function peerCommand(peerId, scenario, repo, solidkgBin, cartogBin, cartogDb) {
  if (peerId === 'solidkg') {
    if (scenario.kind === 'caller_reference') return `node "${solidkgBin}" callers ${scenario.query} --path "${repo}" --limit 200 --json`;
    if (scenario.kind === 'impact_radius') return `node "${solidkgBin}" impact ${scenario.query} --path "${repo}" --depth 2 --json`;
    return `node "${solidkgBin}" query ${scenario.query} --path "${repo}" --json`;
  }
  if (peerId === 'tilth') {
    if (scenario.kind === 'caller_reference') return `npx --yes tilth ${scenario.query} --scope "${repo}" --callers --budget 6000`;
    if (scenario.kind === 'impact_radius') return `npx --yes tilth "${scenario.primaryFile}" --scope "${repo}" --deps --budget 6000`;
    return `npx --yes tilth ${scenario.query} --scope "${repo}" --expand=1 --budget 6000`;
  }
  if (peerId === 'cartog') {
    if (scenario.kind === 'caller_reference') return `"${cartogBin}" --db "${cartogDb}" refs ${scenario.query} --json`;
    if (scenario.kind === 'impact_radius') return `"${cartogBin}" --db "${cartogDb}" impact ${scenario.query} --json`;
    return `"${cartogBin}" --db "${cartogDb}" search ${scenario.query} --json`;
  }
  if (peerId === 'sverklo') return `npm exec --yes --package=sverklo@latest -- sverklo prove "${repo}" --no-write --guided --markdown`;
  throw new Error(`unknown peer: ${peerId}`);
}

function parsePeerRun(peerId, scenario, commandResult) {
  if (peerId === 'solidkg') {
    if (scenario.kind === 'caller_reference') return buildRun(peerId, commandResult, scenario.expected, (result) => parseSolidKGCallers(peerId, result));
    if (scenario.kind === 'impact_radius') return buildRun(peerId, commandResult, scenario.expected, (result, expected) => parseSolidKGImpact(peerId, result, expected));
    return buildRun(peerId, commandResult, scenario.expected, (result, expected) => parseSolidKGSearch(peerId, result, expected));
  }
  if (peerId === 'tilth') return buildRun(peerId, commandResult, scenario.expected, (result, expected) => parseTilthText(peerId, result, expected));
  if (peerId === 'cartog') {
    if (scenario.kind === 'impact_radius') return buildRun(peerId, commandResult, scenario.expected, (result) => parseCartogImpact(peerId, result));
    return buildRun(peerId, commandResult, scenario.expected, (result) => parseCartogJson(peerId, result));
  }
  if (peerId === 'sverklo') return buildRun(peerId, commandResult, scenario.expected, (result, expected) => parseSverkloProof(peerId, result, expected));
  throw new Error(`unknown peer: ${peerId}`);
}

function liveResults(repoPath, options) {
  const repo = resolve(repoPath);
  const solidkgBin = join(process.cwd(), 'dist', 'bin', 'solidkg.js');
  const cartogBin = options.cartogBin ?? 'D:/tmp/opencode/cg-peer-tools/bin/cartog.exe';
  const cartogDb = options.cartogDb ?? 'D:/tmp/opencode/cg-peer-bench/cartog-solidkg.db';
  const peers = [
    { id: 'solidkg', name: 'SolidKG', scope: 'local deterministic AST/SCIP code graph CLI and MCP', commands: [], cleanupNotes: [] },
    { id: 'tilth', name: 'Tilth', scope: 'local structural code reader and MCP', commands: [], cleanupNotes: [] },
    { id: 'cartog', name: 'Cartog', scope: 'local SQLite code graph CLI and MCP', commands: [], cleanupNotes: [`Temporary DB: ${cartogDb}`] },
    { id: 'sverklo', name: 'Sverklo', scope: 'local-first repo memory MCP with symbol graph and proof command', commands: [], cleanupNotes: ['May cache model and index data under C:/Users/Me/.sverklo; do not delete blindly.'] },
  ];

  const cartogIndex = existsSync(cartogBin) ? runCommand(`"${cartogBin}" --db "${cartogDb}" index "${repo}" --no-lsp --json`, repo) : null;
  const peerById = new Map(peers.map((peer) => [peer.id, peer]));
  const missingCartog = { statusCode: 1, stderr: `missing cartog binary: ${cartogBin}`, stdout: '', durationMs: 0, outputBytes: 0 };

  const scenarios = FAIR_SCENARIOS.map((scenario) => {
    const runs = FAIR_PEER_IDS.map((peerId) => {
      const command = peerCommand(peerId, scenario, repo, solidkgBin, cartogBin, cartogDb);
      peerById.get(peerId)?.commands.push(command);
      const commandResult = peerId === 'cartog' && !existsSync(cartogBin) ? missingCartog : runCommand(command, repo);
      return parsePeerRun(peerId, scenario, commandResult);
    });
    return {
      id: scenario.id,
      title: scenario.title,
      kind: scenario.kind,
      expected: scenario.expected,
      runs,
    };
  });

  return {
    schemaName: INPUT_SCHEMA,
    repo: { name: basename(repo), path: repo, revision: 'local-working-tree' },
    generatedAt: new Date().toISOString(),
    notes: [
      cartogIndex ? `Cartog index status ${cartogIndex.statusCode}; ${cartogIndex.outputBytes} output bytes.` : 'Cartog index skipped because binary was missing.',
      'Fair matrix: every scenario records SolidKG, Tilth, Cartog, and Sverklo. Sverklo CLI exposes prove as a broad repo proof, so each scenario parses expected evidence from that proof output.',
    ],
    peers,
    scenarios,
    cleanup: {
      safeToRemove: [cartogDb],
      doNotRemoveAutomatically: ['C:/Users/Me/.sverklo'],
    },
  };
}
function parseArgs(argv) {
  const args = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from-results') args.fromResults = argv[++i];
    else if (arg === '--repo') args.repo = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--cartog-bin') args.cartogBin = argv[++i];
    else if (arg === '--cartog-db') args.cartogDb = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log('usage: node scripts/agent-eval/peer-structural-benchmark.mjs (--from-results <results.json> | --repo <path>) --out <dir> [--cartog-bin <path>] [--cartog-db <path>]');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (args.help || (!args.fromResults && !args.repo)) {
    printHelp();
    process.exit(args.help ? 0 : 2);
  }

  const results = args.fromResults ? JSON.parse(readFileSync(args.fromResults, 'utf8')) : liveResults(args.repo, args);
  const errors = validateResults(results);
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  const report = buildReport(results);
  const artifacts = writeArtifacts(report, args.out);
  console.log(JSON.stringify({ ok: true, artifacts }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}