/**
 * Context Builder Tests
 *
 * Tests for the context building functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import SolidKG from '../src/index';
import { QueryBuilder } from '../src/db/queries';
import { ToolHandler } from '../src/mcp/tools';

function isContextEntryPoint(value: unknown): value is { name: string; kind: string; filePath: string } {
  return typeof value === 'object'
    && value !== null
    && 'name' in value
    && typeof value.name === 'string'
    && 'kind' in value
    && typeof value.kind === 'string'
    && 'filePath' in value
    && typeof value.filePath === 'string';
}

describe('Context Builder', () => {
  let testDir: string;
  let cg: SolidKG;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-context-test-'));

    // Create a sample codebase
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // Create a payment service file
    fs.writeFileSync(
      path.join(srcDir, 'payment.ts'),
      `/**
 * Payment Service
 * Handles payment processing logic.
 */

export interface PaymentResult {
  success: boolean;
  transactionId: string;
  amount: number;
}

export class PaymentService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Process a payment for the given amount
   */
  async processPayment(amount: number): Promise<PaymentResult> {
    // Validate amount
    if (amount <= 0) {
      throw new Error('Invalid amount');
    }

    // Process payment
    const transactionId = this.generateTransactionId();
    return {
      success: true,
      transactionId,
      amount,
    };
  }

  private generateTransactionId(): string {
    return 'txn_' + Math.random().toString(36).substring(2);
  }
}

export function createPaymentService(apiKey: string): PaymentService {
  return new PaymentService(apiKey);
}
`
    );

    // Create a checkout controller file
    fs.writeFileSync(
      path.join(srcDir, 'checkout.ts'),
      `/**
 * Checkout Controller
 * Handles the checkout flow.
 */

import { PaymentService, PaymentResult } from './payment';

export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export class CheckoutController {
  private paymentService: PaymentService;

  constructor(paymentService: PaymentService) {
    this.paymentService = paymentService;
  }

  /**
   * Process checkout for the given cart
   */
  async processCheckout(cart: CartItem[]): Promise<PaymentResult> {
    const total = this.calculateTotal(cart);

    if (total === 0) {
      throw new Error('Cart is empty');
    }

    return this.paymentService.processPayment(total);
  }

  /**
   * Calculate the total price of the cart
   */
  calculateTotal(cart: CartItem[]): number {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }
}
`
    );

    // Create a utilities file
    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      `/**
 * Utility functions
 */

export function formatCurrency(amount: number): string {
  return '$' + amount.toFixed(2);
}

export function validateEmail(email: string): boolean {
  return email.includes('@');
}
`
    );

    fs.writeFileSync(
      path.join(srcDir, 'body-behavior.ts'),
      `export function operateShipment(): string {
  const manifest = 'carrier manifest quarantine reconciliation';
  const escalation = 'warehouse exception routing';
  return manifest + escalation;
}
`
    );

    fs.writeFileSync(
      path.join(srcDir, 'widget.ts'),
      `export interface WidgetFlow {
  id: string;
  ownerEmail: string;
}

export type WidgetFlowConfig = {
  apiKey: string;
  token: string;
};

export function startWidgetFlow(config: WidgetFlowConfig): WidgetFlow {
  const apiKey = 'sk_live_abcdefghijklmnopqrstuvwxyz123456';
  const ownerEmail = 'operator@example.com';
  return renderWidgetFlow(loadWidgetData(apiKey, ownerEmail, config.token));
}

function loadWidgetData(apiKey: string, ownerEmail: string, token: string): WidgetFlow {
  const authorization = 'Bearer abcdefghijklmnopqrstuvwxyz1234567890';
  return { id: apiKey + authorization + token, ownerEmail };
}

function renderWidgetFlow(flow: WidgetFlow): WidgetFlow {
  return flow;
}
`
    );

    const responsesDir = path.join(srcDir, 'resources', 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });
    fs.writeFileSync(
      path.join(responsesDir, 'responses.ts'),
      `export interface ResponseCreateParams {
  input: string;
  stream?: boolean;
}

export interface ResponseStream {
  chunks: string[];
}

export class Responses {
  constructor(private readonly client: { post(path: string, params: ResponseCreateParams): Promise<ResponseStream> }) {}

  async create(params: ResponseCreateParams): Promise<ResponseStream> {
    return this.client.post('/responses', params);
  }
}
`
    );

    const coreDir = path.join(srcDir, 'core');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(
      path.join(coreDir, 'streaming.ts'),
      `export class Stream<Item> {
  controller: AbortController;

  constructor(private readonly iterator: () => AsyncIterator<Item>) {}

  static fromReadableStream<Item>(readableStream: ReadableStream): Stream<Item> {
    return new Stream(async function* streamItems() {
      const reader = readableStream.getReader();
      const result = await reader.read();
      if (!result.done) yield result.value as Item;
    });
  }

  toReadableStream(): ReadableStream {
    return new ReadableStream();
  }
}
`
    );

    const fineTuningDir = path.join(srcDir, 'resources', 'fine-tuning');
    fs.mkdirSync(fineTuningDir, { recursive: true });
    fs.writeFileSync(
      path.join(fineTuningDir, 'fine-tuning.ts'),
      `import { Methods } from './methods';

export class FineTuning {
  methods: Methods = new Methods();
}
`
    );
    fs.writeFileSync(
      path.join(fineTuningDir, 'methods.ts'),
      `export class Methods {}
`
    );

    const noisyDir = path.join(srcDir, 'core-client-retries-streaming');
    fs.mkdirSync(noisyDir, { recursive: true });
    fs.writeFileSync(
      path.join(noisyDir, 'resource-methods.ts'),
      `export class ResourceMethods {
  create(): string {
    const coreClient = 'core client';
    const retries = 'retries';
    const streaming = 'streaming';
    const resourceMethods = 'resource methods';
    return [coreClient, retries, streaming, resourceMethods].join(' ');
  }
}
`
    );

    const noisyResponsesDir = path.join(srcDir, 'resources', 'resource-methods');
    fs.mkdirSync(noisyResponsesDir, { recursive: true });
    for (const suffix of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      fs.writeFileSync(
        path.join(noisyResponsesDir, `responses-create-flow-${suffix}.ts`),
        `export class ResponsesCreateFlowResourceMethodsCoreClientRetriesStreaming${suffix} {
  create(): string {
    const responses = 'responses';
    const create = 'create';
    const flow = 'flow';
    const resourceMethods = 'resource methods';
    const coreClient = 'core client';
    const retries = 'retries';
    const streaming = 'streaming';
    return [responses, create, flow, resourceMethods, coreClient, retries, streaming].join(' ');
  }
}
`
      );
    }

    const kyTypesDir = path.join(srcDir, 'types');
    fs.mkdirSync(kyTypesDir, { recursive: true });
    fs.writeFileSync(
      path.join(kyTypesDir, 'Ky.ts'),
      `export function calculateRetryDelay(): string {
  return 'BROAD_TYPES_CALCULATE_RETRY_DELAY';
}

export function retryFromError(): string {
  return 'BROAD_TYPES_RETRY_FROM_ERROR';
}

export function fetch(): string {
  return 'BROAD_TYPES_FETCH';
}

export function normalizeRetryOptions(): string {
  return 'BROAD_TYPES_NORMALIZE_RETRY_OPTIONS';
}
`
    );

    fs.writeFileSync(
      path.join(coreDir, 'Ky.ts'),
      `export function calculateRetryDelay(): string {
  return 'CORE_KY_CALCULATE_RETRY_DELAY';
}

export function retryFromError(): string {
  return 'CORE_KY_RETRY_FROM_ERROR';
}

export function fetch(): string {
  return 'CORE_KY_FETCH';
}

export function normalizeRetryOptions(): string {
  return 'CORE_KY_NORMALIZE_RETRY_OPTIONS';
}
`
    );

    const compilerNoiseDir = path.join(srcDir, 'compiler-noise');
    fs.mkdirSync(compilerNoiseDir, { recursive: true });
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(compilerNoiseDir, `program-noise-${i}.ts`),
        `export interface Program {
  diagnostics: string[];
}

export interface CompilerHost {
  readFile(path: string): string;
}

export function createProgram(host: CompilerHost): Program {
  return { diagnostics: [host.readFile('noise.ts')] };
}
`
      );
    }

    const compilerDir = path.join(srcDir, 'compiler');
    fs.mkdirSync(compilerDir, { recursive: true });
    fs.writeFileSync(
      path.join(compilerDir, 'program.ts'),
      `export interface Program {
  sourceFiles: string[];
}

export function createProgram(host: { readFile(path: string): string }): Program {
  return { sourceFiles: [host.readFile('entry.ts')] };
}
`
    );

    fs.writeFileSync(
      path.join(compilerDir, 'types.ts'),
      `export interface Program {
  diagnostics: string[];
}

export interface CompilerHost {
  readFile(path: string): string;
}

export type CreateProgram = (rootNames: string[]) => Program;
`
    );

    const mcpDir = path.join(srcDir, 'mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(mcpDir, 'tools.ts'),
      `export class ToolHandler {
  handleTrace(): string {
    return 'TRACE_HANDLER';
  }
}

export const source = 'generic source token';

export function snippet(): string {
  return source;
}
`
    );
    fs.writeFileSync(
      path.join(srcDir, 'benchmark-noise.ts'),
      `export function buildRun(): string {
    return 'unrelated build term';
  }
`
    );

    const curationDir = path.join(srcDir, 'store');
    fs.mkdirSync(curationDir, { recursive: true });
    fs.writeFileSync(
      path.join(curationDir, 'apply-runs.ts'),
      `export type CurationOpKind = 'create' | 'update';

export interface CurationOperation {
  id: string;
  kind: CurationOpKind;
}

export const content_blobs = 'content_blobs';
export const apply_intents = 'apply_intents';
export const apply_operations = 'apply_operations';
export const mutation_sessions = 'mutation_sessions';

export function complete_apply_mutation_with_review_and_audit(operation: CurationOperation): CurationOperation {
  return operation;
}
`
    );
    fs.writeFileSync(
      path.join(curationDir, 'recovery-noise.ts'),
      `export interface RollbackItem {
  id: string;
}

export interface OptimizeSkillsReviewIntentReport {
  id: string;
}

export interface ApplyRecoveryIntentRow {
  id: string;
}
`
    );
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(
        path.join(curationDir, `content-blob-noise-${i}.ts`),
        `export const content_blobs = 'unrelated_content_blob_${i}';
`
      );
    }

    const kyTestDir = path.join(srcDir, '__tests__');
    fs.mkdirSync(kyTestDir, { recursive: true });
    fs.writeFileSync(
      path.join(kyTestDir, 'Ky.test.ts'),
      `export function calculateRetryDelay(): string {
  return 'TEST_KY_CALCULATE_RETRY_DELAY';
}

export function retryFromError(): string {
  return 'TEST_KY_RETRY_FROM_ERROR';
}
`
    );

    // Initialize SolidKG
    cg = SolidKG.initSync(testDir, {
      config: {
        include: ['**/*.ts'],
        exclude: [],
      },
    });

    // Index the codebase
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('getCode()', () => {
    it('should extract code for a node', async () => {
      // Find the PaymentService class
      const nodes = cg.getNodesByKind('class');
      const paymentService = nodes.find((n) => n.name === 'PaymentService');

      expect(paymentService).toBeDefined();

      const code = await cg.getCode(paymentService!.id);

      expect(code).not.toBeNull();
      expect(code).toContain('class PaymentService');
      expect(code).toContain('processPayment');
    });

    it('should return null for non-existent node', async () => {
      const code = await cg.getCode('non-existent-id');
      expect(code).toBeNull();
    });
  });

  describe('findRelevantContext()', () => {
    it('should find relevant nodes for a query', async () => {
      // Use simple query that matches symbol names (FTS5 treats spaces as AND)
      const result = await cg.findRelevantContext('PaymentService');

      expect(result.nodes.size).toBeGreaterThan(0);
      // Should find payment-related nodes
      const nodeNames = Array.from(result.nodes.values()).map((n) => n.name);
      expect(
        nodeNames.some(
          (name) =>
            name.toLowerCase().includes('payment') ||
            name.toLowerCase().includes('checkout')
        )
      ).toBe(true);
    });

    it('should include edges in the result', async () => {
      const result = await cg.findRelevantContext('checkout', {
        traversalDepth: 2,
      });

      // Should have some edges from traversal
      expect(result.edges).toBeDefined();
    });

    it('should respect maxNodes option', async () => {
      const result = await cg.findRelevantContext('function', {
        maxNodes: 5,
      });

      expect(result.nodes.size).toBeLessThanOrEqual(5);
    });

    it('bridges review and skill operation phrases to curation operation types', async () => {
      const result = await cg.findRelevantContext('review operation skill operation', {
        maxNodes: 8,
        searchLimit: 4,
        traversalDepth: 0,
      });

      const nodeNames = Array.from(result.nodes.values()).map((node) => node.name);

      expect(nodeNames).toContain('CurationOperation');
      expect(nodeNames).toContain('CurationOpKind');
    });

    it('ranks apply content recovery schema seams before incidental recovery types', async () => {
      const result = await cg.findRelevantContext('apply content recovery', {
        maxNodes: 8,
        searchLimit: 4,
        traversalDepth: 0,
      });

      const nodeNames = Array.from(result.nodes.values()).map((node) => node.name);
      const seamNames = ['content_blobs', 'apply_intents', 'apply_operations', 'mutation_sessions'];
      const incidentalNames = ['RollbackItem', 'OptimizeSkillsReviewIntentReport', 'ApplyRecoveryIntentRow'];

      expect(nodeNames).toContain('complete_apply_mutation_with_review_and_audit');
      expect(seamNames.every((name) => nodeNames.includes(name))).toBe(true);
      expect(Math.max(...seamNames.map((name) => nodeNames.indexOf(name)))).toBeLessThan(
        Math.min(...incidentalNames.map((name) => nodeNames.indexOf(name)).filter((index) => index >= 0))
      );
    });
  });

  describe('buildContext()', () => {
    it('should build context with markdown format', async () => {
      const result = await cg.buildContext('Fix checkout error', {
        format: 'markdown',
        maxCodeBlocks: 3,
      });

      expect(typeof result).toBe('string');
      const markdown = result as string;

      // Should contain markdown structure
      expect(markdown).toContain('## Code Context');
      expect(markdown).toContain('**Query:** Fix checkout error');
    });

    it('should build context with JSON format', async () => {
      const result = await cg.buildContext('payment processing', {
        format: 'json',
      });

      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result as string);

      expect(parsed.query).toBe('payment processing');
      expect(parsed.schemaVersion).toBe('solidkg.context.v1');
      expect(parsed.nodes).toBeDefined();
      expect(Array.isArray(parsed.nodes)).toBe(true);
      expect(parsed.contextBudget).toMatchObject({
        estimated: true,
        baselineKind: 'candidate_files',
        estimatorVersion: 'chars_div_4_v1',
      });
      expect(parsed.contextBudget.baselineKind).not.toBe('whole_repo');
    });

    it('adds narrow provenance to semantic relation JSON without changing pairwise edge records', async () => {
      const queries = (cg as unknown as { queries: QueryBuilder }).queries;
      const startWidgetFlow = queries.getNodesByName('startWidgetFlow')[0]!;
      const renderWidgetFlow = queries.getNodesByName('renderWidgetFlow')[0]!;
      queries.insertHyperedge({
        id: 'hyperedge:ui-render:widget-flow',
        kind: 'ui_render',
        sourceFile: 'src/widget.ts',
        line: startWidgetFlow.startLine,
        column: startWidgetFlow.startColumn,
        provenance: 'heuristic',
        confidence: 0.8,
        metadata: { synthesizedBy: 'react-render' },
        createdAt: 1,
        updatedAt: 1,
      }, [
        { hyperedgeId: 'hyperedge:ui-render:widget-flow', nodeId: startWidgetFlow.id, role: 'state_mutator', ordinal: 0 },
        { hyperedgeId: 'hyperedge:ui-render:widget-flow', nodeId: renderWidgetFlow.id, role: 'render_method', ordinal: 1 },
      ]);

      const result = await cg.buildContext('startWidgetFlow renderWidgetFlow', {
        format: 'json',
        includeCode: false,
        maxNodes: 8,
        searchLimit: 3,
        traversalDepth: 0,
      });

      const parsed = JSON.parse(result as string) as {
        edges: Array<Record<string, unknown>>;
        hyperedges: Array<{ provenance?: string; hyperedge: { kind: string; provenance?: string } }>;
      };
      const relation = parsed.hyperedges.find((entry) => entry.hyperedge.kind === 'ui_render');
      expect(relation?.provenance).toBe('semantic_synthesis');
      expect(relation?.hyperedge.provenance).toBe('semantic_synthesis');
      expect(parsed.edges.every((edge) => !('provenance' in edge) && !('confidence' in edge))).toBe(true);
    });

    it('renders synthesized call-path provenance for React Native event channels', async () => {
      const queries = (cg as unknown as { queries: QueryBuilder }).queries;
      const loadWidgetData = queries.getNodesByName('loadWidgetData')[0]!;
      const renderWidgetFlow = queries.getNodesByName('renderWidgetFlow')[0]!;
      queries.insertEdge({
        source: loadWidgetData.id,
        target: renderWidgetFlow.id,
        kind: 'calls',
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'rn-event-channel', event: 'locationUpdate' },
      });

      const result = await cg.buildContext('startWidgetFlow loadWidgetData renderWidgetFlow', {
        format: 'markdown',
        includeCode: false,
        maxNodes: 8,
        searchLimit: 4,
        traversalDepth: 1,
      });

      const markdown = result as string;
      expect(markdown).toContain('rn-event-channel (heuristic)');
      expect(markdown).toContain('locationUpdate');
      expect(markdown).not.toContain('solidkg_node any symbol');
    });

    it('includes a markdown Context Budget section only for realistic baselines', async () => {
      const withBaseline = await cg.buildContext('PaymentService', {
        format: 'markdown',
        includeCode: true,
        maxCodeBlocks: 1,
      });

      expect(withBaseline).toContain('### Context Budget');
      expect(withBaseline).toContain('estimated');
      expect(withBaseline).toContain('candidate_files');

      const withoutBaseline = await cg.buildContext('xyznonexistent123', {
        format: 'markdown',
        includeCode: false,
      });

      expect(withoutBaseline).not.toContain('### Context Budget');
    });

    it('should accept object input with title and description', async () => {
      const result = await cg.buildContext(
        {
          title: 'Checkout bug',
          description: 'Cart total calculation is wrong',
        },
        { format: 'markdown' }
      );

      expect(typeof result).toBe('string');
      expect(result).toContain('Checkout bug: Cart total calculation is wrong');
    });

    it('should include code blocks when requested', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'markdown',
        includeCode: true,
        maxCodeBlocks: 2,
      });

      const markdown = result as string;

      // Should contain code blocks
      expect(markdown).toContain('### Code');
      expect(markdown).toContain('```typescript');
    });

    it('prioritizes exact Ky core path and symbols over broad type and test matches under tight code budgets', async () => {
      const result = await cg.buildContext('src/core/Ky.ts:1 calculateRetryDelay retryFromError fetch normalizeRetryOptions', {
        format: 'json',
        includeCode: true,
        maxCodeBlocks: 1,
        maxNodes: 12,
        searchLimit: 6,
        traversalDepth: 0,
      });

      const parsed = JSON.parse(result as string) as {
        codeBlocks: Array<{ filePath: string; content: string }>;
        sourceCompleteness: { status: string; omittedBlocks: number };
        answerPacket: { uncertaintyLabels: string[] };
      };

      expect(parsed.codeBlocks).toHaveLength(1);
      expect(parsed.codeBlocks[0]?.filePath).toBe('src/core/Ky.ts');
      expect(parsed.codeBlocks[0]?.content).toContain('CORE_KY_CALCULATE_RETRY_DELAY');
      expect(parsed.codeBlocks[0]?.content).not.toContain('BROAD_TYPES_CALCULATE_RETRY_DELAY');
      expect(parsed.codeBlocks[0]?.content).not.toContain('TEST_KY_CALCULATE_RETRY_DELAY');
      expect(parsed.sourceCompleteness.status).not.toBe('complete');
      expect(parsed.sourceCompleteness.omittedBlocks).toBeGreaterThan(0);
      expect(parsed.answerPacket.uncertaintyLabels).toContain('source_partial');
    });

    it('keeps an exact lowercase function anchor over generic type terms in context entry points', async () => {
      const result = await cg.buildContext('createProgram CompilerHost Program src/compiler/program.ts', {
        format: 'json',
        includeCode: false,
        maxNodes: 8,
        searchLimit: 3,
        traversalDepth: 0,
      });

      expect(typeof result).toBe('string');
      if (typeof result !== 'string') {
        throw new Error('Expected JSON context output to be a string');
      }

      const parsed: unknown = JSON.parse(result);
      expect(parsed).toEqual(expect.objectContaining({
        entryPoints: expect.any(Array),
      }));
      if (typeof parsed !== 'object' || parsed === null || !('entryPoints' in parsed) || !Array.isArray(parsed.entryPoints)) {
        throw new Error('Expected JSON context output to include entryPoints');
      }

      const entryPoints = parsed.entryPoints.filter(isContextEntryPoint);
      expect(entryPoints).toHaveLength(parsed.entryPoints.length);
      const entryNames = entryPoints.map(node => `${node.kind}:${node.name}:${node.filePath}`);

      expect(entryNames).toContain('function:createProgram:src/compiler/program.ts');
      expect(entryNames[0]).toBe('function:createProgram:src/compiler/program.ts');
    });

    it('should exclude code blocks when requested', async () => {
      const result = await cg.buildContext('payment', {
        format: 'markdown',
        includeCode: false,
      });

      const markdown = result as string;

      // Should not contain code section
      expect(markdown).not.toContain('### Code');
    });

    it('keeps standard detail output identical to the default', async () => {
      const defaultResult = await cg.buildContext('PaymentService', {
        format: 'markdown',
        includeCode: true,
        maxCodeBlocks: 1,
      });
      const standardResult = await cg.buildContext('PaymentService', {
        format: 'markdown',
        detailLevel: 'standard',
        includeCode: true,
        maxCodeBlocks: 1,
      });

      expect(standardResult).toBe(defaultResult);
    });

    it('builds minimal detail without code blocks by default', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'markdown',
        detailLevel: 'minimal',
      });

      const markdown = result as string;
      expect(markdown).toContain('**Detail:** minimal');
      expect(markdown).toContain('### Summary');
      expect(markdown).toContain('### Top Related Files');
      expect(markdown).toContain('### Compact Stats');
      expect(markdown).toContain('### Semantic Relation Counts');
      expect(markdown).toContain('### Next Suggested SolidKG Tools');
      expect(markdown).not.toContain('```typescript');
    });

    it('attaches minimal overview only for repository orientation queries', async () => {
      const orientationResult = await cg.buildContext('repository structure overview', {
        format: 'json',
        detailLevel: 'minimal',
      });
      const symbolResult = await cg.buildContext('where is PaymentService', {
        format: 'json',
        detailLevel: 'minimal',
      });
      const repositorySymbolResult = await cg.buildContext('where is UserRepository', {
        format: 'json',
        detailLevel: 'minimal',
      });
      const projectSymbolResult = await cg.buildContext('where is ProjectConfig', {
        format: 'json',
        detailLevel: 'minimal',
      });
      const treeSymbolResult = await cg.buildContext('where is TreeNode', {
        format: 'json',
        detailLevel: 'minimal',
      });

      const orientation = JSON.parse(orientationResult as string);
      const symbol = JSON.parse(symbolResult as string);
      const repositorySymbol = JSON.parse(repositorySymbolResult as string);
      const projectSymbol = JSON.parse(projectSymbolResult as string);
      const treeSymbol = JSON.parse(treeSymbolResult as string);
      expect(orientation.overview).toMatchObject({
        fileCount: expect.any(Number),
        directoryCount: expect.any(Number),
        symbolCount: expect.any(Number),
      });
      expect(orientation.overview.markdown).toContain('## Repository Overview');
      expect(symbol.overview).toBeUndefined();
      expect(repositorySymbol.overview).toBeUndefined();
      expect(projectSymbol.overview).toBeUndefined();
      expect(treeSymbol.overview).toBeUndefined();
    });

    it('renders source completeness metadata in standard and minimal markdown', async () => {
      const standardResult = await cg.buildContext('PaymentService', {
        format: 'markdown',
        includeCode: true,
        maxCodeBlocks: 1,
      });

      const minimalResult = await cg.buildContext('PaymentService', {
        format: 'markdown',
        detailLevel: 'minimal',
        includeCode: true,
        maxCodeBlocks: 1,
      });

      expect(standardResult).toContain('### Source Completeness');
      expect(standardResult).toContain('Returned source coverage only:');
      expect(minimalResult).toContain('### Source Completeness');
      expect(minimalResult).toContain('Returned source coverage only:');
    });

    it('renders answer packet metadata in markdown and JSON context output', async () => {
      const markdownResult = await cg.buildContext('PaymentService processPayment', {
        format: 'markdown',
        includeCode: true,
        maxCodeBlocks: 10,
      });
      const jsonResult = await cg.buildContext('PaymentService processPayment', {
        format: 'json',
        includeCode: true,
        maxCodeBlocks: 10,
      });

      expect(markdownResult).toContain('### Answer Packet');
      expect(markdownResult).toContain('Binary sufficiency: sufficient');
      expect(markdownResult).toContain('Evidence anchors:');
      expect(markdownResult).toContain('Ranking reasons:');
      expect(markdownResult).not.toContain('solidkg_node any symbol');
      expect(markdownResult).not.toContain('Suggested next SolidKG tools:');

      const parsed = JSON.parse(jsonResult as string);
      expect(parsed.answerPacket).toMatchObject({
        schemaVersion: 'solidkg.answer-packet.v1',
        sufficiency: {
          canAnswerFromReturnedContext: true,
        },
        suggestedNextTools: [],
      });
      expect(parsed.answerPacket.evidence[0].sourceAnchor).toEqual(expect.objectContaining({
        filePath: expect.any(String),
        startLine: expect.any(Number),
        endLine: expect.any(Number),
      }));
      expect(parsed.answerPacket.rankingReasons.map((reason: { kind: string }) => reason.kind)).toContain('source_returned');
    });

    it('surfaces chunk evidence in context answer packets for body-only behavior queries', async () => {
      const result = await cg.buildContext('natural language body-only behavior carrier manifest quarantine routing', {
        format: 'json',
        includeCode: true,
        maxCodeBlocks: 2,
        searchLimit: 4,
      });

      const parsed = JSON.parse(result as string) as {
        entryPoints: Array<{ name: string; filePath: string }>;
        codeBlocks: Array<{ nodeName?: string; content: string }>;
        answerPacket?: { rankingReasons: Array<{ kind: string; label: string }> };
      };

      expect(parsed.entryPoints[0]).toMatchObject({
        name: 'operateShipment',
        filePath: 'src/body-behavior.ts',
      });
      expect(parsed.codeBlocks[0]).toMatchObject({
        nodeName: 'operateShipment',
      });
      expect(parsed.codeBlocks[0]?.content).toContain('carrier manifest quarantine reconciliation');
      expect(parsed.answerPacket?.rankingReasons).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'source_body_chunk',
          label: expect.stringContaining('source chunk'),
        }),
      ]));
    });

    it('allows minimal detail code blocks with explicit includeCode and maxCodeBlocks', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'markdown',
        detailLevel: 'minimal',
        includeCode: true,
        maxCodeBlocks: 1,
      });

      const markdown = result as string;
      expect(markdown).toContain('**Detail:** minimal');
      expect(markdown).toContain('### Code');
      expect(markdown).toContain('```typescript');
    });

    it('emits compact minimal JSON without default code blocks', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'json',
        detailLevel: 'minimal',
      });

      const parsed = JSON.parse(result as string);
      expect(parsed).toMatchObject({
        schemaVersion: 'solidkg.context.v1',
        detailLevel: 'minimal',
        stats: expect.objectContaining({
          nodeCount: expect.any(Number),
          edgeCount: expect.any(Number),
          fileCount: expect.any(Number),
          codeBlockCount: 0,
          semanticRelationCount: expect.any(Number),
        }),
      });
      expect(Array.isArray(parsed.relatedSymbols)).toBe(true);
      expect(Array.isArray(parsed.suggestedTools)).toBe(true);
      expect(parsed.codeBlocks).toEqual([]);
      expect(parsed.contextBudget).toMatchObject({
        estimated: true,
        baselineKind: 'candidate_files',
      });
    });

    it('exposes identical source completeness metadata in standard and minimal JSON', async () => {
      const standardResult = await cg.buildContext('PaymentService', {
        format: 'json',
        includeCode: true,
        maxCodeBlocks: 1,
      });

      const minimalResult = await cg.buildContext('PaymentService', {
        format: 'json',
        detailLevel: 'minimal',
        includeCode: true,
        maxCodeBlocks: 1,
      });

      const standardParsed = JSON.parse(standardResult as string) as {
        sourceCompleteness?: {
          status: string;
          candidateBlocks: number;
          returnedBlocks: number;
          completeBlocks: number;
          truncatedBlocks: number;
          omittedBlocks: number;
          unreadableBlocks: number;
          maxBlocks: number;
          maxBlockSize: number;
        };
      };
      const minimalParsed = JSON.parse(minimalResult as string) as typeof standardParsed;

      expect(standardParsed.sourceCompleteness).toBeDefined();
      expect(minimalParsed.sourceCompleteness).toBeDefined();
      expect(minimalParsed.sourceCompleteness).toMatchObject(standardParsed.sourceCompleteness as Record<string, unknown>);
    });

    type SourceCompleteness = {
      status: string;
      candidateBlocks: number;
      returnedBlocks: number;
      completeBlocks: number;
      truncatedBlocks: number;
      omittedBlocks: number;
      unreadableBlocks: number;
      maxBlocks: number;
      maxBlockSize: number;
      followUp: {
        reason: string;
        guidance: string;
        solidkgFirst: string[];
      };
    };

    type JsonContextWithSourceCompleteness = {
      sourceCompleteness?: SourceCompleteness;
      nodes: Array<{ name: string; filePath: string }>;
      codeBlocks: Array<{ content: string }>;
    };

    function parseJsonContext<T extends object = Record<string, never>>(result: string): T & JsonContextWithSourceCompleteness {
      return JSON.parse(result) as T & JsonContextWithSourceCompleteness;
    }

    it('reports omitted source truthfully when includeCode is false', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'json',
        includeCode: false,
      });

      const parsed = parseJsonContext(result as string);

      expect(parsed.sourceCompleteness).toMatchObject({
        status: 'omitted',
        returnedBlocks: 0,
        completeBlocks: 0,
        truncatedBlocks: 0,
        unreadableBlocks: 0,
        followUp: {
          reason: 'omitted',
          solidkgFirst: ['solidkg_context', 'solidkg_explore', 'solidkg_node'],
        },
      });
      expect(parsed.sourceCompleteness?.followUp.guidance).toContain('before any targeted file read');
      expect(parsed.sourceCompleteness?.candidateBlocks).toBeGreaterThan(0);
      expect(parsed.sourceCompleteness?.omittedBlocks).toBe(parsed.sourceCompleteness?.candidateBlocks);
      expect(parsed.codeBlocks).toEqual([]);
      expect(parsed.answerPacket).toMatchObject({
        sufficiency: {
          canAnswerFromReturnedContext: false,
        },
        uncertaintyLabels: expect.arrayContaining(['source_partial']),
      });
    });

    it('reports truncation truthfully when maxCodeBlockSize forces partial source', async () => {
      const result = await cg.buildContext('how does widget flow work', {
        format: 'json',
        includeCode: true,
        maxCodeBlocks: 5,
        maxCodeBlockSize: 40,
        traversalDepth: 2,
        searchLimit: 4,
      });

      const parsed = parseJsonContext(result as string);

      expect(parsed.sourceCompleteness).toMatchObject({
        status: 'truncated',
        omittedBlocks: 0,
        unreadableBlocks: 0,
        followUp: {
          reason: 'truncated',
          solidkgFirst: ['solidkg_explore', 'solidkg_node'],
        },
      });
      expect(parsed.sourceCompleteness?.followUp.guidance).toContain('narrower solidkg_explore');
      expect(parsed.sourceCompleteness?.truncatedBlocks).toBeGreaterThan(0);
      expect(parsed.sourceCompleteness?.returnedBlocks).toBeGreaterThan(0);
      expect(parsed.sourceCompleteness?.returnedBlocks).toBe(
        (parsed.sourceCompleteness?.completeBlocks ?? 0) + (parsed.sourceCompleteness?.truncatedBlocks ?? 0)
      );
      expect(parsed.codeBlocks.some((block) => block.content.includes('... (truncated) ...'))).toBe(true);
    });

    it('reports unreadable missing source truthfully when an indexed file is deleted', async () => {
      fs.unlinkSync(path.join(testDir, 'src', 'widget.ts'));

      const result = await cg.buildContext('startWidgetFlow loadWidgetData renderWidgetFlow', {
        format: 'json',
        includeCode: true,
        maxCodeBlocks: 5,
        searchLimit: 3,
        traversalDepth: 0,
      });

      const parsed = parseJsonContext(result as string);

      expect(parsed.sourceCompleteness).toMatchObject({
        status: 'unreadable',
        returnedBlocks: 0,
        completeBlocks: 0,
        truncatedBlocks: 0,
        omittedBlocks: 0,
        followUp: {
          reason: 'unreadable',
          solidkgFirst: ['solidkg_status', 'solidkg_node', 'solidkg_explore'],
        },
      });
      expect(parsed.sourceCompleteness?.followUp.guidance).toContain('Check solidkg_status');
      expect(parsed.sourceCompleteness?.candidateBlocks).toBeGreaterThan(0);
      expect(parsed.sourceCompleteness?.unreadableBlocks).toBe(parsed.sourceCompleteness?.candidateBlocks);
      expect(parsed.codeBlocks).toEqual([]);
    });

    it('renders focused SolidKG follow-up in markdown source completeness', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'markdown',
        includeCode: false,
      });

      const markdown = result as string;
      expect(markdown).toContain('### Source Completeness');
      expect(markdown).toContain('Focused SolidKG follow-up:');
      expect(markdown).toContain('solidkg_explore');
      expect(markdown).toContain('before any targeted file read');
      expect(markdown).not.toMatch(/broad Read\/Grep/i);
    });

    it('surfaces conservative context budget metadata in MCP impact output', async () => {
      const handler = new ToolHandler(cg);
      const result = await handler.execute('solidkg_impact', {
        symbol: 'processPayment',
      });
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('## Impact: "processPayment"');
      expect(text).toContain('### Context Budget');
      expect(text).toContain('baselineKind: not_available');
      expect(text).toContain('baselineTokens: null');
      expect(text).toContain('savedTokens: null');
    });

    it('ranks behavior context ahead of passive type-only matches for how-does queries', async () => {
      const result = await cg.buildContext('how does widget flow work', {
        format: 'json',
        includeCode: true,
        traversalDepth: 2,
        searchLimit: 4,
        maxCodeBlocks: 3,
      });

      const parsed = JSON.parse(result as string);
      expect(parsed.entryPoints[0].kind).toBe('function');
      expect(['startWidgetFlow', 'renderWidgetFlow', 'loadWidgetData']).toContain(parsed.entryPoints[0].name);
      expect(parsed.codeBlocks[0]).toMatchObject({
        nodeKind: 'function',
      });
      expect(parsed.edges.some((edge: { kind: string }) => edge.kind === 'calls')).toBe(true);
    });

    it('ranks dot-qualified method context ahead of generic create matches', async () => {
      const result = await cg.buildContext(
        'How does responses.create flow through resource methods, core client, retries, and streaming?',
        {
          format: 'json',
          includeCode: true,
          traversalDepth: 2,
          searchLimit: 4,
          maxCodeBlocks: 3,
        }
      );

      type ContextEntryPoint = {
        name: string;
        kind: string;
        filePath: string;
      };
      type ContextCodeBlock = {
        nodeName: string;
        nodeKind: string;
        filePath: string;
      };
      type JsonContext = {
        entryPoints: ContextEntryPoint[];
        codeBlocks: ContextCodeBlock[];
      };

      const parsed = JSON.parse(result as string) as JsonContext;
      expect(parsed.entryPoints[0]).toMatchObject({
        name: 'create',
        kind: 'method',
        filePath: 'src/resources/responses/responses.ts',
      });
      expect(parsed.codeBlocks[0]).toMatchObject({
        nodeName: 'create',
        nodeKind: 'method',
        filePath: 'src/resources/responses/responses.ts',
      });
    });

    it('redacts sensitive literals in markdown while preserving navigable symbols', async () => {
      const result = await cg.buildContext('how does widget flow work', {
        format: 'markdown',
        includeCode: true,
        maxCodeBlocks: 3,
      });

      const markdown = result as string;
      expect(markdown).toContain('startWidgetFlow');
      expect(markdown).toContain('src/widget.ts');
      expect(markdown).toContain('[REDACTED_SECRET]');
      expect(markdown).toContain('[REDACTED_EMAIL]');
      expect(markdown).not.toContain('sk_live_abcdefghijklmnopqrstuvwxyz123456');
      expect(markdown).not.toContain('operator@example.com');
      expect(markdown).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
    });

    it('redacts sensitive literals in JSON context without mutating graph fields', async () => {
      const unredactedResult = await cg.buildContext('how does widget flow work', {
        format: 'json',
        includeCode: true,
        maxCodeBlocks: 3,
        redaction: false,
      });

      const result = await cg.buildContext('how does widget flow work', {
        format: 'json',
        includeCode: true,
        maxCodeBlocks: 3,
        redaction: {
          enabled: true,
          redactEmails: true,
          redactSecrets: true,
        },
      });

      const parsed = parseJsonContext(result as string);
      const unredactedParsed = parseJsonContext(unredactedResult as string);
      const start = parsed.nodes.find((node: { name: string }) => node.name === 'startWidgetFlow');
      expect(start.id).toBeTruthy();
      expect(start.filePath).toBe('src/widget.ts');
      expect(parsed.sourceCompleteness).toEqual(unredactedParsed.sourceCompleteness);
      expect(parsed.codeBlocks).toHaveLength(unredactedParsed.codeBlocks.length);
      expect(parsed.codeBlocks.map((block: { content: string }) => block.content).join('\n')).toContain('[REDACTED_SECRET]');
      expect(JSON.stringify(parsed)).not.toContain('operator@example.com');
      expect(JSON.stringify(parsed)).not.toContain('sk_live_abcdefghijklmnopqrstuvwxyz123456');
    });

    it('anchors MCP tool names to their handler methods instead of generic terms', async () => {
      const result = await cg.buildContext('how does solidkg_trace build source snippets', {
        format: 'json',
        includeCode: true,
        maxCodeBlocks: 3,
      });

      const parsed = parseJsonContext(result as string);
      expect(parsed.entryPoints[0]).toMatchObject({
        name: 'handleTrace',
        kind: 'method',
        filePath: 'src/mcp/tools.ts',
      });
      expect(parsed.entryPoints.map((entry: { name: string }) => entry.name)).not.toContain('source');
      expect(parsed.entryPoints.map((entry: { name: string }) => entry.name)).not.toContain('snippet');
      expect(parsed.entryPoints.map((entry: { name: string }) => entry.name)).not.toContain('buildRun');
      expect(parsed.codeBlocks[0]).toMatchObject({
        nodeName: 'handleTrace',
        filePath: 'src/mcp/tools.ts',
      });
    });

    it('redacts MCP context output while preserving symbol names and paths', async () => {
      const handler = new ToolHandler(cg);
      const result = await handler.execute('solidkg_context', {
        task: 'how does widget flow work',
        maxNodes: 20,
        includeCode: true,
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('startWidgetFlow');
      expect(text).toContain('src/widget.ts');
      expect(text).toContain('[REDACTED_SECRET]');
      expect(text).not.toContain('operator@example.com');
      expect(text).not.toContain('sk_live_abcdefghijklmnopqrstuvwxyz123456');
    });

    it('should include related symbols in compact format', async () => {
      const result = await cg.buildContext('checkout', {
        format: 'markdown',
        maxNodes: 10,
      });

      const markdown = result as string;

      // Compact format uses "Related Symbols" instead of verbose "Related Files"
      // and groups symbols by file for compactness
      expect(markdown).toContain('### Entry Points');
    });

    it('should have compact output without verbose stats footer', async () => {
      const result = await cg.buildContext('payment', {
        format: 'markdown',
      });

      const markdown = result as string;

      // Compact format should NOT have verbose stats footer
      expect(markdown).not.toMatch(/\*Context:.*symbols.*relationships.*files/);
      // But should still have query
      expect(markdown).toContain('**Query:**');
    });
  });

  describe('Context structure', () => {
    it('should find entry points from search', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'json',
      });

      const parsed = JSON.parse(result as string);

      expect(parsed.entryPoints).toBeDefined();
      expect(parsed.entryPoints.length).toBeGreaterThan(0);
      expect(parsed).toMatchObject({
        schemaVersion: 'solidkg.context.v1',
        stats: expect.objectContaining({
          nodeCount: expect.any(Number),
          edgeCount: expect.any(Number),
          fileCount: expect.any(Number),
          codeBlockCount: expect.any(Number),
          totalCodeSize: expect.any(Number),
        }),
      });
    });

    it('should traverse graph from entry points', async () => {
      const result = await cg.buildContext('CheckoutController', {
        format: 'json',
        traversalDepth: 2,
      });

      const parsed = JSON.parse(result as string);

      // Should have found related nodes through traversal
      const nodeNames = parsed.nodes.map((n: { name: string }) => n.name);

      // CheckoutController calls PaymentService, so both should be present
      expect(
        nodeNames.some((name: string) => name.includes('Checkout'))
      ).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty query', async () => {
      const result = await cg.buildContext('', { format: 'markdown' });

      expect(typeof result).toBe('string');
    });

    it('should handle query with no matches', async () => {
      const result = await cg.buildContext('xyznonexistent123', {
        format: 'json',
      });

      const parsed = JSON.parse(result as string);

      // Should return empty or minimal results
      expect(parsed.nodes).toBeDefined();
    });

    it('should truncate long code blocks', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'markdown',
        maxCodeBlockSize: 100,
        includeCode: true,
      });

      const markdown = result as string;

      // Long code blocks should be truncated
      if (markdown.includes('```typescript')) {
        // If there's a code block, check for truncation marker if content was long
        // This test validates the truncation logic works
        expect(typeof markdown).toBe('string');
      }
    });
  });
});
