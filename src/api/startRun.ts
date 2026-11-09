import { onEvent } from "../core/events";
import type { AgentEvent } from "../core/events";
import { isRunning, runJob } from "../core/run";
import type { RunOptions } from "../core/run";
import type { IndustryConfig, Job, LiveBusiness, SimBusiness } from "../core/types";
import { getIndustry } from "../industries/index";
import { listAllJobs } from "../jobs";
import type { ListedJob } from "../jobs";
import { describeError } from "../privacy";
import type { FakeProviderOptions } from "../providers/fake";
import { checkLiveBusinesses, liveRunTimeoutMs, toSimBusinesses } from "../providers/live";
import type { LiveLimits } from "../providers/live";
import type { CallProvider } from "../providers/types";
import { scaleRun } from "../scale";
import { readSelfTestNumber, SELF_TEST_NAME } from "./selfTest";
import type { LimiterResult, SelfTestLimiter } from "./selfTest";

export type StartRunRequest = {
  jobId: string;
  provider: string;
  scale?: number;
  // Typed on the dashboard for one test call; held in memory only and never logged.
  testNumber?: string;
};

export type StartRunSettings = {
  jobsDirectory: string;
  privateJobsDirectory?: string;
  runOptions: RunOptions;
  createProvider: (name: string, fakeOptions?: FakeProviderOptions) => CallProvider;
  liveLimits?: LiveLimits;
  selfTestLimiter?: SelfTestLimiter;
};

type PreparedRun = {
  job: Job;
  industry: IndustryConfig;
  runOptions: RunOptions;
  fakeOptions: FakeProviderOptions;
};

export type StartRunResult =
  | { ok: true; runId: string }
  | { ok: false; status: 400 | 404 | 409 | 429; error: string };

function logRunFailure(error: unknown): void {
  console.error(`A run failed: ${describeError(error)}`);
}

function findJob(settings: StartRunSettings, jobId: string): ListedJob | undefined {
  const listed = listAllJobs(settings.jobsDirectory, settings.privateJobsDirectory);
  return listed.find((entry) => entry.job.id === jobId);
}

// The job is logged and streamed to the dashboard, so the phone numbers never travel with it.
function withoutPhoneNumbers(job: Job): Job {
  return { ...job, liveBusinesses: undefined };
}

// runJob emits run_started before its first await, so the id is known as soon as it is called.
async function launchRun(
  job: Job,
  industry: IndustryConfig,
  provider: CallProvider,
  runOptions: RunOptions,
): Promise<string> {
  let runId: string | undefined = undefined;

  function captureRunId(event: AgentEvent): void {
    if (event.type === "run_started" && runId === undefined) {
      runId = event.runId;
    }
  }

  const stopListening = onEvent(captureRunId);
  const finished = runJob(job, industry, provider, runOptions);
  stopListening();
  finished.catch(logRunFailure);

  if (runId === undefined) {
    // Surfaces the reason the run refused to start, such as an unknown business.
    await finished;
    throw new Error("The run did not start.");
  }

  return runId;
}

function createProviderSafely(
  settings: StartRunSettings,
  name: string,
  fakeOptions: FakeProviderOptions,
): CallProvider | string {
  try {
    return settings.createProvider(name, fakeOptions);
  } catch (error) {
    return describeError(error);
  }
}

// Fake calls cost nothing, so a scaled demo dials every business at once.
function prepareRun(
  request: StartRunRequest,
  job: Job,
  settings: StartRunSettings,
): PreparedRun | string {
  const industry = getIndustry(job.industryId);
  const publicJob = withoutPhoneNumbers(job);

  if (request.scale === undefined) {
    return { job: publicJob, industry, runOptions: settings.runOptions, fakeOptions: {} };
  }

  if (request.provider !== "fake") {
    return "Scale only works with the fake provider.";
  }

  try {
    const scaled = scaleRun(publicJob, industry, request.scale);
    const parallelCalls = scaled.industry.simBusinesses.length;

    return {
      job: scaled.job,
      industry: scaled.industry,
      runOptions: { ...settings.runOptions, maxParallelCalls: parallelCalls },
      fakeOptions: { failBusinessIds: scaled.noAnswerIds },
    };
  } catch (error) {
    return describeError(error);
  }
}

// The number was typed on the dashboard and lives only in this call's memory, never in the job.
function pickSelfTestCall(testNumber: string, limits: LiveLimits): SimBusiness[] | string {
  if (limits.selfTest !== true) {
    return "Test calls are turned off on this server (LIVE_SELF_TEST=false).";
  }

  const parsed = readSelfTestNumber(testNumber);

  if (parsed.ok === false) {
    return parsed.error;
  }

  return [
    {
      id: "test-call",
      name: SELF_TEST_NAME,
      instructions: "",
      fakeQuotes: [],
      phone: parsed.phone,
      selfTest: true,
    },
  ];
}

// Real hotel numbers only come from the private folder, which git never sees.
function pickJobCalls(listed: ListedJob, limits: LiveLimits): SimBusiness[] | string {
  if (listed.isPrivate === false) {
    return "Live calls only use private jobs from local/jobs. Pick a (private) job or use Call me to test.";
  }

  let businesses: LiveBusiness[] = [];

  if (listed.job.liveBusinesses !== undefined) {
    businesses = listed.job.liveBusinesses;
  }

  const problem = checkLiveBusinesses(businesses, limits);

  if (problem !== undefined) {
    return problem;
  }

  return toSimBusinesses(businesses);
}

function pickLiveCalls(
  request: StartRunRequest,
  listed: ListedJob,
  limits: LiveLimits,
): SimBusiness[] | string {
  if (request.testNumber !== undefined) {
    return pickSelfTestCall(request.testNumber, limits);
  }

  return pickJobCalls(listed, limits);
}

// Live calls quote only after they hang up, so the head agent waits for every call
// instead of deciding a window after the first quote.
function prepareLiveRun(
  request: StartRunRequest,
  listed: ListedJob,
  settings: StartRunSettings,
): PreparedRun | string {
  const limits = settings.liveLimits;
  const job = listed.job;

  if (limits === undefined) {
    return "Live calls are unavailable on this server.";
  }

  const calls = pickLiveCalls(request, listed, limits);

  if (typeof calls === "string") {
    return calls;
  }

  if (job.stay === undefined) {
    return "A live job needs a stay with checkIn, checkOut and beds.";
  }

  const industry = getIndustry(job.industryId);
  const timeoutMs = liveRunTimeoutMs(limits.callTimeoutMs, calls.length);
  const liveJob: Job = { ...withoutPhoneNumbers(job), businessIds: undefined };

  // The caller gives LIVE_GUEST_NAME on the phone, so that is who the quote is for, not the job's contact.
  if (limits.guestName !== undefined) {
    liveJob.guestName = limits.guestName;
  }

  return {
    job: liveJob,
    industry: { ...industry, simBusinesses: calls },
    runOptions: {
      ...settings.runOptions,
      maxParallelCalls: calls.length,
      decisionWindowMs: timeoutMs,
      runTimeoutMs: timeoutMs,
    },
    fakeOptions: {},
  };
}

function prepareAnyRun(
  request: StartRunRequest,
  listed: ListedJob,
  settings: StartRunSettings,
): PreparedRun | string {
  if (request.testNumber !== undefined && request.provider !== "live") {
    return "A test call only works in Live call mode.";
  }

  if (request.provider !== "live") {
    return prepareRun(request, listed.job, settings);
  }

  if (request.scale !== undefined) {
    return "Scale only works with the fake provider.";
  }

  return prepareLiveRun(request, listed, settings);
}

function takeSelfTestSlot(settings: StartRunSettings): LimiterResult {
  if (settings.selfTestLimiter === undefined) {
    return { ok: false, error: "Test calls are unavailable on this server." };
  }

  return settings.selfTestLimiter.take();
}

export async function startRun(
  request: StartRunRequest,
  settings: StartRunSettings,
): Promise<StartRunResult> {
  if (isRunning()) {
    return { ok: false, status: 409, error: "A run is already in progress." };
  }

  const listed = findJob(settings, request.jobId);

  if (listed === undefined) {
    return { ok: false, status: 404, error: `Unknown job "${request.jobId}".` };
  }

  // A missing key is the first thing to fix, so it is reported before any job problem.
  if (request.provider === "live") {
    const liveCheck = createProviderSafely(settings, "live", {});

    if (typeof liveCheck === "string") {
      return { ok: false, status: 400, error: liveCheck };
    }
  }

  const prepared = prepareAnyRun(request, listed, settings);

  if (typeof prepared === "string") {
    return { ok: false, status: 400, error: prepared };
  }

  const provider = createProviderSafely(settings, request.provider, prepared.fakeOptions);

  if (typeof provider === "string") {
    return { ok: false, status: 400, error: provider };
  }

  // Counted last, so a rejected request never uses up one of the hour's test calls.
  if (request.testNumber !== undefined) {
    const slot = takeSelfTestSlot(settings);

    if (slot.ok === false) {
      return { ok: false, status: 429, error: slot.error };
    }
  }

  try {
    const runId = await launchRun(
      prepared.job,
      prepared.industry,
      provider,
      prepared.runOptions,
    );
    return { ok: true, runId };
  } catch (error) {
    return { ok: false, status: 400, error: describeError(error) };
  }
}
