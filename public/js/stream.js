// @ts-check
import { createInitialState, runReducer } from "./state.js";

/**
 * @typedef {import("./state.js").RunState} RunState
 * @typedef {import("./state.js").AgentEvent} AgentEvent
 *
 * @typedef {{
 *   addEventListener(type: string, listener: (event: { data?: unknown }) => void): void,
 *   close(): void,
 * }} EventSourceLike
 *
 * @typedef {{
 *   createSource?: (url: string) => EventSourceLike,
 *   requestFrame?: (callback: () => void) => unknown,
 * }} StreamOptions
 *
 * @typedef {(state: RunState, ended: boolean) => void} RenderCallback
 *
 * @typedef {{ close(): void }} RunStream
 */

/**
 * @param {string} url
 * @returns {EventSourceLike}
 */
function openEventSource(url) {
  return new EventSource(url);
}

/**
 * @param {() => void} callback
 * @returns {unknown}
 */
function requestAnimationFrameOnce(callback) {
  return window.requestAnimationFrame(callback);
}

/**
 * @param {string} runId
 * @returns {string}
 */
export function buildEventsUrl(runId) {
  return `/api/runs/${encodeURIComponent(runId)}/events`;
}

/**
 * @param {unknown} data
 * @returns {AgentEvent | null}
 */
function parseEvent(data) {
  if (typeof data !== "string") {
    return null;
  }

  try {
    return /** @type {AgentEvent} */ (JSON.parse(data));
  } catch (error) {
    console.error("Skipped an event that was not valid JSON:", error);
    return null;
  }
}

/**
 * Follows one run and renders at most once per animation frame, however many events arrive.
 * @param {string} runId
 * @param {RenderCallback} render
 * @param {StreamOptions} [options]
 * @returns {RunStream}
 */
export function followRun(runId, render, options) {
  let createSource = openEventSource;
  let requestFrame = requestAnimationFrameOnce;

  if (options !== undefined && options.createSource !== undefined) {
    createSource = options.createSource;
  }

  if (options !== undefined && options.requestFrame !== undefined) {
    requestFrame = options.requestFrame;
  }

  let state = createInitialState();
  let ended = false;
  let frameRequested = false;
  const source = createSource(buildEventsUrl(runId));

  function renderFrame() {
    frameRequested = false;
    render(state, ended);
  }

  function scheduleRender() {
    if (frameRequested) {
      return;
    }

    frameRequested = true;
    requestFrame(renderFrame);
  }

  // A dropped connection reopens and the server replays from run_started, which the reducer
  // treats as a fresh start, so nothing is counted twice.
  /** @param {{ data?: unknown }} message */
  function handleMessage(message) {
    const event = parseEvent(message.data);

    if (event === null) {
      return;
    }

    state = runReducer(state, event);
    scheduleRender();
  }

  // Closing here stops EventSource from reconnecting and replaying a finished run forever.
  function handleEnd() {
    ended = true;
    source.close();
    scheduleRender();
  }

  source.addEventListener("message", handleMessage);
  source.addEventListener("end", handleEnd);

  return {
    close() {
      source.close();
    },
  };
}
