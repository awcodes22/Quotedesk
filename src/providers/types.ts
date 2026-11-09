import type { ReportResult } from "../core/headAgent";
import type {
  CallInstruction,
  CallOutcome,
  CallStatus,
  IndustryConfig,
  Job,
  SimBusiness,
  TranscriptLine,
} from "../core/types";

// A provider that replays a finished call can say when each line was spoken.
export type SpokenLine = Omit<TranscriptLine, "at"> & { at?: number };

export type CallContext = {
  runId: string;
  callId: string;
  job: Job;
  industry: IndustryConfig;
  business: SimBusiness;
  reportQuote: (raw: unknown) => ReportResult;
  reportNote: (text: string) => void;
  onStatus: (status: CallStatus) => void;
  onTranscript: (line: SpokenLine) => void;
};

export type CallHandle = {
  done: Promise<CallOutcome>;
  send: (instruction: CallInstruction) => boolean;
};

export type CallProvider = {
  name: string;
  startCall: (context: CallContext) => CallHandle;
  // Set when the calls only gather quotes, so the decision is a recommendation and nobody books.
  recommendsOnly?: boolean;
};
