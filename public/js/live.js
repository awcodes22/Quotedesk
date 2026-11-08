// @ts-check
import { createInitialState, selectCalls, selectLeader } from "./state.js";
import { followRun } from "./stream.js";
import { createCallPanel, selectCallPanelModel } from "./render/callPanel.js";
import { createGrid, selectGridModel } from "./render/grid.js";
import { createHeadAgent, selectHeadAgentModel } from "./render/headAgent.js";
import { createPickerHeader, createRunHeader, selectRunHeaderModel } from "./render/header.js";
import { createStats, selectStatsModel } from "./render/stats.js";
import { createTopCards, selectTopCardsModel } from "./render/topCards.js";
import { createTracker, selectTrackerModel } from "./render/tracker.js";

/**
 * @typedef {import("./state.js").RunState} RunState
 * @typedef {import("./state.js").CallState} CallState
 * @typedef {import("./render/view.js").View} View
 * @typedef {import("./render/view.js").JobListing} JobListing
 * @typedef {import("./render/view.js").GridFilter} GridFilter
 * @typedef {import("./render/view.js").GridSort} GridSort
 * @typedef {import("./render/header.js").StartRequest} StartRequest
 *
 * @typedef {{
 *   state: RunState,
 *   ended: boolean,
 *   listing: JobListing | null,
 *   pickedCallId: string | null,
 *   filter: GridFilter,
 *   search: string,
 *   sort: GridSort,
 *   clockOffsetMs: number,
 * }} PageState
 */

const RUN_PATH = /^\/runs\/(run-[A-Za-z0-9-]+)\/?$/;
const TICK_MS = 500;

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function findElement(id) {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`The page is missing #${id}.`);
  }

  return element;
}

/** @returns {Promise<JobListing[]>} */
async function fetchJobs() {
  const response = await fetch("/api/jobs");

  if (response.ok === false) {
    throw new Error(`Could not load jobs (${response.status}).`);
  }

  const body = await response.json();
  return body.jobs;
}

/**
 * Moves to the run's own page on success, so a reload keeps watching the same run.
 * @param {StartRequest} request
 * @returns {Promise<string | null>}
 */
async function startRun(request) {
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = await response.json();

    if (response.status !== 201) {
      let message = "Could not start the run.";

      if (typeof body.error === "string") {
        message = body.error;
      }

      return message;
    }

    window.location.assign(`/runs/${encodeURIComponent(body.runId)}`);
    return null;
  } catch (error) {
    return "Could not reach the server.";
  }
}

/** @returns {string | null} */
function readRunId() {
  const match = RUN_PATH.exec(window.location.pathname);

  if (match === null || match[1] === undefined) {
    return null;
  }

  return match[1];
}

/**
 * A call the user clicked wins; otherwise the leader, then the first call with something said.
 * @param {PageState} page
 * @returns {CallState | null}
 */
function findShownCall(page) {
  const { state } = page;

  if (page.pickedCallId !== null) {
    const picked = state.calls[page.pickedCallId];

    if (picked !== undefined) {
      return picked;
    }
  }

  const leader = selectLeader(state);

  if (leader !== null) {
    const leaderCall = state.calls[leader.callId];

    if (leaderCall !== undefined) {
      return leaderCall;
    }
  }

  const calls = selectCalls(state);
  const talkative = calls.find((call) => call.turns.length > 0);

  if (talkative !== undefined) {
    return talkative;
  }

  const firstCall = calls[0];

  if (firstCall === undefined) {
    return null;
  }

  return firstCall;
}

/**
 * @template Model
 * @param {(view: View) => Model} select
 * @param {{ update: (model: Model) => void }} region
 * @returns {(view: View) => void}
 */
function onlyWhenChanged(select, region) {
  let lastKey = "";

  return function renderRegion(view) {
    const model = select(view);
    const key = JSON.stringify(model);

    if (key === lastKey) {
      return;
    }

    lastKey = key;
    region.update(model);
  };
}

/**
 * @param {PageState} page
 * @param {CallState | null} shownCall
 * @returns {View}
 */
function buildView(page, shownCall) {
  let selectedCallId = null;

  if (shownCall !== null) {
    selectedCallId = shownCall.callId;
  }

  return {
    state: page.state,
    now: Date.now() - page.clockOffsetMs,
    listing: page.listing,
    selectedCallId,
    filter: page.filter,
    search: page.search,
    sort: page.sort,
    ended: page.ended,
  };
}

/**
 * The smallest gap between an event's time and its arrival is the closest guess at the
 * server's clock, and replayed history only ever makes that gap larger.
 * @param {PageState} page
 */
function alignClock(page) {
  const lastEventAt = page.state.lastEventAt;

  if (lastEventAt === null) {
    return;
  }

  const offset = Date.now() - lastEventAt;

  if (offset < page.clockOffsetMs) {
    page.clockOffsetMs = offset;
  }
}

/**
 * @param {string} runId
 * @param {JobListing[]} jobs
 */
function showRun(runId, jobs) {
  findElement("hero").hidden = false;
  findElement("call-panel").hidden = false;

  /** @type {PageState} */
  const page = {
    state: createInitialState(),
    ended: false,
    listing: null,
    pickedCallId: null,
    filter: "all",
    search: "",
    sort: "price",
    clockOffsetMs: Number.POSITIVE_INFINITY,
  };

  let frameRequested = false;
  let tickTimer = 0;

  function requestRender() {
    if (frameRequested) {
      return;
    }

    frameRequested = true;
    window.requestAnimationFrame(renderPage);
  }

  /** @param {string} callId */
  function selectCall(callId) {
    page.pickedCallId = callId;
    requestRender();
  }

  const regions = [
    onlyWhenChanged(selectRunHeaderModel, createRunHeader(findElement("topbar"))),
    onlyWhenChanged(selectTrackerModel, createTracker(findElement("tracker"))),
    onlyWhenChanged(selectHeadAgentModel, createHeadAgent(findElement("head-agent"))),
    onlyWhenChanged(selectTopCardsModel, createTopCards(findElement("top-cards"), selectCall)),
    onlyWhenChanged(
      selectGridModel,
      createGrid(findElement("grid"), {
        onSelect: selectCall,
        onFilter: (filter) => {
          page.filter = filter;
          requestRender();
        },
        onSearch: (text) => {
          page.search = text;
          requestRender();
        },
        onSort: (sort) => {
          page.sort = sort;
          requestRender();
        },
      }),
    ),
    onlyWhenChanged(selectStatsModel, createStats(findElement("stats"))),
  ];
  const callPanel = createCallPanel(findElement("call-panel"));

  function renderPage() {
    frameRequested = false;

    if (page.state.runId === null) {
      return;
    }

    const shownCall = findShownCall(page);
    const view = buildView(page, shownCall);

    for (const renderRegion of regions) {
      renderRegion(view);
    }

    if (shownCall !== null) {
      callPanel.update(selectCallPanelModel(view, shownCall));
    }
  }

  /**
   * @param {RunState} state
   * @param {boolean} ended
   */
  function receiveState(state, ended) {
    page.state = state;
    page.ended = ended;
    alignClock(page);

    if (page.listing === null && state.job !== null) {
      const jobId = state.job.id;
      const listing = jobs.find((job) => job.id === jobId);

      if (listing !== undefined) {
        page.listing = listing;
      }
    }

    if (ended) {
      window.clearInterval(tickTimer);
    }

    renderPage();
  }

  // Timers and the countdown move even when no event arrives.
  tickTimer = window.setInterval(requestRender, TICK_MS);
  followRun(runId, receiveState);
}

/**
 * @param {JobListing[]} jobs
 */
function showPicker(jobs) {
  findElement("empty-state").hidden = false;
  createPickerHeader(findElement("topbar"), jobs, startRun);
}

/**
 * @param {string} message
 */
function showLoadError(message) {
  const empty = findElement("empty-state");
  empty.hidden = false;
  empty.textContent = message;
}

async function main() {
  let jobs = /** @type {JobListing[]} */ ([]);

  try {
    jobs = await fetchJobs();
  } catch (error) {
    showLoadError("Could not load the jobs. Is the server running?");
    return;
  }

  const runId = readRunId();

  if (runId === null) {
    showPicker(jobs);
    return;
  }

  showRun(runId, jobs);
}

main();
