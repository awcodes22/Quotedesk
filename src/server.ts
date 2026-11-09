import { createApp } from "./app";
import { config } from "./config";
import { RunRegistry } from "./api/registry";
import { startRecorder } from "./core/recorder";
import type { LiveLimits } from "./providers/live";
import { createProvider, listAllowedLiveNumbers } from "./providers/index";

const RUNS_DIRECTORY = "runs";
// Gitignored, so job files with real phone numbers never reach the repo.
const PRIVATE_JOBS_DIRECTORY = "local/jobs";

const registry = new RunRegistry();
registry.start();
startRecorder(RUNS_DIRECTORY);

const liveLimits: LiveLimits = {
  allowedNumbers: listAllowedLiveNumbers(config),
  maxCalls: config.LIVE_MAX_CALLS,
  callTimeoutMs: config.LIVE_CALL_TIMEOUT_MS,
};

if (config.LIVE_TEST_NUMBER !== undefined) {
  liveLimits.testNumber = config.LIVE_TEST_NUMBER;
}

const app = createApp({
  jobsDirectory: "data/jobs",
  privateJobsDirectory: PRIVATE_JOBS_DIRECTORY,
  runsDirectory: RUNS_DIRECTORY,
  publicDirectory: "public",
  runOptions: {
    maxParallelCalls: config.MAX_PARALLEL_CALLS,
    decisionWindowMs: config.DECISION_WINDOW_MS,
    runTimeoutMs: config.RUN_TIMEOUT_MS,
    settleGraceMs: config.SETTLE_GRACE_MS,
    priceFlagPct: config.PRICE_FLAG_PCT,
  },
  maxTurns: config.MAX_TURNS,
  createProvider: (name, fakeOptions) => createProvider(name, config, fakeOptions, RUNS_DIRECTORY),
  registry,
  liveLimits,
});

// Express 5 also calls this when listening fails, such as when the port is in use.
function handleListenResult(error?: Error): void {
  if (error !== undefined) {
    throw error;
  }

  console.log(`QuoteDesk listening on http://${config.HOST}:${config.PORT}`);
}

// Loopback by default, since the API has no login and live calls cost real money.
app.listen(config.PORT, config.HOST, handleListenResult);
