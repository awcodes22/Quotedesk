// @ts-check
import { clear, el, icon } from "../dom.js";
import { capitalize, formatClock, formatMoney, pluralize } from "../format.js";
import {
  isLiveProvider,
  selectCalls,
  selectHeadAgentPlan,
  selectOutcomeLabel,
  selectRanking,
  selectStats,
} from "../state.js";
import { findBusinessNoun, findFieldLabels, findKeyTerm, runElapsedMs } from "./view.js";

/**
 * @typedef {import("./view.js").View} View
 * @typedef {import("../state.js").CallState} CallState
 * @typedef {import("../state.js").RankedQuote} RankedQuote
 *
 * @typedef {{ label: string, title: string, detail: string }} AgentColumn
 * @typedef {{ count: number, text: string, alert: boolean }} FooterCount
 * @typedef {{
 *   finished: boolean,
 *   title: string,
 *   clockLabel: string,
 *   clock: string,
 *   columns: AgentColumn[],
 *   counts: FooterCount[],
 *   progressPct: number | null,
 * }} HeadAgentModel
 */

/**
 * @param {CallState[]} calls
 * @returns {FooterCount[]}
 */
function countLiveLines(calls) {
  let live = 0;
  let noAnswer = 0;
  let ended = 0;
  let queued = 0;

  for (const call of calls) {
    if (call.status === "failed") {
      noAnswer += 1;
    } else if (call.status === "ended" || call.status === "skipped") {
      ended += 1;
    } else if (call.status === "queued") {
      queued += 1;
    } else {
      live += 1;
    }
  }

  const counts = [
    { count: live, text: "live", alert: false },
    { count: noAnswer, text: "no answer", alert: true },
    { count: ended, text: "ended", alert: false },
  ];

  if (queued > 0) {
    counts.push({ count: queued, text: "queued", alert: false });
  }

  return counts;
}

/**
 * @param {View} view
 * @returns {FooterCount[]}
 */
function countFinishedLines(view) {
  const calls = selectCalls(view.state);
  const closed = calls.filter((call) => call.command === "close" && call.commandDelivered === true);
  const noAnswer = calls.filter((call) => call.status === "failed");

  return [
    { count: selectStats(view.state).quoteCount, text: "quotes", alert: false },
    { count: closed.length, text: "closed politely", alert: false },
    { count: noAnswer.length, text: "no answer", alert: true },
  ];
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
function buildLiveModel(view) {
  const calls = selectCalls(view.state);
  const quoteCount = selectStats(view.state).quoteCount;
  const plan = selectHeadAgentPlan(view.state);
  const clock = buildClock(view);
  const callText = pluralize(calls.length, "call", "calls");
  const quoteText = pluralize(quoteCount, "quote", "quotes");

  return {
    finished: false,
    title: `Managing ${callText} · ${quoteText} in`,
    clockLabel: clock.clockLabel,
    clock: clock.clock,
    columns: [
      buildLeaderColumn(view),
      { label: "Doing now", ...plan.doingNow },
      { label: "Next", ...plan.next },
    ],
    counts: countLiveLines(calls),
    progressPct: findProgressPct(view),
  };
}

/**
 * @param {View} view
 * @param {RankedQuote} winner
 * @returns {string}
 */
function describeBooking(view, winner) {
  const outcome = selectOutcomeLabel(view.state);
  const price = formatMoney(winner.total);

  if (isLiveProvider(view.state.provider)) {
    return `Best quote: ${winner.name} at ${price}`;
  }

  if (outcome !== null && outcome.tone === "success") {
    return `Booked ${winner.name} at ${price}`;
  }

  return `Booking not confirmed with ${winner.name} at ${price}`;
}

/**
 * @param {View} view
 * @returns {AgentColumn}
 */
function buildConfirmationColumn(view) {
  const outcome = selectOutcomeLabel(view.state);
  const job = view.state.job;
  const noun = findBusinessNoun(view.listing);
  const confirmed = outcome !== null && outcome.tone === "success";
  let title = "Not confirmed";
  let detail = `Check with the ${noun.singular}`;

  if (confirmed) {
    title = "Booked by phone";
    detail = `${capitalize(noun.singular)} confirmed by phone`;
  }

  if (confirmed && job !== null && job.contact !== undefined) {
    title = `Email to ${job.contact.email}`;
  }

  if (isLiveProvider(view.state.provider)) {
    title = "Not booked";
    detail = "Live calls only gather quotes";
  }

  return { label: "Confirmation", title, detail };
}

/**
 * @param {View} view
 * @returns {HeadAgentModel}
 */
function buildFinishedModel(view) {
  const ranking = selectRanking(view.state);
  const winner = ranking[0];
  const runnerUp = ranking[1];
  const clock = buildClock(view);
  const counts = countFinishedLines(view);

  if (winner === undefined) {
    return {
      finished: true,
      title: "No quotes came in",
      clockLabel: clock.clockLabel,
      clock: clock.clock,
      columns: [],
      counts,
      progressPct: null,
    };
  }

  const term = findKeyTerm(winner.fields, findFieldLabels(view));
  let termText = "";
  let whyDetail = "The only quote";

  if (term !== null) {
    termText = term.text;
  }

  if (runnerUp !== undefined) {
    whyDetail = `${formatMoney(runnerUp.gapToLeader)} under ${runnerUp.name}`;
  }

  return {
    finished: true,
    title: describeBooking(view, winner),
    clockLabel: clock.clockLabel,
    clock: clock.clock,
    columns: [
      { label: "Winner", title: `${winner.name} ${formatMoney(winner.total)}`, detail: termText },
      { label: "Why", title: `Lowest total of ${ranking.length}`, detail: whyDetail },
      buildConfirmationColumn(view),
    ],
    counts,
    progressPct: null,
  };
}

/**
 * @param {View} view
 * @returns {HeadAgentModel}
 */
export function selectHeadAgentModel(view) {
  if (view.state.finishedAt !== null) {
    return buildFinishedModel(view);
  }

  return buildLiveModel(view);
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
 * @param {FooterCount[]} counts
 * @returns {HTMLElement}
 */
function renderCounts(counts) {
  const group = el("div", { class: "agent-counts" });

  for (const item of counts) {
    let className = "agent-count";

    if (item.alert) {
      className = "agent-count agent-count-alert";
    }

    group.appendChild(
      el("span", { class: className }, [
        el("strong", { class: "tabular" }, [String(item.count)]),
        ` ${item.text}`,
      ]),
    );
  }

  return group;
}

/**
 * @param {boolean} finished
 * @returns {Element}
 */
function renderAgentIcon(finished) {
  if (finished) {
    return el("span", { class: "icon-square" }, [icon("check", 18, "var(--win)")]);
  }

  return el("span", { class: "icon-square" }, [icon("network", 18)]);
}

/**
 * @param {HTMLElement} card
 */
export function createHeadAgent(card) {
  const iconSlot = el("span", { class: "agent-icon" });
  const title = el("span", { class: "agent-title" });
  const clockLabel = el("span", { class: "agent-clock-label" });
  const clock = el("span", { class: "agent-clock tabular" });
  const columns = el("div", { class: "agent-columns" });
  const footer = el("div", { class: "agent-footer" });
  const progress = el("div", { class: "agent-progress-fill" });
  const progressTrack = el("div", { class: "agent-progress" }, [progress]);

  card.appendChild(
    el("div", { class: "agent-top" }, [
      iconSlot,
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
    clear(iconSlot);
    iconSlot.appendChild(renderAgentIcon(model.finished));
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
