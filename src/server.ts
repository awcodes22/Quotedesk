import { createApp } from "./app";
import { config } from "./config";
import { RunRegistry } from "./api/registry";
import { startRecorder } from "./core/recorder";
import { createProvider } from "./providers/index";

const RUNS_DIRECTORY = "runs";

const registry = new RunRegistry();
registry.start();
startRecorder(RUNS_DIRECTORY);

const app = createApp({
  jobsDirectory: "data/jobs",
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
  createProvider: (name) => createProvider(name, config),
  registry,
});

// Express 5 also calls this when listening fails, such as when the port is in use.
function handleListenResult(error?: Error): void {
  if (error !== undefined) {
    throw error;
  }

  console.log(`QuoteDesk listening on http://localhost:${config.PORT}`);
}

app.listen(config.PORT, handleListenResult);
