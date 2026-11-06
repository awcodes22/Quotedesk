import type { z } from "zod";
import type {
  Decision,
  DecisionReason,
  IndustryConfig,
  Quote,
  QuoteFields,
} from "./types";

export type HeadAgentOptions = {
  windowMs: number;
  timeoutMs: number;
  graceMs: number;
};

export type ReportResult =
  | { ok: true; quote: Quote }
  | { ok: false; error: string };

type Timer = ReturnType<typeof setTimeout>;

function compareQuotes(a: Quote, b: Quote, industry: IndustryConfig): number {
  if (a.total !== b.total) {
    return a.total - b.total;
  }

  if (industry.tieBreak !== undefined) {
    const tieBreakResult = industry.tieBreak(a, b);

    if (tieBreakResult !== 0) {
      return tieBreakResult;
    }
  }

  return a.receivedAt - b.receivedAt;
}

export function rankQuotes(quotes: Quote[], industry: IndustryConfig): Quote[] {
  const rankedQuotes = [...quotes];
  rankedQuotes.sort((a, b) => compareQuotes(a, b, industry));
  return rankedQuotes;
}

export function decide(
  quotes: Quote[],
  industry: IndustryConfig,
  reason: DecisionReason,
): Decision {
  const [winner, ...others] = rankQuotes(quotes, industry);

  if (winner === undefined) {
    return { kind: "none", reason: "no-quotes" };
  }

  return { kind: "commit", winner, others, reason };
}

function formatIssue(issue: z.core.$ZodIssue): string {
  if (issue.path.length === 0) {
    return issue.message;
  }

  const fieldPath = issue.path.join(".");
  return `${fieldPath}: ${issue.message}`;
}

function formatValidationError(error: z.ZodError): string {
  const issueMessages = error.issues.map(formatIssue);
  return issueMessages.join("; ");
}

function createQuote(
  callId: string,
  businessId: string,
  fields: QuoteFields,
): Quote {
  return {
    callId,
    businessId,
    total: fields.total,
    fields,
    receivedAt: Date.now(),
  };
}

export class HeadAgent {
  private readonly industry: IndustryConfig;
  private readonly expectedCalls: number;
  private readonly options: HeadAgentOptions;
  private readonly onDecision: (decision: Decision) => void;

  private readonly quotesByCall = new Map<string, Quote>();
  private readonly settledCalls = new Set<string>();

  private decision: Decision | undefined = undefined;
  private timeoutTimer: Timer | undefined = undefined;
  private windowTimer: Timer | undefined = undefined;
  private graceTimer: Timer | undefined = undefined;

  constructor(
    industry: IndustryConfig,
    expectedCalls: number,
    options: HeadAgentOptions,
    onDecision: (decision: Decision) => void,
  ) {
    this.industry = industry;
    this.expectedCalls = expectedCalls;
    this.options = options;
    this.onDecision = onDecision;
  }

  get result(): Decision | undefined {
    return this.decision;
  }

  start(): void {
    const alreadyStarted = this.timeoutTimer !== undefined;

    if (this.decision !== undefined || alreadyStarted) {
      return;
    }

    this.timeoutTimer = setTimeout(() => {
      this.finish("timeout");
    }, this.options.timeoutMs);
  }

  report(callId: string, businessId: string, raw: unknown): ReportResult {
    if (this.decision !== undefined) {
      return { ok: false, error: "A decision was already made." };
    }

    const parsed = this.industry.quoteSchema.safeParse(raw);

    if (parsed.success === false) {
      return { ok: false, error: formatValidationError(parsed.error) };
    }

    const quote = createQuote(callId, businessId, parsed.data);
    this.recordQuote(quote);
    return { ok: true, quote };
  }

  callEnded(callId: string): void {
    if (this.decision !== undefined) {
      return;
    }

    this.settledCalls.add(callId);

    // Only a new quote restarts a running grace period, not a hang-up.
    const graceIsRunning = this.graceTimer !== undefined;

    if (this.allCallsSettled() && graceIsRunning === false) {
      this.restartGracePeriod();
    }
  }

  private recordQuote(quote: Quote): void {
    this.quotesByCall.set(quote.callId, quote);
    this.settledCalls.add(quote.callId);
    this.startWindowIfFirstQuote();

    if (this.allCallsSettled()) {
      this.restartGracePeriod();
    }
  }

  private startWindowIfFirstQuote(): void {
    if (this.windowTimer !== undefined) {
      return;
    }

    this.windowTimer = setTimeout(() => {
      this.finish("window");
    }, this.options.windowMs);
  }

  private allCallsSettled(): boolean {
    return this.settledCalls.size >= this.expectedCalls;
  }

  // The window and timeout keep running, so new quotes can't extend grace past them.
  private restartGracePeriod(): void {
    clearTimeout(this.graceTimer);

    if (this.options.graceMs === 0) {
      this.finish("all-settled");
      return;
    }

    this.graceTimer = setTimeout(() => {
      this.finish("all-settled");
    }, this.options.graceMs);
  }

  private clearTimers(): void {
    clearTimeout(this.timeoutTimer);
    clearTimeout(this.windowTimer);
    clearTimeout(this.graceTimer);
  }

  private finish(reason: DecisionReason): void {
    this.clearTimers();

    const quotes = [...this.quotesByCall.values()];
    const decision = decide(quotes, this.industry, reason);

    this.decision = decision;
    this.onDecision(decision);
  }
}
