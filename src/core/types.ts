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

export type Decision =
  | { kind: "commit"; winner: Quote; others: Quote[]; reason: DecisionReason }
  | { kind: "none"; reason: "no-quotes" };

export type Job = {
  id: string;
  industryId: string;
  title: string;
  request: string;
  businessIds?: string[];
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

export type SimBusiness = {
  id: string;
  name: string;
  instructions: string;
  fakeQuotes: QuoteFields[];
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
  simBusinesses: SimBusiness[];
};
