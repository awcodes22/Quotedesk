import { existsSync, readFileSync } from "node:fs";
import { onEvent } from "../core/events";
import type { AgentEvent, EventListener } from "../core/events";
import { getRunLogPath } from "../core/recorder";

// Old runs stay readable from their log files, so memory only needs the recent ones.
const MAX_REMEMBERED_RUNS = 20;

type RunRecord = {
  events: AgentEvent[];
  finished: boolean;
  followers: Set<EventListener>;
};

export type FollowedRun = {
  replay: AgentEvent[];
  finished: boolean;
  stop: () => void;
};

function notifyFollower(follower: EventListener, event: AgentEvent): void {
  try {
    follower(event);
  } catch (error) {
    console.error("A run follower failed:", error);
  }
}

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();

  // Must be called before a run starts, or its first events are missed.
  start(): () => void {
    return onEvent((event) => {
      this.record(event);
    });
  }

  getEvents(runId: string): AgentEvent[] | undefined {
    const run = this.runs.get(runId);

    if (run === undefined) {
      return undefined;
    }

    return [...run.events];
  }

  // The snapshot and the subscription happen in one step, so no event falls between them.
  follow(runId: string, follower: EventListener): FollowedRun | undefined {
    const run = this.runs.get(runId);

    if (run === undefined) {
      return undefined;
    }

    run.followers.add(follower);

    function stop(): void {
      if (run !== undefined) {
        run.followers.delete(follower);
      }
    }

    return { replay: [...run.events], finished: run.finished, stop };
  }

  private record(event: AgentEvent): void {
    if (event.runId === undefined) {
      return;
    }

    const run = this.findOrCreateRun(event.runId);
    run.events.push(event);

    for (const follower of [...run.followers]) {
      notifyFollower(follower, event);
    }

    if (event.type === "run_finished") {
      run.finished = true;
      run.followers.clear();
    }
  }

  private findOrCreateRun(runId: string): RunRecord {
    const existing = this.runs.get(runId);

    if (existing !== undefined) {
      return existing;
    }

    const created: RunRecord = {
      events: [],
      finished: false,
      followers: new Set(),
    };

    this.runs.set(runId, created);
    this.forgetOldestRuns();
    return created;
  }

  private forgetOldestRuns(): void {
    for (const runId of this.runs.keys()) {
      if (this.runs.size <= MAX_REMEMBERED_RUNS) {
        return;
      }

      this.runs.delete(runId);
    }
  }
}

// The log file was written by this server, so each line is a recorded AgentEvent.
export function readRecordedEvents(
  directory: string,
  runId: string,
): AgentEvent[] | undefined {
  const logPath = getRunLogPath(directory, runId);

  if (existsSync(logPath) === false) {
    return undefined;
  }

  const contents = readFileSync(logPath, "utf8");
  const lines = contents.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line) => JSON.parse(line) as AgentEvent);
}
