#!/usr/bin/env node
// Probe solidkg_context (with call-paths) against an index using the built dist.
// Usage: node probe-context.mjs <repo-with-.solidkg> <task words...>
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [, , repo, ...taskParts] = process.argv;
const task = taskParts.join(' ');
if (!repo || !task) { console.error('usage: probe-context.mjs <repo> <task...>'); process.exit(1); }

const load = async (rel) => import(pathToFileURL(resolve(rel)).href);
const idx = await load('dist/index.js');
const tools = await load('dist/mcp/tools.js');
const SolidKG = idx.default?.default ?? idx.default ?? idx.SolidKG;
const ToolHandler = tools.ToolHandler ?? tools.default?.ToolHandler;

const cg = SolidKG.openSync(repo);
const h = new ToolHandler(cg);
const res = await h.execute('solidkg_context', { task });
console.log(res.content?.[0]?.text ?? '(no text)');
try { cg.close?.(); } catch {}
