import pLimit from "p-limit";
import type {
  CallContext,
  CallHandle,
  CallProvider,
} from "../providers/types";
import { emit } from "./events";
import { DECISION_MADE_ERROR, HeadAgent } from "./headAgent";
import type { ReportResult } from "./headAgent";
import { runPriceCheck } from "./priceCheck";
import type {
  CallCommand,
  CallOutcome,
  CallStatus,
  Decision,
  DecisionDeadline,
  IndustryConfig,
  Job,
  PriceCheck,
  Quote,
  RunReport,
  SimBusiness,
  TranscriptLine,
} from "./types";

export type RunOptions = {
  maxParallelCalls: number;
  decisionWindowMs: number;
  runTimeoutMs: number;
  settleGraceMs: number;
  priceFlagPct: number;
};

type LiveCall = {
  businessId: string;
  handle: CallHandle;
};

type LiveCalls = Map<string, LiveCall>;

type ActiveRun = {
  runId: string;
  job: Job;
  industry: IndustryConfig;
  provider: CallProvider;
  agent: HeadAgent;
  liveCalls: LiveCalls;
};

type DecisionSignal = {
  promise: Promise<Decision>;
  resolve: (decision: Decision) => void;
};

let runInProgress = false;

export function isRunning(): boolean {
  return runInProgress;
}

function createRunId(startedAt: number): string {
  const timestamp = new Date(startedAt).toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return `run-${safeTimestamp}`;
}

function createCallId(businessId: string): string {
  return `call-${businessId}`;
}

function findBusiness(
  industry: IndustryConfig,
  businessId: string,
): SimBusiness {
  const business = industry.simBusinesses.find(
    (candidate) => candidate.id === businessId,
  );

  if (business === undefined) {
    throw new Error(
      `Unknown business "${businessId}" in industry "${industry.id}".`,
    );
  }

  return business;
}

function pickBusinesses(job: Job, industry: IndustryConfig): SimBusiness[] {
  let businesses = industry.simBusinesses;

  if (job.businessIds !== undefined && job.businessIds.length > 0) {
    const uniqueIds = [...new Set(job.businessIds)];
    businesses = uniqueIds.map((id) => findBusiness(industry, id));
  }

  if (businesses.length === 0) {
    throw new Error(`Job "${job.id}" has no businesses to call.`);
  }

  return businesses;
}

function emitCallStatus(
  runId: string,
  callId: string,
  businessId: string,
  status: CallStatus,
): void {
  emit({ type: "call_status", runId, at: Date.now(), callId, businessId, status });
}

function emitDecisionPushed(
  runId: string,
  callId: string,
  businessId: string,
  command: CallCommand,
  delivered: boolean,
): void {
  emit({
    type: "decision_pushed",
    runId,
    at: Date.now(),
    callId,
    businessId,
    command,
    delivered,
  });
}

function emitWinnerGone(runId: string, winner: Quote): void {
  emit({
    type: "alert",
    runId,
    at: Date.now(),
    callId: winner.callId,
    level: "error",
    code: "WINNER_GONE",
    message: `The commit could not reach ${winner.businessId}.`,
  });
}

function pushCommit(runId: string, winner: Quote, liveCalls: LiveCalls): void {
  const winnerCall = liveCalls.get(winner.callId);
  let delivered = false;

  if (winnerCall !== undefined) {
    delivered = winnerCall.handle.send({ command: "commit", quote: winner });
  }

  emitDecisionPushed(
    runId,
    winner.callId,
    winner.businessId,
    "commit",
    delivered,
  );

  if (delivered === false) {
    emitWinnerGone(runId, winner);
  }
}

function pushClose(
  runId: string,
  liveCalls: LiveCalls,
  winnerCallId: string | undefined,
): void {
  for (const [callId, call] of liveCalls) {
    if (callId !== winnerCallId) {
      const delivered = call.handle.send({ command: "close" });
      emitDecisionPushed(runId, callId, call.businessId, "close", delivered);
    }
  }
}

function pushDecision(
  runId: string,
  decision: Decision,
  liveCalls: LiveCalls,
): void {
  emit({ type: "decision", runId, at: Date.now(), decision });

  let winnerCallId: string | undefined = undefined;

  if (decision.kind === "commit") {
    winnerCallId = decision.winner.callId;
    pushCommit(runId, decision.winner, liveCalls);
  }

  pushClose(runId, liveCalls, winnerCallId);
}

function createDecisionSignal(): DecisionSignal {
  let resolve: (decision: Decision) => void = () => {};

  const promise = new Promise<Decision>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function createHeadAgent(
  runId: string,
  industry: IndustryConfig,
  expectedCalls: number,
  options: RunOptions,
  liveCalls: LiveCalls,
  decisionPushed: DecisionSignal,
): HeadAgent {
  // With no grace period the agent decides inside report(), so the push waits
  // a tick to keep the winning quote's own event ahead of the decision.
  function handleDecision(decision: Decision): void {
    queueMicrotask(() => {
      pushDecision(runId, decision, liveCalls);
      decisionPushed.resolve(decision);
    });
  }

  function announceDeadline(deadline: DecisionDeadline): void {
    emit({ type: "decision_scheduled", runId, at: Date.now(), ...deadline });
  }

  const agentOptions = {
    windowMs: options.decisionWindowMs,
    timeoutMs: options.runTimeoutMs,
    graceMs: options.settleGraceMs,
  };

  return new HeadAgent(
    industry,
    expectedCalls,
    agentOptions,
    handleDecision,
    announceDeadline,
  );
}

function emitRejectedQuote(
  runId: string,
  callId: string,
  businessId: string,
  error: string,
): void {
  let level: "info" | "warn" = "warn";
  let code = "BAD_QUOTE";

  // Callers keep talking until the decision reaches them, so a late quote is normal.
  if (error === DECISION_MADE_ERROR) {
    level = "info";
    code = "LATE_QUOTE";
  }

  emit({
    type: "alert",
    runId,
    at: Date.now(),
    callId,
    level,
    code,
    message: `Quote from ${businessId} rejected: ${error}`,
  });
}

function handleQuote(
  run: ActiveRun,
  callId: string,
  businessId: string,
  raw: unknown,
): ReportResult {
  const { runId } = run;
  const result = run.agent.report(callId, businessId, raw);

  if (result.ok) {
    const quote = result.quote;
    emit({ type: "quote", runId, at: Date.now(), callId, businessId, quote });
  } else {
    emitRejectedQuote(runId, callId, businessId, result.error);
  }

  return result;
}

function createCallContext(
  run: ActiveRun,
  callId: string,
  business: SimBusiness,
): CallContext {
  const { runId } = run;
  const businessId = business.id;

  function reportNote(text: string): void {
    emit({ type: "note", runId, at: Date.now(), callId, businessId, text });
  }

  function onTranscript(spoken: Omit<TranscriptLine, "at">): void {
    const at = Date.now();
    const line = { ...spoken, at };
    emit({ type: "transcript", runId, at, callId, businessId, line });
  }

  return {
    callId,
    job: run.job,
    industry: run.industry,
    business,
    reportQuote: (raw) => handleQuote(run, callId, businessId, raw),
    reportNote,
    onStatus: (status) => emitCallStatus(runId, callId, businessId, status),
    onTranscript,
  };
}

function buildEmptyOutcome(
  callId: string,
  businessId: string,
  status: CallOutcome["status"],
): CallOutcome {
  return { callId, businessId, status, transcript: [], notes: [] };
}

function skipCall(
  run: ActiveRun,
  callId: string,
  businessId: string,
): CallOutcome {
  emitCallStatus(run.runId, callId, businessId, "skipped");
  run.agent.callEnded(callId);
  return buildEmptyOutcome(callId, businessId, "skipped");
}

async function followCall(
  run: ActiveRun,
  callId: string,
  business: SimBusiness,
): Promise<CallOutcome> {
  const context = createCallContext(run, callId, business);
  const handle = run.provider.startCall(context);

  run.liveCalls.set(callId, { businessId: business.id, handle });
  return handle.done;
}

function buildCrashedOutcome(
  run: ActiveRun,
  callId: string,
  businessId: string,
  error: unknown,
): CallOutcome {
  emitCallStatus(run.runId, callId, businessId, "failed");

  const outcome = buildEmptyOutcome(callId, businessId, "failed");
  outcome.error = String(error);
  return outcome;
}

async function placeCall(
  run: ActiveRun,
  callId: string,
  business: SimBusiness,
): Promise<CallOutcome> {
  let outcome: CallOutcome;

  // One provider crash must not take the other live calls down with it.
  try {
    outcome = await followCall(run, callId, business);
  } catch (error) {
    outcome = buildCrashedOutcome(run, callId, business.id, error);
  }

  run.liveCalls.delete(callId);
  run.agent.callEnded(callId);
  return outcome;
}

async function takeCallTurn(
  run: ActiveRun,
  business: SimBusiness,
): Promise<CallOutcome> {
  const callId = createCallId(business.id);

  if (run.agent.result !== undefined) {
    return skipCall(run, callId, business.id);
  }

  return placeCall(run, callId, business);
}

function queueCalls(
  run: ActiveRun,
  businesses: SimBusiness[],
  maxParallelCalls: number,
): Promise<CallOutcome[]> {
  for (const business of businesses) {
    const callId = createCallId(business.id);
    emitCallStatus(run.runId, callId, business.id, "queued");
  }

  const limit = pLimit(maxParallelCalls);
  const turns = businesses.map((business) =>
    limit(() => takeCallTurn(run, business)),
  );

  return Promise.all(turns);
}

function emitRunStarted(
  runId: string,
  job: Job,
  industry: IndustryConfig,
  provider: CallProvider,
  businesses: SimBusiness[],
): void {
  const businessSummaries = businesses.map((business) => {
    return { id: business.id, name: business.name };
  });

  emit({
    type: "run_started",
    runId,
    at: Date.now(),
    job,
    industryLabel: industry.label,
    provider: provider.name,
    businesses: businessSummaries,
  });
}

function checkWinningPrice(
  runId: string,
  job: Job,
  industry: IndustryConfig,
  decision: Decision,
  priceFlagPct: number,
): PriceCheck | undefined {
  if (decision.kind === "none") {
    return undefined;
  }

  const check = runPriceCheck(
    decision.winner,
    job.reference,
    industry,
    priceFlagPct,
  );

  if (check !== undefined) {
    emit({ type: "price_check", runId, at: Date.now(), check });
  }

  return check;
}

async function executeRun(
  job: Job,
  industry: IndustryConfig,
  provider: CallProvider,
  businesses: SimBusiness[],
  options: RunOptions,
): Promise<RunReport> {
  const startedAt = Date.now();
  const runId = createRunId(startedAt);
  const liveCalls: LiveCalls = new Map();
  const decisionPushed = createDecisionSignal();

  emitRunStarted(runId, job, industry, provider, businesses);

  const agent = createHeadAgent(
    runId,
    industry,
    businesses.length,
    options,
    liveCalls,
    decisionPushed,
  );
  const run = { runId, job, industry, provider, agent, liveCalls };

  agent.start();

  const callsFinished = queueCalls(run, businesses, options.maxParallelCalls);

  // Calls can all end while grace is still running, so the decision is awaited too.
  const [decision, calls] = await Promise.all([
    decisionPushed.promise,
    callsFinished,
  ]);

  const priceCheck = checkWinningPrice(
    runId,
    job,
    industry,
    decision,
    options.priceFlagPct,
  );

  const report: RunReport = {
    runId,
    job,
    provider: provider.name,
    startedAt,
    endedAt: Date.now(),
    decision,
    calls,
  };

  if (priceCheck !== undefined) {
    report.priceCheck = priceCheck;
  }

  emit({ type: "run_finished", runId, at: report.endedAt, report });
  return report;
}

export async function runJob(
  job: Job,
  industry: IndustryConfig,
  provider: CallProvider,
  options: RunOptions,
): Promise<RunReport> {
  if (runInProgress) {
    throw new Error("A run is already in progress.");
  }

  const businesses = pickBusinesses(job, industry);
  runInProgress = true;

  try {
    return await executeRun(job, industry, provider, businesses, options);
  } finally {
    runInProgress = false;
  }
}
