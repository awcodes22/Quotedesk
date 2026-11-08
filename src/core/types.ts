import type { z } from "zod";

export type QuoteFields = { total: number } & Record<string, unknown>;

export type Quote = {
  callId: string;
  businessId: string;
  total: number;
  fields: QuoteFields;
  receivedAt: number;
};

export type DecisionReason = "all-settled" | "window" | "timeout";

export type DecisionDeadline = {
  deadlineAt: number;
  reason: DecisionReason;
};

export type Decision =
  | { kind: "commit"; winner: Quote; others: Quote[]; reason: DecisionReason }
  | { kind: "none"; reason: "no-quotes" };

export type ReferencePrices = {
  total?: number;
  lines?: Record<string, number>;
  source?: string;
};

export type Contact = {
  name: string;
  email: string;
};

export type Job = {
  id: string;
  industryId: string;
  title: string;
  request: string;
  businessIds?: string[];
  reference?: ReferencePrices;
  contact?: Contact;
};

export type PriceCheckRow = {
  item: string;
  reference: number;
  quoted: number;
  diffPct: number;
  flagged: boolean;
};

export type PriceCheck = {
  businessId: string;
  thresholdPct: number;
  rows: PriceCheckRow[];
  flaggedCount: number;
  source?: string;
};

export type CallStatus =
  | "queued"
  | "connecting"
  | "talking"
  | "quoted"
  | "committed"
  | "closed"
  | "ended"
  | "failed"
  | "skipped";

export type TranscriptLine = {
  speaker: "agent" | "business";
  text: string;
  at: number;
};

export type CallCommand = "commit" | "close";

export type CallInstruction =
  | { command: "commit"; quote: Quote }
  | { command: "close" };

export type CallOutcome = {
  callId: string;
  businessId: string;
  status: "completed" | "failed" | "skipped";
  command?: CallCommand;
  transcript: TranscriptLine[];
  notes: string[];
  error?: string;
};

export type RunReport = {
  runId: string;
  job: Job;
  provider: string;
  startedAt: number;
  endedAt: number;
  decision: Decision;
  calls: CallOutcome[];
  priceCheck?: PriceCheck;
};

export type SimBusiness = {
  id: string;
  name: string;
  instructions: string;
  fakeQuotes: QuoteFields[];
};

export type FieldLabel = {
  yes: string;
  no: string;
};

export type IndustryConfig = {
  id: string;
  label: string;
  clientNoun: string;
  goal: string;
  quoteSchema: z.ZodType<QuoteFields>;
  followUps: string[];
  commitInstruction: string;
  tieBreak?: (a: Quote, b: Quote) => number;
  linePrices?: (fields: QuoteFields) => Record<string, number>;
  fieldLabels?: Record<string, FieldLabel>;
  simBusinesses: SimBusiness[];
};
