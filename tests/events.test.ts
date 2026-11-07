import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emit, onEvent } from "../src/core/events";
import type { AgentEvent, EventListener } from "../src/core/events";
import { startRecorder } from "../src/core/recorder";

const unsubscribers: (() => void)[] = [];
const tempDirectories: string[] = [];

const runStarted: AgentEvent = {
  type: "run_started",
  runId: "run-1",
  at: 1,
  job: {
    id: "job-1",
    industryId: "hotels",
    title: "Weekend stay",
    request: "A room for two nights",
  },
  industryLabel: "Hotel rooms",
  provider: "fake",
  businesses: [{ id: "harbour-inn", name: "Harbour Inn" }],
};

const callStatus: AgentEvent = {
  type: "call_status",
  runId: "run-1",
  at: 2,
  callId: "call-1",
  businessId: "harbour-inn",
  status: "talking",
};

const note: AgentEvent = {
  type: "note",
  runId: "run-1",
  at: 3,
  callId: "call-1",
  businessId: "harbour-inn",
  text: "Asked about breakfast",
};

const systemAlert: AgentEvent = {
  type: "alert",
  at: 4,
  level: "warn",
  code: "test-alert",
  message: "No run is active",
};

function subscribe(listener: EventListener): void {
  const unsubscribe = onEvent(listener);
  unsubscribers.push(unsubscribe);
}

function createTempDirectory(): string {
  const prefix = join(tmpdir(), "quotedesk-events-");
  const directory = mkdtempSync(prefix);
  tempDirectories.push(directory);
  return directory;
}

function startTestRecorder(directory: string): void {
  const stopRecorder = startRecorder(directory);
  unsubscribers.push(stopRecorder);
}

function readJsonLines(filePath: string): unknown[] {
  const contents = readFileSync(filePath, "utf8");
  const lines = contents.trimEnd().split("\n");
  return lines.map((line) => JSON.parse(line));
}

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) {
    unsubscribe();
  }

  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }

  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("event bus", () => {
  it("delivers an emitted event to a subscribed listener", () => {
    const listener = vi.fn<EventListener>();
    subscribe(listener);

    emit(note);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(note);
  });

  it("keeps delivering when an earlier listener throws", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenListener = vi.fn<EventListener>(() => {
      throw new Error("Broken listener");
    });
    const healthyListener = vi.fn<EventListener>();
    subscribe(brokenListener);
    subscribe(healthyListener);

    emit(note);

    expect(brokenListener).toHaveBeenCalledTimes(1);
    expect(healthyListener).toHaveBeenCalledWith(note);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("stops delivery after unsubscribing", () => {
    const listener = vi.fn<EventListener>();
    const unsubscribe = onEvent(listener);

    unsubscribe();
    emit(note);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("startRecorder", () => {
  it("writes a run's events to <runId>.jsonl, one per line, in order", () => {
    const directory = createTempDirectory();
    startTestRecorder(directory);

    emit(runStarted);
    emit(callStatus);
    emit(note);

    const recorded = readJsonLines(join(directory, "run-1.jsonl"));
    expect(recorded).toEqual([runStarted, callStatus, note]);
  });

  it("writes an alert with no runId to system.jsonl", () => {
    const directory = createTempDirectory();
    startTestRecorder(directory);

    emit(systemAlert);

    const recorded = readJsonLines(join(directory, "system.jsonl"));
    expect(recorded).toEqual([systemAlert]);
  });

  it("creates the directory if it is missing", () => {
    const directory = join(createTempDirectory(), "nested", "runs");
    startTestRecorder(directory);

    emit(note);

    const recorded = readJsonLines(join(directory, "run-1.jsonl"));
    expect(recorded).toEqual([note]);
  });

  it("logs write errors at most once a minute without throwing", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const directory = createTempDirectory();
    startTestRecorder(directory);
    rmSync(directory, { recursive: true, force: true });

    emit(note);
    emit(note);
    expect(errorLog).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(59_999);
    emit(note);
    expect(errorLog).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    emit(note);
    expect(errorLog).toHaveBeenCalledTimes(2);
  });
});
