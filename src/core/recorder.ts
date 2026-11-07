import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { onEvent } from "./events";
import type { AgentEvent } from "./events";

const SYSTEM_LOG_FILE = "system.jsonl";
const ERROR_LOG_INTERVAL_MS = 60_000;

function getLogPath(directory: string, event: AgentEvent): string {
  let fileName = SYSTEM_LOG_FILE;

  if (event.runId !== undefined) {
    fileName = `${event.runId}.jsonl`;
  }

  return join(directory, fileName);
}

function appendEvent(directory: string, event: AgentEvent): void {
  const logPath = getLogPath(directory, event);
  const line = `${JSON.stringify(event)}\n`;
  appendFileSync(logPath, line);
}

// A full disk would fail on every event, so repeats are dropped to keep the console readable.
function createThrottledErrorLogger(): (error: unknown) => void {
  let lastLoggedAt: number | undefined = undefined;

  function logError(error: unknown): void {
    const now = Date.now();

    if (lastLoggedAt !== undefined && now - lastLoggedAt < ERROR_LOG_INTERVAL_MS) {
      return;
    }

    lastLoggedAt = now;
    console.error("Recorder failed to write an event:", error);
  }

  return logError;
}

export function startRecorder(directory: string): () => void {
  mkdirSync(directory, { recursive: true });

  const logWriteError = createThrottledErrorLogger();

  function recordEvent(event: AgentEvent): void {
    try {
      appendEvent(directory, event);
    } catch (error) {
      logWriteError(error);
    }
  }

  return onEvent(recordEvent);
}
