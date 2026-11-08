import { onEvent } from "../core/events";
import type { AgentEvent } from "../core/events";
import { isRunning, runJob } from "../core/run";
import type { RunOptions } from "../core/run";
import type { IndustryConfig, Job } from "../core/types";
import { getIndustry } from "../industries/index";
import { listJobs } from "../jobs";
import type { CallProvider } from "../providers/types";

export type StartRunRequest = {
  jobId: string;
  provider: string;
};

export type StartRunSettings = {
  jobsDirectory: string;
  runOptions: RunOptions;
  createProvider: (name: string) => CallProvider;
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
): CallProvider | string {
  try {
    return settings.createProvider(name);
  } catch (error) {
    return getErrorMessage(error);
  }
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

  const provider = createProviderSafely(settings, request.provider);

  if (typeof provider === "string") {
    return { ok: false, status: 400, error: provider };
  }

  const industry = getIndustry(job.industryId);

  try {
    const runId = await launchRun(job, industry, provider, settings.runOptions);
    return { ok: true, runId };
  } catch (error) {
    return { ok: false, status: 400, error: getErrorMessage(error) };
  }
}
