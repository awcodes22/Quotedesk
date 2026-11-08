import type { Response } from "express";
import type { AgentEvent } from "../core/events";
import type { RunRegistry } from "./registry";

function openStream(response: Response): void {
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
}

function writeEvent(response: Response, event: AgentEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

// EventSource reconnects whenever a stream closes, so the client needs a signal to stop.
function closeStream(response: Response): void {
  response.write("event: end\ndata: {}\n\n");
  response.end();
}

export function streamRecordedEvents(
  response: Response,
  events: AgentEvent[],
): void {
  openStream(response);

  for (const event of events) {
    writeEvent(response, event);
  }

  closeStream(response);
}

// Returns false when the registry doesn't know the run.
export function streamLiveEvents(
  response: Response,
  registry: RunRegistry,
  runId: string,
): boolean {
  function forward(event: AgentEvent): void {
    writeEvent(response, event);

    if (event.type === "run_finished") {
      closeStream(response);
    }
  }

  const followed = registry.follow(runId, forward);

  if (followed === undefined) {
    return false;
  }

  openStream(response);

  for (const event of followed.replay) {
    writeEvent(response, event);
  }

  if (followed.finished) {
    followed.stop();
    closeStream(response);
    return true;
  }

  response.on("close", followed.stop);
  return true;
}
