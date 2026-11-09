import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import type {
  Express,
  NextFunction,
  Request,
  Response,
  Router,
} from "express";
import { z } from "zod";
import type { AgentEvent } from "./core/events";
import { stopRun } from "./core/run";
import type { RunOptions } from "./core/run";
import { getIndustry } from "./industries/index";
import { listAllJobs } from "./jobs";
import type { ListedJob } from "./jobs";
import type { FakeProviderOptions } from "./providers/fake";
import { audioPath } from "./providers/live";
import type { LiveLimits } from "./providers/live";
import type { CallProvider } from "./providers/types";
import { describeError, maskPhoneNumbers, maskStrings } from "./privacy";
import { MAX_SCALE } from "./scale";
import { streamLiveEvents, streamRecordedEvents } from "./api/eventStream";
import { readRecordedEvents } from "./api/registry";
import type { RunRegistry } from "./api/registry";
import { SelfTestLimiter } from "./api/selfTest";
import { PlacesDirectory } from "./places/placesDirectory";
import { samplePlacesProvider } from "./places/samplePlaces";
import { listPastRuns } from "./api/pastRuns";
import { startRun } from "./api/startRun";
import { summarizeRun } from "./api/summary";

export type AppOptions = {
  jobsDirectory: string;
  privateJobsDirectory?: string;
  runsDirectory: string;
  publicDirectory: string;
  runOptions: RunOptions;
  maxTurns: number;
  createProvider: (name: string, fakeOptions?: FakeProviderOptions) => CallProvider;
  registry: RunRegistry;
  liveLimits?: LiveLimits;
  selfTestLimiter?: SelfTestLimiter;
  placesDirectory?: PlacesDirectory;
};

// zod's messages for these fields never repeat the value, so a typed number can't leak through them.
// The stay is checked in full by startRun, which knows today's date.
const startRunSchema = z.strictObject({
  jobId: z.string().min(1).optional(),
  stay: z.record(z.string(), z.unknown()).optional(),
  provider: z.enum(["fake", "text", "live"]),
  scale: z.number().int().min(1).max(MAX_SCALE).optional(),
  testNumber: z.string().min(1).max(40).optional(),
  testCallMode: z.enum(["live", "test"]).optional(),
  placeIds: z.array(z.string().min(1).max(300)).min(1).max(20).optional(),
});

const placesSearchSchema = z.strictObject({
  query: z.string().min(1).max(200),
});

const autocompleteSchema = z.strictObject({
  input: z.string().max(200),
});

// Run and call ids become file names, so anything that could leave the runs folder is refused.
const runIdSchema = z.string().regex(/^run-[A-Za-z0-9-]+$/);
const callIdSchema = z.string().regex(/^call-[A-Za-z0-9-]+$/);

type ListingLimits = {
  decideWithinMs: number;
  maxTurns: number;
};

// Only the fields the dashboard needs, so a private job's phone numbers never leave the server.
function buildJobListing(listed: ListedJob, limits: ListingLimits) {
  const { job, isPrivate } = listed;
  const industry = getIndustry(job.industryId);
  let businessCount = industry.simBusinesses.length;
  let title = job.title;

  if (job.businessIds !== undefined && job.businessIds.length > 0) {
    businessCount = new Set(job.businessIds).size;
  }

  if (isPrivate) {
    title = `${job.title} (private)`;
  }

  let contactName: string | null = null;

  if (job.contact !== undefined) {
    contactName = job.contact.name;
  }

  return {
    id: job.id,
    title,
    isPrivate,
    request: job.request,
    industry: {
      id: industry.id,
      label: industry.label,
      clientNoun: industry.clientNoun,
      businessNoun: industry.businessNoun,
      fieldLabels: industry.fieldLabels,
    },
    reference: job.reference,
    details: job.details,
    location: nullWhenMissing(job.location),
    decideWithinMs: limits.decideWithinMs,
    maxTurns: limits.maxTurns,
    contactName,
    businessCount,
  };
}

function nullWhenMissing<Value>(value: Value | undefined): Value | null {
  if (value === undefined) {
    return null;
  }

  return value;
}

function sendError(response: Response, status: number, error: string): void {
  response.status(status).json({ error: maskPhoneNumbers(error) });
}

// The last line of defence: nothing the browser receives carries a full phone number.
function sendJson(response: Response, status: number, body: unknown): void {
  response.status(status).json(maskStrings(body));
}

function readRunId(request: Request, response: Response): string | undefined {
  const parsed = runIdSchema.safeParse(request.params.id);

  if (parsed.success === false) {
    sendError(response, 400, "Invalid run id.");
    return undefined;
  }

  return parsed.data;
}

function loadRunEvents(
  options: AppOptions,
  runId: string,
): AgentEvent[] | undefined {
  const liveEvents = options.registry.getEvents(runId);

  if (liveEvents !== undefined) {
    return liveEvents;
  }

  return readRecordedEvents(options.runsDirectory, runId);
}

function buildApiRouter(options: AppOptions): Router {
  const router = express.Router();
  let selfTestLimiter = new SelfTestLimiter();

  if (options.selfTestLimiter !== undefined) {
    selfTestLimiter = options.selfTestLimiter;
  }

  let placesDirectory = new PlacesDirectory(samplePlacesProvider());

  if (options.placesDirectory !== undefined) {
    placesDirectory = options.placesDirectory;
  }

  const runSettings = { ...options, selfTestLimiter, placesDirectory };

  function handleListJobs(_request: Request, response: Response): void {
    const jobs = listAllJobs(options.jobsDirectory, options.privateJobsDirectory);
    // The head agent decides by the run timeout at the latest, so that is the promise shown.
    const limits = {
      decideWithinMs: options.runOptions.runTimeoutMs,
      maxTurns: options.maxTurns,
    };
    const listings = jobs.map((listed) => buildJobListing(listed, limits));
    let selfTest = false;

    if (options.liveLimits !== undefined && options.liveLimits.selfTest === true) {
      selfTest = true;
    }

    let liveMaxCalls = 0;

    if (options.liveLimits !== undefined) {
      liveMaxCalls = options.liveLimits.maxCalls;
    }

    sendJson(response, 200, { jobs: listings, selfTest, liveMaxCalls });
  }

  async function handleStartRun(
    request: Request,
    response: Response,
  ): Promise<void> {
    const parsed = startRunSchema.safeParse(request.body);

    if (parsed.success === false) {
      sendError(response, 400, z.prettifyError(parsed.error));
      return;
    }

    const result = await startRun(parsed.data, runSettings);

    if (result.ok === false) {
      sendError(response, result.status, result.error);
      return;
    }

    sendJson(response, 201, { runId: result.runId });
  }

  function handleRunEvents(request: Request, response: Response): void {
    const runId = readRunId(request, response);

    if (runId === undefined) {
      return;
    }

    const streamedLive = streamLiveEvents(response, options.registry, runId);

    if (streamedLive) {
      return;
    }

    const recorded = readRecordedEvents(options.runsDirectory, runId);

    if (recorded === undefined) {
      sendError(response, 404, "Unknown run.");
      return;
    }

    streamRecordedEvents(response, recorded);
  }

  function handleRunSummary(request: Request, response: Response): void {
    const runId = readRunId(request, response);

    if (runId === undefined) {
      return;
    }

    const events = loadRunEvents(options, runId);

    if (events === undefined) {
      sendError(response, 404, "Unknown run.");
      return;
    }

    const summary = summarizeRun(events);

    if (summary === undefined) {
      sendError(response, 409, "The run hasn't finished yet.");
      return;
    }

    sendJson(response, 200, summary);
  }

  function handleCallAudio(request: Request, response: Response): void {
    const runId = readRunId(request, response);

    if (runId === undefined) {
      return;
    }

    const callId = callIdSchema.safeParse(request.params.callId);

    if (callId.success === false) {
      sendError(response, 400, "Invalid call id.");
      return;
    }

    const path = resolve(audioPath(options.runsDirectory, runId, callId.data));

    if (existsSync(path) === false) {
      sendError(response, 404, "No recording for this call.");
      return;
    }

    response.type("audio/mpeg");
    response.sendFile(path);
  }

  router.get("/jobs", handleListJobs);
  // Hotel listings are public, so they are sent whole; errors still go through sendError and are masked.
  async function handleSearchPlaces(request: Request, response: Response): Promise<void> {
    const parsed = placesSearchSchema.safeParse(request.body);

    if (parsed.success === false) {
      sendError(response, 400, z.prettifyError(parsed.error));
      return;
    }

    const result = await placesDirectory.search(parsed.data.query);

    if (result.ok === false) {
      sendError(response, result.status, result.error);
      return;
    }

    response.status(200).json({ sample: result.sample, hotels: result.hotels });
  }

  async function handleAutocomplete(request: Request, response: Response): Promise<void> {
    const parsed = autocompleteSchema.safeParse(request.body);

    if (parsed.success === false) {
      sendError(response, 400, z.prettifyError(parsed.error));
      return;
    }

    const result = await placesDirectory.autocomplete(parsed.data.input);

    if (result.ok === false) {
      sendError(response, result.status, result.error);
      return;
    }

    sendJson(response, 200, { sample: result.sample, suggestions: result.suggestions });
  }

  function handleListRuns(_request: Request, response: Response): void {
    sendJson(response, 200, { runs: listPastRuns(options.runsDirectory) });
  }

  router.post("/places/search", handleSearchPlaces);
  router.post("/places/autocomplete", handleAutocomplete);
  router.get("/runs", handleListRuns);
  router.post("/runs", handleStartRun);
  router.get("/runs/:id/events", handleRunEvents);
  function handleStopRun(request: Request, response: Response): void {
    const runId = readRunId(request, response);

    if (runId === undefined) {
      return;
    }

    const result = stopRun(runId);

    if (result === "not-running") {
      sendError(response, 404, "That run isn't going right now.");
      return;
    }

    sendJson(response, 200, { result });
  }

  router.get("/runs/:id/summary", handleRunSummary);
  router.post("/runs/:id/stop", handleStopRun);
  router.get("/runs/:id/calls/:callId/audio", handleCallAudio);
  return router;
}

function handleHealthCheck(_request: Request, response: Response): void {
  response.json({ ok: true });
}

// The page reads the run id from its own URL, so the server only picks the file.
function servePage(publicDirectory: string, fileName: string) {
  return function sendPage(_request: Request, response: Response): void {
    response.sendFile(fileName, { root: resolve(publicDirectory) });
  };
}

// Express marks request mistakes, such as malformed JSON or a missing page, with a 4xx status.
function findClientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const hasStatus = "status" in error;

  if (hasStatus === false) {
    return undefined;
  }

  const status = error.status;

  if (typeof status === "number" && status >= 400 && status < 500) {
    return status;
  }

  return undefined;
}

function handleError(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  const clientErrorStatus = findClientErrorStatus(error);

  if (clientErrorStatus !== undefined) {
    sendError(response, clientErrorStatus, "The request could not be handled.");
    return;
  }

  console.error(`Request failed: ${describeError(error)}`);
  sendError(response, 500, "Something went wrong.");
}

export function createApp(options: AppOptions): Express {
  const app = express();

  app.use(express.json());
  app.get("/health", handleHealthCheck);
  app.use("/api", buildApiRouter(options));
  app.get("/", servePage(options.publicDirectory, "home.html"));
  app.get("/new", servePage(options.publicDirectory, "new.html"));
  app.get("/demo", servePage(options.publicDirectory, "demo.html"));
  app.get("/run/:id", servePage(options.publicDirectory, "run.html"));
  // The old job-based dashboard, kept only as a fallback.
  app.get("/demo/legacy", servePage(options.publicDirectory, "index.html"));
  app.get("/runs/:id", servePage(options.publicDirectory, "index.html"));
  app.get(
    "/runs/:id/breakdown",
    servePage(options.publicDirectory, "breakdown.html"),
  );
  app.use(express.static(options.publicDirectory));
  app.use(handleError);
  return app;
}
