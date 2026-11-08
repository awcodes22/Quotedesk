import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/core/events";
import { followRun } from "../public/js/stream.js";
import type { RunState } from "../public/js/state.js";

type Listener = (event: { data?: unknown }) => void;

class FakeEventSource {
  readonly url: string;
  closeCount = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type);

    if (existing === undefined) {
      this.listeners.set(type, [listener]);
    } else {
      existing.push(listener);
    }
  }

  close(): void {
    this.closeCount += 1;
  }

  fire(type: string, data?: string): void {
    const listeners = this.listeners.get(type);

    if (listeners === undefined) {
      return;
    }

    for (const listener of listeners) {
      listener({ data });
    }
  }
}

function startedEvent(): AgentEvent {
  return {
    type: "run_started",
    runId: "run-test",
    at: 0,
    job: { id: "job", industryId: "hotels", title: "Job", request: "A room" },
    industryLabel: "Hotel rooms",
    provider: "fake",
    businesses: [{ id: "harbour-inn", name: "Harbour Inn" }],
  };
}

function statusEvent(status: "connecting" | "talking"): AgentEvent {
  return {
    type: "call_status",
    runId: "run-test",
    at: 1,
    callId: "call-harbour-inn",
    businessId: "harbour-inn",
    status,
  };
}

function setUp() {
  const sources: FakeEventSource[] = [];
  const frames: (() => void)[] = [];
  const renders: { state: RunState; ended: boolean }[] = [];

  const stream = followRun(
    "run-test",
    (state, ended) => renders.push({ state, ended }),
    {
      createSource: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
      requestFrame: (callback) => frames.push(callback),
    },
  );

  function flushFrames(): void {
    for (const frame of frames.splice(0)) {
      frame();
    }
  }

  const source = sources[0];

  if (source === undefined) {
    throw new Error("followRun did not open a source.");
  }

  return { stream, source, frames, renders, flushFrames };
}

function lastRender(renders: { state: RunState; ended: boolean }[]) {
  const render = renders.at(-1);

  if (render === undefined) {
    throw new Error("Nothing was rendered.");
  }

  return render;
}

function harbourInnStatus(state: RunState): string {
  const call = state.calls["call-harbour-inn"];

  if (call === undefined) {
    throw new Error("Harbour Inn is missing from the state.");
  }

  return call.status;
}

describe("followRun", () => {
  it("listens on the run's events endpoint", () => {
    const { source } = setUp();

    expect(source.url).toBe("/api/runs/run-test/events");
  });

  it("renders once per frame however many events arrive", () => {
    const { source, frames, renders, flushFrames } = setUp();

    source.fire("open");
    source.fire("message", JSON.stringify(startedEvent()));
    source.fire("message", JSON.stringify(statusEvent("connecting")));
    source.fire("message", JSON.stringify(statusEvent("talking")));

    expect(frames).toHaveLength(1);
    flushFrames();
    expect(renders).toHaveLength(1);
    expect(harbourInnStatus(lastRender(renders).state)).toBe("talking");
  });

  it("closes the stream on end so it never reconnects and replays", () => {
    const { source, renders, flushFrames } = setUp();

    source.fire("message", JSON.stringify(startedEvent()));
    source.fire("end", "{}");
    flushFrames();

    expect(source.closeCount).toBe(1);
    expect(lastRender(renders).ended).toBe(true);
  });

  it("starts over when a dropped connection reopens and replays", () => {
    const { source, renders, flushFrames } = setUp();

    source.fire("open");
    source.fire("message", JSON.stringify(startedEvent()));
    source.fire("message", JSON.stringify(statusEvent("talking")));
    source.fire("open");
    source.fire("message", JSON.stringify(startedEvent()));
    flushFrames();

    expect(harbourInnStatus(lastRender(renders).state)).toBe("queued");
  });

  it("skips a message that is not valid JSON", () => {
    const { source, frames } = setUp();

    source.fire("message", "{not json");

    expect(frames).toHaveLength(0);
  });
});
