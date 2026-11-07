import type { ReportResult } from "../core/headAgent";
import type {
  CallCommand,
  CallOutcome,
  CallStatus,
  IndustryConfig,
  Job,
  SimBusiness,
  TranscriptLine,
} from "../core/types";

export type CallContext = {
  callId: string;
  job: Job;
  industry: IndustryConfig;
  business: SimBusiness;
  reportQuote: (raw: unknown) => ReportResult;
  reportNote: (text: string) => void;
  onStatus: (status: CallStatus) => void;
  onTranscript: (line: Omit<TranscriptLine, "at">) => void;
};

export type CallHandle = {
  done: Promise<CallOutcome>;
  send: (command: CallCommand) => boolean;
};

export type CallProvider = {
  name: string;
  startCall: (context: CallContext) => CallHandle;
};
