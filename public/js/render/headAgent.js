// @ts-check
import { clear, el, icon } from "../dom.js";
import { formatClock, formatMoney, pluralize } from "../format.js";
import {
  selectCalls,
  selectHeadAgentPlan,
  selectRanking,
  selectStats,
} from "../state.js";
import { runElapsedMs } from "./view.js";

/**
 * @typedef {import("./view.js").View} View
 * @typedef {import("../state.js").CallState} CallState
 *
 * @typedef {{ label: string, title: string, detail: string }} AgentColumn
 * @typedef {{ live: number, noAnswer: number, ended: number, queued: number }} LineCounts
 * @typedef {{
 *   title: string,
 *   clockLabel: string,
 *   clock: string,
 *   columns: AgentColumn[],
 *   counts: LineCounts,
 *   progressPct: number | null,
 * }} HeadAgentModel
 */

/**
 * @param {CallState[]} calls
 * @returns {LineCounts}
 */
function countLines(calls) {
  const counts = { live: 0, noAnswer: 0, ended: 0, queued: 0 };

  for (const call of calls) {
    if (call.status === "failed") {
      counts.noAnswer += 1;
    } else if (call.status === "ended" || call.status === "skipped") {
      counts.ended += 1;
    } else if (call.status === "queued") {
      counts.queued += 1;
    } else {
      counts.live += 1;
    }
  }

  return counts;
}

/**
 * @param {View} view
 * @returns {AgentColumn}
 */
function buildLeaderColumn(view) {
  const ranking = selectRanking(view.state);
  const leader = ranking[0];
  const runnerUp = ranking[1];

  if (leader === undefined) {
    return { label: "Leader", title: "No quotes yet", detail: "Waiting for the first price" };
  }

  let detail = "Only quote so far";

  if (runnerUp !== undefined) {
    detail = `${formatMoney(runnerUp.gapToLeader)} ahead of ${runnerUp.name}`;
  }

  return {
    label: "Leader",
    title: `${leader.name} ${formatMoney(leader.total)}`,
    detail,
  };
}

/**
 * @param {View} view
 * @returns {{ clockLabel: string, clock: string }}
 */
function buildClock(view) {
  const { deadline, decidedAt, startedAt, finishedAt } = view.state;

  if (finishedAt !== null) {
    return { clockLabel: "Finished in", clock: formatClock(runElapsedMs(view)) };
  }

  if (deadline !== null) {
    return { clockLabel: "Deciding in", clock: formatClock(deadline.deadlineAt - view.now) };
  }

  if (decidedAt !== null && startedAt !== null) {
    return { clockLabel: "Decided at", clock: formatClock(decidedAt - startedAt) };
  }

  return { clockLabel: "Elapsed", clock: formatClock(runElapsedMs(view)) };
}

/**
 * How far the run is toward its decision, rounded so it only redraws when it visibly moves.
 * @param {View} view
 * @returns {number | null}
 */
function findProgressPct(view) {
  const { deadline, decision, startedAt, finishedAt } = view.state;

  if (finishedAt !== null || startedAt === null) {
    return null;
  }

  if (decision !== null || deadline === null) {
    return 100;
  }

  const span = deadline.deadlineAt - startedAt;
  const done = view.now - startedAt;
  const pct = Math.min(100, Math.max(0, (done / span) * 100));
  return Math.round(pct);
}

/**
 * @param {View} view
 * @returns {HeadAgentModel}
 */
export function selectHeadAgentModel(view) {
  const calls = selectCalls(view.state);
  const quoteCount = selectStats(view.state).quoteCount;
  const plan = selectHeadAgentPlan(view.state);
  const clock = buildClock(view);
  const callText = pluralize(calls.length, "call", "calls");
  const quoteText = pluralize(quoteCount, "quote", "quotes");

  return {
    title: `Managing ${callText} · ${quoteText} in`,
    clockLabel: clock.clockLabel,
    clock: clock.clock,
    columns: [
      buildLeaderColumn(view),
      { label: "Doing now", ...plan.doingNow },
      { label: "Next", ...plan.next },
    ],
    counts: countLines(calls),
    progressPct: findProgressPct(view),
  };
}

/**
 * @param {AgentColumn} column
 * @returns {HTMLElement}
 */
function renderColumn(column) {
  return el("div", { class: "agent-column" }, [
    el("span", { class: "agent-column-label" }, [column.label]),
    el("span", { class: "agent-column-title" }, [column.title]),
    el("span", { class: "agent-column-detail" }, [column.detail]),
  ]);
}

/**
 * @param {number} count
 * @param {string} text
 * @param {string} className
 * @returns {HTMLElement}
 */
function renderCount(count, text, className) {
  return el("span", { class: className }, [
    el("strong", { class: "tabular" }, [String(count)]),
    ` ${text}`,
  ]);
}

/**
 * @param {LineCounts} counts
 * @returns {HTMLElement}
 */
function renderCounts(counts) {
  const group = el("div", { class: "agent-counts" }, [
    renderCount(counts.live, "live", "agent-count"),
    renderCount(counts.noAnswer, "no answer", "agent-count agent-count-alert"),
    renderCount(counts.ended, "ended", "agent-count"),
  ]);

  if (counts.queued > 0) {
    group.appendChild(renderCount(counts.queued, "queued", "agent-count"));
  }

  return group;
}

/**
 * @param {HTMLElement} card
 */
export function createHeadAgent(card) {
  const title = el("span", { class: "agent-title" });
  const clockLabel = el("span", { class: "agent-clock-label" });
  const clock = el("span", { class: "agent-clock tabular" });
  const columns = el("div", { class: "agent-columns" });
  const footer = el("div", { class: "agent-footer" });
  const progress = el("div", { class: "agent-progress-fill" });
  const progressTrack = el("div", { class: "agent-progress" }, [progress]);

  card.appendChild(
    el("div", { class: "agent-top" }, [
      el("span", { class: "icon-square" }, [icon("network", 18)]),
      el("div", { class: "agent-heading" }, [
        el("span", { class: "agent-label" }, ["Head agent"]),
        title,
      ]),
      el("div", { class: "agent-clock-group" }, [clockLabel, clock]),
    ]),
  );
  card.appendChild(columns);
  card.appendChild(footer);
  card.appendChild(progressTrack);

  /** @param {HeadAgentModel} model */
  function update(model) {
    title.textContent = model.title;
    clockLabel.textContent = model.clockLabel;
    clock.textContent = model.clock;
    clear(columns);

    for (const column of model.columns) {
      columns.appendChild(renderColumn(column));
    }

    clear(footer);
    footer.appendChild(renderCounts(model.counts));
    footer.appendChild(el("span", { class: "agent-rule" }, ["Lowest total wins"]));

    progressTrack.hidden = model.progressPct === null;

    if (model.progressPct !== null) {
      progress.style.width = `${model.progressPct}%`;
    }
  }

  return { update };
}
