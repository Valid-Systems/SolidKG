#!/usr/bin/env node
// Offline fixture artifact for realistic agent-baseline comparisons.
// This intentionally models targeted search/read, diff/read, and SolidKG context arms;
// it does not clone repositories, require network access, or use whole-repo ingestion as a headline.

const prompt = 'How does CheckoutService submitOrder use PaymentGateway chargeCard and ReceiptMailer sendReceipt?';

const fixtureFiles = {
  'src/payments.ts': `export class PaymentGateway {
  chargeCard(customerId: string, cents: number) {
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
  submitOrder(customerId: string, cents: number): string {
    const charge = new PaymentGateway().chargeCard(customerId, cents);
    return new ReceiptMailer().sendReceipt(customerId, charge.authorizationId);
  }
}
`,
};

function estimateCharsAsTokens(chars) {
  return Math.ceil(chars / 4);
}

function estimateOutput(output) {
  return estimateCharsAsTokens(prompt.length + output.length);
}

const rgFiles = Object.keys(fixtureFiles).sort();
const rgOutput = rgFiles.map((file) => `### ${file}\n${fixtureFiles[file]}`).join('\n');
const diffFiles = ['src/checkout.ts', 'src/payments.ts', 'src/notifications.ts'];
const diffText = `diff --git a/src/checkout.ts b/src/checkout.ts
@@
-    return 'queued';
+    const charge = new PaymentGateway().chargeCard(customerId, cents);
+    return new ReceiptMailer().sendReceipt(customerId, charge.authorizationId);
`;
const contextOutput = `SolidKG context for CheckoutService includes PaymentGateway.chargeCard and ReceiptMailer.sendReceipt with the related files and symbols surfaced from the local index.`;

const report = {
  schemaName: 'solidkg.realistic-agent-baselines.v1',
  fixture: 'tiny-checkout-flow-offline-artifact',
  prompt,
  arms: [
    {
      baselineKind: 'rg_read',
      prompt,
      toolCalls: [
        { tool: 'rg', input: 'CheckoutService|PaymentGateway|ReceiptMailer|chargeCard|sendReceipt' },
        ...rgFiles.map((file) => ({ tool: 'Read', input: file })),
      ],
      filesRead: rgFiles,
      estimatedTokens: estimateOutput(rgOutput),
      success: true,
      notes: ['Targeted search and file reads are the realistic non-SolidKG baseline.'],
    },
    {
      baselineKind: 'diff_read',
      prompt,
      toolCalls: [
        { tool: 'git diff', input: '-- src/checkout.ts src/payments.ts src/notifications.ts' },
        ...diffFiles.map((file) => ({ tool: 'Read', input: file })),
      ],
      filesRead: diffFiles,
      estimatedTokens: estimateOutput(diffText + diffFiles.map((file) => fixtureFiles[file]).join('\n')),
      success: true,
      notes: ['Changed-file and diff-first review is a realistic modern-agent workflow.'],
    },
    {
      baselineKind: 'solidkg_context',
      prompt,
      toolCalls: [{ tool: 'solidkg_context', input: prompt }],
      filesRead: [],
      estimatedTokens: estimateOutput(contextOutput),
      success: true,
      notes: ['The Vitest harness exercises the real ToolHandler on the matching tiny fixture.'],
    },
  ],
  rejectedBaselines: [
    {
      baselineKind: 'whole_repo_read',
      status: 'rejected_unfair_antipattern',
      reason: 'Reading every source file is an unfair anti-pattern for modern agents that can use search, LSP, diffs, and targeted reads.',
    },
  ],
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
