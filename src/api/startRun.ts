import { onEvent } from "../core/events";
import type { AgentEvent } from "../core/events";
import { isRunning, runJob } from "../core/run";
import type { RunOptions } from "../core/run";
import type { IndustryConfig, Job, LiveBusiness } from "../core/types";
import { getIndustry } from "../industries/index";
import { listJobs } from "../jobs";
import type { FakeProviderOptions } from "../providers/fake";
import { checkLiveBusinesses, liveRunTimeoutMs, toSimBusinesses } from "../providers/live";
import type { LiveLimits } from "../providers/live";
import type { CallProvider } from "../providers/types";
import { scaleRun } from "../scale";

export type StartRunRequest = {
  jobId: string;
  provider: string;
  scale?: number;
};

export type StartRunSettings = {
  jobsDirectory: string;
  runOptions: RunOptions;
  createProvider: (name: string, fakeOptions?: FakeProviderOptions) => CallProvider;
  liveLimits?: LiveLimits;
};

type PreparedRun = {
  job: Job;
  industry: IndustryConfig;
  runOptions: RunOptions;
  fakeOptions: FakeProviderOptions;
};

export type StartRunResult =
  | { ok: true; runId: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function logRunFailure(error: unknown): void {
  console.error("A run failed:", error);
}

function findJob(jobsDirectory: string, jobId: string): Job | undefined {
  const jobs = listJobs(jobsDirectory);
  return jobs.find((job) => job.id === jobId);
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
    return getErrorMessage(error);
  }
}

// Fake calls cost nothing, so a scaled demo dials every business at once.
function prepareRun(
  request: StartRunRequest,
  job: Job,
  settings: StartRunSettings,
): PreparedRun | string {
  const industry = getIndustry(job.industryId);

  if (request.scale === undefined) {
    return { job, industry, runOptions: settings.runOptions, fakeOptions: {} };
  }

  if (request.provider !== "fake") {
    return "Scale only works with the fake provider.";
  }

  try {
    const scaled = scaleRun(job, industry, request.scale);
    const parallelCalls = scaled.industry.simBusinesses.length;

    return {
      job: scaled.job,
      industry: scaled.industry,
      runOptions: { ...settings.runOptions, maxParallelCalls: parallelCalls },
      fakeOptions: { failBusinessIds: scaled.noAnswerIds },
    };
  } catch (error) {
    return getErrorMessage(error);
  }
}

// Live calls quote only after they hang up, so the head agent waits for every call
// instead of deciding a window after the first quote.
function prepareLiveRun(job: Job, settings: StartRunSettings): PreparedRun | string {
  const limits = settings.liveLimits;
  let businesses: LiveBusiness[] = [];

  if (limits === undefined) {
    return "Live calls are unavailable on this server.";
  }

  if (job.liveBusinesses !== undefined) {
    businesses = job.liveBusinesses;
  }

  const problem = checkLiveBusinesses(businesses, limits);

  if (problem !== undefined) {
    return problem;
  }

  if (job.stay === undefined) {
    return "A live job needs a stay with checkIn, checkOut and beds.";
  }

  const industry = getIndustry(job.industryId);
  const timeoutMs = liveRunTimeoutMs(limits.callTimeoutMs, businesses.length);

  return {
    // The numbers stay out of the job, which is logged and sent to the dashboard.
    job: { ...job, businessIds: undefined, liveBusinesses: undefined },
    industry: { ...industry, simBusinesses: toSimBusinesses(businesses) },
    runOptions: {
      ...settings.runOptions,
      maxParallelCalls: businesses.length,
      decisionWindowMs: timeoutMs,
      runTimeoutMs: timeoutMs,
    },
    fakeOptions: {},
  };
}

function prepareAnyRun(
  request: StartRunRequest,
  job: Job,
  settings: StartRunSettings,
): PreparedRun | string {
  if (request.provider !== "live") {
    return prepareRun(request, job, settings);
  }

  if (request.scale !== undefined) {
    return "Scale only works with the fake provider.";
  }

  return prepareLiveRun(job, settings);
}

export async function startRun(
  request: StartRunRequest,
  settings: StartRunSettings,
): Promise<StartRunResult> {
  if (isRunning()) {
    return { ok: false, status: 409, error: "A run is already in progress." };
  }

  const job = findJob(settings.jobsDirectory, request.jobId);

  if (job === undefined) {
    return { ok: false, status: 404, error: `Unknown job "${request.jobId}".` };
  }

  // A missing key is the first thing to fix, so it is reported before any job problem.
  if (request.provider === "live") {
    const liveCheck = createProviderSafely(settings, "live", {});

    if (typeof liveCheck === "string") {
      return { ok: false, status: 400, error: liveCheck };
    }
  }

  const prepared = prepareAnyRun(request, job, settings);

  if (typeof prepared === "string") {
    return { ok: false, status: 400, error: prepared };
  }

  const provider = createProviderSafely(settings, request.provider, prepared.fakeOptions);

  if (typeof provider === "string") {
    return { ok: false, status: 400, error: provider };
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
    return { ok: false, status: 400, error: getErrorMessage(error) };
  }
}
