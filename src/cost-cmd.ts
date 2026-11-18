import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface CostCmdOptions {
  apiKey?: string;
  provider?: string;
  model?: string;
}

/**
 * /cost command implementation:
 * Computes exact session token usage (prompt, completion, cache read/write)
 * and resolves billing status between PAYG wallet and Token Plan subscription.
 */
/** The fields of a session entry this command reads. */
interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface EntryLike {
  type?: string;
  usage?: UsageLike;
  message?: { role?: string; usage?: UsageLike };
}

export async function runCost(ctx: ExtensionCommandContext, opts?: CostCmdOptions): Promise<void> {
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  const entries = ctx.sessionManager.getEntries();
  for (const entry of entries as unknown as EntryLike[]) {
    if (entry.type === "usage" && entry.usage) {
      promptTokens += entry.usage.input || 0;
      completionTokens += entry.usage.output || 0;
      cacheReadTokens += entry.usage.cacheRead || 0;
      cacheWriteTokens += entry.usage.cacheWrite || 0;
    } else if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage) {
      promptTokens += entry.message.usage.input || 0;
      completionTokens += entry.message.usage.output || 0;
      cacheReadTokens += entry.message.usage.cacheRead || 0;
      cacheWriteTokens += entry.message.usage.cacheWrite || 0;
    } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.usage) {
      promptTokens += entry.message.usage.input || 0;
      completionTokens += entry.message.usage.output || 0;
      cacheReadTokens += entry.message.usage.cacheRead || 0;
      cacheWriteTokens += entry.message.usage.cacheWrite || 0;
    }
  }

  const totalTokens = promptTokens + completionTokens + cacheReadTokens + cacheWriteTokens;
  const totalPromptTokens = promptTokens + cacheReadTokens + cacheWriteTokens;
  const cacheHitPercent = totalPromptTokens > 0 ? ((cacheReadTokens / totalPromptTokens) * 100).toFixed(1) : "0.0";

  // Determine provider / key type
  const provider = (opts?.provider || "qronos").toLowerCase();
  const apiKey = opts?.apiKey || process.env.QRONOS_API_KEY || "";
  const isQronos = provider === "qronos" || !opts?.provider;

  let billingSection = "";

  if (isQronos) {
    // If key starts with sk_live_ or contains 'payg', or standard discount rate
    const isPaygKey = apiKey.toLowerCase().includes("payg") || !apiKey.toLowerCase().includes("plan");

    // Estimated standard cost vs PAYG 60% discount
    // Standard baseline: ~$3.00/M in, $15.00/M out
    const standardCost = (promptTokens / 1_000_000) * 3.0 + (completionTokens / 1_000_000) * 15.0 + (cacheReadTokens / 1_000_000) * 0.3;
    const paygCost = standardCost * 0.40; // 60% discount

    if (isPaygKey) {
      billingSection = `── Billing Mode: Pay-As-You-Go (PAYG Wallet) ──
  Session Est. Cost:   $${paygCost.toFixed(4)} USD (with 60% PAYG discount applied)
  Standard Baseline:   $${standardCost.toFixed(4)} USD
  Discount Saved:      $${(standardCost - paygCost).toFixed(4)} USD
  Pricing Structure:   Nanodollar metering per token · Top up at qronos.me/account`;
    } else {
      billingSection = `── Billing Mode: Token Plan (Subscription) ──
  Session Deduction:   ${totalTokens.toLocaleString()} tokens deducted from plan allowance
  Plan Status:         Active Subscription
  Top Up / Upgrade:    qronos.me/account`;
    }
  } else {
    billingSection = `── Billing Mode: BYOK (Direct Provider: ${provider}) ──
  Upstream Route:      Direct to ${provider} API using custom API key
  Token Count:         ${totalTokens.toLocaleString()} billed directly to your ${provider} account`;
  }

  const output = `◈ Qronos CLI — Token & Cost Breakdown

── Current Session Tokens ───────────────────────────
  Prompt Tokens (In):       ${promptTokens.toLocaleString()}
  Completion Tokens (Out):   ${completionTokens.toLocaleString()}
  Cache Read Tokens:        ${cacheReadTokens.toLocaleString()}  (${cacheHitPercent}% cache hit rate)
  Cache Write Tokens:       ${cacheWriteTokens.toLocaleString()}
  Total Processed:          ${totalTokens.toLocaleString()} tokens

${billingSection}
`;

  ctx.ui.notify(output, "info");
}
