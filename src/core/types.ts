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

export type IndustryConfig = {
  id: string;
  label: string;
  quoteSchema: z.ZodType<QuoteFields>;
  tieBreak?: (a: Quote, b: Quote) => number;
};
