import * as fs from 'fs';
import * as path from 'path';
import SolidKG from '../../src/index';
import { estimateCharsAsTokens } from '../../src/context/budget';
import { ToolHandler } from '../../src/mcp/tools';

export type RealisticBaselineKind = 'rg_read' | 'diff_read' | 'solidkg_context';

export interface RealisticBaselineArm {
  baselineKind: RealisticBaselineKind;
  prompt: string;
  toolCalls: Array<{ tool: string; input: string }>;
  filesRead: string[];
  estimatedTokens: number;
  success: boolean;
  notes: string[];
}

export interface RealisticBaselineReport {
  schemaName: 'solidkg.realistic-agent-baselines.v1';
  fixture: string;
  prompt: string;
  arms: RealisticBaselineArm[];
  rejectedBaselines: Array<{ baselineKind: string; status: 'rejected_unfair_antipattern'; reason: string }>;
}

export const realisticBaselinePrompt =
  'How does CheckoutService submitOrder use PaymentGateway chargeCard and ReceiptMailer sendReceipt?';

const fixtureFiles: Record<string, string> = {
  'src/payments.ts': `export interface ChargeResult {
  ok: boolean;
  authorizationId: string;
}

export class PaymentGateway {
  chargeCard(customerId: string, cents: number): ChargeResult {
    if (cents <= 0) throw new Error('amount must be positive');
    return { ok: true, authorizationId: customerId + '-' + cents };
  }
}
`,
  'src/notifications.ts': `export class ReceiptMailer {
  sendReceipt(customerId: string, authorizationId: string): string {
    return 'receipt:' + customerId + ':' + authorizationId;
  }
}
`,
  'src/checkout.ts': `import { PaymentGateway } from './payments';
import { ReceiptMailer } from './notifications';

export class CheckoutService {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly mailer: ReceiptMailer
  ) {}

  submitOrder(customerId: string, cents: number): string {
    const charge = this.gateway.chargeCard(customerId, cents);
    if (!charge.ok) throw new Error('charge failed');
    return this.mailer.sendReceipt(customerId, charge.authorizationId);
  }
}
`,
  'src/inventory.ts': `export class InventoryService {
  reserveSku(sku: string): string {
    return 'reserved:' + sku;
  }
}
`,
};

function writeFixture(root: string): void {
  for (const [relativePath, contents] of Object.entries(fixtureFiles)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
}

function readFixtureFile(root: string, relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function estimatePromptAndOutput(prompt: string, output: string): number {
  return estimateCharsAsTokens(prompt.length + output.length);
}

function containsAllSymbols(text: string): boolean {
  return ['CheckoutService', 'PaymentGateway', 'chargeCard', 'ReceiptMailer', 'sendReceipt'].every((symbol) =>
    text.includes(symbol)
  );
}

function buildRgReadArm(root: string, prompt: string): RealisticBaselineArm {
  const query = 'CheckoutService|PaymentGateway|ReceiptMailer|chargeCard|sendReceipt';
  const filesRead = Object.keys(fixtureFiles)
    .filter((relativePath) => {
      const contents = readFixtureFile(root, relativePath);
      return /CheckoutService|PaymentGateway|ReceiptMailer|chargeCard|sendReceipt/.test(contents);
    })
    .sort();
  const output = filesRead.map((relativePath) => `### ${relativePath}\n${readFixtureFile(root, relativePath)}`).join('\n');

  return {
    baselineKind: 'rg_read',
    prompt,
    toolCalls: [
      { tool: 'rg', input: query },
      ...filesRead.map((relativePath) => ({ tool: 'Read', input: relativePath })),
    ],
    filesRead,
    estimatedTokens: estimatePromptAndOutput(prompt, output),
    success: containsAllSymbols(output),
    notes: ['Models a modern agent using targeted search results followed by file reads, not repository ingestion.'],
  };
}

function buildDiffReadArm(root: string, prompt: string): RealisticBaselineArm {
  const filesRead = ['src/checkout.ts', 'src/payments.ts', 'src/notifications.ts'];
  const diff = `diff --git a/src/checkout.ts b/src/checkout.ts
@@
-    return 'queued';
+    const charge = this.gateway.chargeCard(customerId, cents);
+    return this.mailer.sendReceipt(customerId, charge.authorizationId);
`;
  const output = `${diff}\n${filesRead.map((relativePath) => readFixtureFile(root, relativePath)).join('\n')}`;

  return {
    baselineKind: 'diff_read',
    prompt,
    toolCalls: [
      { tool: 'git diff', input: '-- src/checkout.ts src/payments.ts src/notifications.ts' },
      ...filesRead.map((relativePath) => ({ tool: 'Read', input: relativePath })),
    ],
    filesRead,
    estimatedTokens: estimatePromptAndOutput(prompt, output),
    success: containsAllSymbols(output),
    notes: ['Models a review task where the agent starts from the diff and changed/supporting files.'],
  };
}

async function buildSolidKGContextArm(root: string, prompt: string): Promise<RealisticBaselineArm> {
  const cg = await SolidKG.init(root, { index: true, silent: true });
  try {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('solidkg_context', {
      task: prompt,
      maxNodes: 10,
      includeCode: true,
    });
    const text = result.content?.[0]?.text ?? '';

    return {
      baselineKind: 'solidkg_context',
      prompt,
      toolCalls: [{ tool: 'solidkg_context', input: prompt }],
      filesRead: [],
      estimatedTokens: estimatePromptAndOutput(prompt, text),
      success: containsAllSymbols(text),
      notes: ['Uses the real MCP ToolHandler against the tiny local fixture index.'],
    };
  } finally {
    cg.close();
  }
}

export async function runRealisticBaselineFixture(root: string): Promise<RealisticBaselineReport> {
  writeFixture(root);
  const prompt = realisticBaselinePrompt;
  const arms = [buildRgReadArm(root, prompt), buildDiffReadArm(root, prompt), await buildSolidKGContextArm(root, prompt)];

  return {
    schemaName: 'solidkg.realistic-agent-baselines.v1',
    fixture: 'tiny-checkout-flow',
    prompt,
    arms,
    rejectedBaselines: [
      {
        baselineKind: 'whole_repo_read',
        status: 'rejected_unfair_antipattern',
        reason: 'Reading every source file is not representative of modern agents that use search, LSP, diffs, and targeted reads.',
      },
    ],
  };
}
