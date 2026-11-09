import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "../core/events";

export type PastRun = {
  runId: string;
  title: string;
  provider: string;
  startedAt: number;
  callCount: number;
};

const RUN_LOG = /^run-[A-Za-z0-9-]+\.jsonl$/;
export const MAX_PAST_RUNS = 20;

// Only the first line is needed: every run log starts with its run_started event.
function readStart(path: string): PastRun | undefined {
  const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];

  if (firstLine === undefined || firstLine.trim() === "") {
    return undefined;
  }

  try {
    const event = JSON.parse(firstLine) as AgentEvent;

    if (event.type !== "run_started") {
      return undefined;
    }

    return {
      runId: event.runId,
      title: event.job.title,
      provider: event.provider,
      startedAt: event.at,
      callCount: event.businesses.length,
    };
  } catch {
    return undefined;
  }
}

// Newest first. Run ids start with the start time, so sorting the file names sorts by time.
export function listPastRuns(directory: string): PastRun[] {
  if (existsSync(directory) === false) {
    return [];
  }

  const names = readdirSync(directory).filter((name) => RUN_LOG.test(name));
  names.sort();
  names.reverse();

  const runs: PastRun[] = [];

  for (const name of names) {
    const run = readStart(join(directory, name));

    if (run !== undefined) {
      runs.push(run);
    }

    if (runs.length >= MAX_PAST_RUNS) {
      break;
    }
  }

  return runs;
}
