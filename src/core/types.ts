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

// Short facts for the dashboard header, such as the dates.
export type JobDetail = {
  label: string;
  value: string;
  icon?: string;
};

// Dates are ISO days, such as 2026-11-20, and get turned into speech before a live call.
export type Stay = {
  checkIn: string;
  checkOut: string;
  beds: string;
};

export type LiveBusiness = {
  name: string;
  phone: string;
};

export type Job = {
  id: string;
  industryId: string;
  title: string;
  request: string;
  businessIds?: string[];
  reference?: ReferencePrices;
  contact?: Contact;
  details?: JobDetail[];
  // Where to look for hotels, such as "downtown Toronto". Prefills the hotel search.
  location?: string;
  stay?: Stay;
  liveBusinesses?: LiveBusiness[];
  // Set by the server for live runs from LIVE_GUEST_NAME, the name the caller gives.
  guestName?: string;
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
  phone?: string;
  // Set only for a number typed in on the dashboard for one test call.
  selfTest?: boolean;
  // Picked on the dashboard for this run, so it skips LIVE_ALLOWED_NUMBERS.
  approvedForRun?: boolean;
  // A hotel found through Google Places. Its listing is public and is shown in full.
  publicListing?: PublicListing;
};

// A business's public listing, as Google Places shows it to anyone. Not private, so never masked.
export type PublicListing = {
  placeId: string;
  address: string;
  phone: string;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: string | null;
  website: string | null;
  tollFree: boolean;
};

export type FieldLabel = {
  yes: string;
  no: string;
};

// How the dashboard names the businesses it calls, as in "120 hotels".
export type BusinessNoun = {
  singular: string;
  plural: string;
};

// What was read out of a live call: the quote fields, if any, and short notes.
export type ExtractedQuote = {
  fields: QuoteFields | null;
  notes: string[];
};

export type IndustryConfig = {
  id: string;
  label: string;
  clientNoun: string;
  businessNoun: BusinessNoun;
  goal: string;
  quoteSchema: z.ZodType<QuoteFields>;
  followUps: string[];
  commitInstruction: string;
  tieBreak?: (a: Quote, b: Quote) => number;
  linePrices?: (fields: QuoteFields) => Record<string, number>;
  fieldLabels?: Record<string, FieldLabel>;
  // Checks a model's reading of a live call against the business's own words.
  reviewExtraction?: (extracted: ExtractedQuote, businessLines: string[]) => ExtractedQuote;
  simBusinesses: SimBusiness[];
};
