import { EventEmitter } from "node:events";
import type {
  CallCommand,
  CallStatus,
  Decision,
  DecisionDeadline,
  Job,
  PriceCheck,
  Quote,
  RunReport,
  TranscriptLine,
} from "./types";

type RunEvent = {
  runId: string;
  at: number;
};

type CallEvent = RunEvent & {
  callId: string;
  businessId: string;
};

export type AgentEvent =
  | (RunEvent & {
      type: "run_started";
      job: Job;
      industryLabel: string;
      provider: string;
      businesses: { id: string; name: string }[];
    })
  | (CallEvent & { type: "call_status"; status: CallStatus })
  | (CallEvent & { type: "transcript"; line: TranscriptLine })
  | (CallEvent & { type: "quote"; quote: Quote })
  | (CallEvent & { type: "note"; text: string })
  | (RunEvent & DecisionDeadline & { type: "decision_scheduled" })
  | (RunEvent & { type: "decision"; decision: Decision })
  | (CallEvent & {
      type: "decision_pushed";
      command: CallCommand;
      delivered: boolean;
    })
  | (RunEvent & { type: "price_check"; check: PriceCheck })
  | (RunEvent & { type: "run_finished"; report: RunReport })
  | {
      type: "alert";
      runId?: string;
      at: number;
      callId?: string;
      level: "info" | "warn" | "error";
      code: string;
      message: string;
    };

export type EventListener = (event: AgentEvent) => void;

const EVENT_CHANNEL = "agent-event";
const MAX_LISTENERS = 50;

const bus = new EventEmitter<{ [EVENT_CHANNEL]: [AgentEvent] }>();
bus.setMaxListeners(MAX_LISTENERS);

function runListenerSafely(listener: EventListener, event: AgentEvent): void {
  try {
    listener(event);
  } catch (error) {
    console.error(`Event listener failed on "${event.type}":`, error);
  }
}

export function emit(event: AgentEvent): void {
  bus.emit(EVENT_CHANNEL, event);
}

export function onEvent(listener: EventListener): () => void {
  // EventEmitter stops at the first listener that throws, so each one is guarded here.
  function guardedListener(event: AgentEvent): void {
    runListenerSafely(listener, event);
  }

  function unsubscribe(): void {
    bus.off(EVENT_CHANNEL, guardedListener);
  }

  bus.on(EVENT_CHANNEL, guardedListener);
  return unsubscribe;
}
