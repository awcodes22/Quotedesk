// @ts-check
import { clear, el, icon } from "../dom.js";
import {
  formatClock,
  formatMoney,
  formatSeconds,
  initials,
  labelFromKey,
} from "../format.js";
import { selectGettingThrough, selectOutcomeLabel, selectRanking } from "../state.js";
import {
  callElapsedMs,
  describeCallStatus,
  findFieldLabels,
  isTextRun,
} from "./view.js";

/**
 * @typedef {import("./view.js").View} View
 * @typedef {import("./view.js").StatusText} StatusText
 * @typedef {import("../state.js").CallState} CallState
 * @typedef {import("../state.js").RankedQuote} RankedQuote
 * @typedef {import("../state.js").Turn} Turn
 * @typedef {import("../icons.js").IconName} IconName
 *
 * @typedef {"text"} TranscriptMode
 *
 * @typedef {{ name: string, initials: string, subtitle: string, status: StatusText, meta: string }} CallCardModel
 * @typedef {{ label: string, value: string | null }} QuoteFieldModel
 * @typedef {{
 *   heading: string,
 *   rank: string,
 *   price: string | null,
 *   gapText: string,
 *   gapTone: "win" | "alert" | "muted",
 *   fields: QuoteFieldModel[],
 *   notes: string[],
 * }} QuoteCardModel
 * @typedef {{ kind: "price" | "lower" | "note", text: string }} MarkModel
 * @typedef {{
 *   speaker: "agent" | "business",
 *   name: string,
 *   time: string,
 *   text: string,
 *   marks: MarkModel[],
 * }} TurnModel
 * @typedef {{
 *   callId: string,
 *   mode: TranscriptMode,
 *   sourceLabel: string,
 *   steps: string[],
 *   turns: TurnModel[],
 *   typingName: string | null,
 * }} TranscriptModel
 * @typedef {{
 *   call: CallCardModel,
 *   quote: QuoteCardModel,
 *   agentSentence: string,
 *   transcript: TranscriptModel,
 * }} CallPanelModel
 */

const AGENT_NAME = "AI caller";
const STICK_TO_BOTTOM_PX = 24;
const TOP_COUNT = 4;

/** @type {import("../../../src/core/types").CallStatus[]} */
const OPEN_STATUSES = ["talking", "quoted", "committed", "closed"];

/**
 * @param {CallState} call
 * @returns {number}
 */
function countCallerTurns(call) {
  return call.turns.filter((turn) => turn.speaker === "agent").length;
}

/**
 * Fake calls have no turn limit, so only text runs show one.
 * @param {View} view
 * @param {CallState} call
 * @returns {string}
 */
function buildCallMeta(view, call) {
  const timer = formatClock(callElapsedMs(call, view.now));
  const turns = countCallerTurns(call);

  if (isTextRun(view) && view.listing !== null) {
    return `${timer} · turn ${turns} of ${view.listing.maxTurns}`;
  }

  return `${timer} · turn ${turns}`;
}

/**
 * @param {View} view
 * @param {CallState} call
 * @returns {CallCardModel}
 */
function buildCallCard(view, call) {
  let subtitle = "Scripted fake call";

  if (isTextRun(view)) {
    subtitle = "Simulated front desk";
  }

  return {
    name: call.name,
    initials: initials(call.name),
    subtitle,
    status: describeCallStatus(call.status),
    meta: buildCallMeta(view, call),
  };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function formatFieldValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (value === true) {
    return "Yes";
  }

  if (value === false) {
    return "No";
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  return null;
}

/**
 * Total first, then every field the industry names, answered or not.
 * @param {View} view
 * @param {CallState} call
 * @returns {QuoteFieldModel[]}
 */
function buildQuoteFields(view, call) {
  let fields = /** @type {Record<string, unknown>} */ ({});
  let total = null;

  if (call.quote !== null) {
    fields = call.quote.fields;
    total = formatMoney(call.quote.total);
  }

  const models = [{ label: "Total", value: total }];

  for (const key of Object.keys(findFieldLabels(view))) {
    models.push({ label: labelFromKey(key), value: formatFieldValue(fields[key]) });
  }

  return models;
}

/**
 * @param {RankedQuote | undefined} ranked
 * @returns {{ gapText: string, gapTone: QuoteCardModel["gapTone"] }}
 */
function describeGap(ranked) {
  if (ranked === undefined) {
    return { gapText: "", gapTone: "muted" };
  }

  const saving = ranked.firstTotal - ranked.total;

  if (ranked.rank === 1 && saving > 0) {
    return { gapText: `${formatMoney(saving)} less than first quote`, gapTone: "win" };
  }

  if (ranked.rank === 1) {
    return { gapText: "Lowest so far", gapTone: "win" };
  }

  return { gapText: `${formatMoney(ranked.gapToLeader)} above the leader`, gapTone: "alert" };
}

/**
 * @param {View} view
 * @param {CallState} call
 * @param {RankedQuote[]} ranking
 * @returns {QuoteCardModel}
 */
function buildQuoteCard(view, call, ranking) {
  const ranked = ranking.find((quote) => quote.callId === call.callId);
  let heading = "QUOTE SO FAR";
  let rank = "";
  let price = null;

  if (view.state.decision !== null) {
    heading = "FINAL QUOTE";
  }

  if (ranked !== undefined) {
    rank = `#${ranked.rank} of ${ranking.length}`;
    price = formatMoney(ranked.total);
  }

  return {
    heading,
    rank,
    price,
    ...describeGap(ranked),
    fields: buildQuoteFields(view, call),
    notes: call.notes,
  };
}

/**
 * @param {View} view
 * @param {CallState} call
 * @param {RankedQuote | undefined} ranked
 * @returns {string}
 */
function describeAfterDecision(view, call, ranked) {
  const decision = view.state.decision;

  if (decision !== null && decision.kind === "commit" && decision.winner.callId === call.callId) {
    const outcome = selectOutcomeLabel(view.state);
    let outcomeText = "Booking it now.";

    if (outcome !== null) {
      outcomeText = `${outcome.text}.`;
    }

    return `Lowest total, so it won. ${outcomeText}`;
  }

  if (ranked !== undefined) {
    return `Closed politely, ${formatMoney(ranked.gapToLeader)} above the winner.`;
  }

  return "Closed before it gave a price.";
}

/**
 * Says where this call stands, from the ranking alone.
 * @param {View} view
 * @param {CallState} call
 * @param {RankedQuote[]} ranking
 * @returns {string}
 */
function describeStanding(view, call, ranking) {
  const ranked = ranking.find((quote) => quote.callId === call.callId);
  const fourth = ranking[TOP_COUNT - 1];

  if (call.status === "failed") {
    return "No answer, so this line is out.";
  }

  if (view.state.decision !== null) {
    return describeAfterDecision(view, call, ranked);
  }

  if (ranked !== undefined && ranked.rank === 1) {
    return `Leading. Booked if nothing beats ${formatMoney(ranked.total)}.`;
  }

  if (ranked !== undefined && ranked.rank <= TOP_COUNT) {
    return `Inside the top 4, ${formatMoney(ranked.gapToLeader)} behind the leader.`;
  }

  if (fourth === undefined) {
    return "No price yet. Any price puts it in the top 4.";
  }

  if (ranked !== undefined) {
    return `Outside the top 4. Closed unless it beats ${formatMoney(fourth.total)}.`;
  }

  return `No price yet. Closed unless it beats ${formatMoney(fourth.total)}.`;
}

/**
 * @param {Turn} turn
 * @returns {MarkModel[]}
 */
function buildMarks(turn) {
  return turn.marks.map((mark) => {
    if (mark.kind === "note") {
      return { kind: "note", text: "Note saved" };
    }

    if (mark.lower) {
      return { kind: "lower", text: `Lower price recorded: ${formatMoney(mark.total)}` };
    }

    return { kind: "price", text: `Price recorded: ${formatMoney(mark.total)}` };
  });
}

/**
 * The next speaker is whoever didn't speak last, while the line is still open.
 * @param {CallState} call
 * @returns {string | null}
 */
function findTypingName(call) {
  if (OPEN_STATUSES.includes(call.status) === false) {
    return null;
  }

  const lastTurn = call.turns[call.turns.length - 1];

  if (lastTurn !== undefined && lastTurn.speaker === "agent") {
    return call.name;
  }

  return AGENT_NAME;
}

/**
 * @param {View} view
 * @param {CallState} call
 * @returns {TranscriptModel}
 */
function buildTranscript(view, call) {
  let sourceLabel = "Scripted fake call · no audio";
  let dialedAt = call.dialedAt;

  if (isTextRun(view)) {
    sourceLabel = "Text simulation · no audio";
  }

  if (dialedAt === null) {
    dialedAt = 0;
  }

  const steps = selectGettingThrough(call).map((step) => {
    return `Answered ${formatSeconds(step.afterMs)}`;
  });

  const turns = call.turns.map((turn) => {
    let name = AGENT_NAME;

    if (turn.speaker === "business") {
      name = call.name;
    }

    return {
      speaker: turn.speaker,
      name,
      time: formatClock(turn.at - dialedAt),
      text: turn.text,
      marks: buildMarks(turn),
    };
  });

  return {
    callId: call.callId,
    mode: "text",
    sourceLabel,
    steps,
    turns,
    typingName: findTypingName(call),
  };
}

/**
 * @param {View} view
 * @param {CallState} call
 * @returns {CallPanelModel}
 */
export function selectCallPanelModel(view, call) {
  const ranking = selectRanking(view.state);

  return {
    call: buildCallCard(view, call),
    quote: buildQuoteCard(view, call, ranking),
    agentSentence: describeStanding(view, call, ranking),
    transcript: buildTranscript(view, call),
  };
}

/**
 * @param {HTMLElement} card
 * @param {CallCardModel} model
 */
function renderCallCard(card, model) {
  clear(card);
  card.appendChild(el("span", { class: "avatar avatar-lg" }, [model.initials]));
  card.appendChild(
    el("div", { class: "call-card-names" }, [
      el("span", { class: "call-card-name" }, [model.name]),
      el("span", { class: "call-card-subtitle" }, [model.subtitle]),
    ]),
  );
  card.appendChild(
    el("div", { class: "call-card-status" }, [
      el("span", { class: `status-text tone-${model.status.tone}` }, [
        el("span", { class: "status-dot" }),
        model.status.text,
      ]),
      el("span", { class: "call-card-meta tabular" }, [model.meta]),
    ]),
  );
}

/**
 * @param {QuoteFieldModel} field
 * @returns {HTMLElement}
 */
function renderQuoteField(field) {
  if (field.value === null) {
    return el("div", { class: "quote-field" }, [
      el("span", { class: "quote-field-label" }, [field.label]),
      el("span", { class: "quote-field-missing" }, ["Not asked yet"]),
    ]);
  }

  return el("div", { class: "quote-field" }, [
    el("span", { class: "quote-field-label" }, [field.label]),
    el("span", { class: "quote-field-value tabular" }, [
      field.value,
      icon("check", 16, "var(--win)"),
    ]),
  ]);
}

/**
 * @param {HTMLElement} card
 * @param {QuoteCardModel} model
 */
function renderQuoteCard(card, model) {
  clear(card);
  card.appendChild(
    el("div", { class: "panel-card-header" }, [
      el("span", { class: "section-label" }, [model.heading]),
      el("span", { class: "panel-card-rank tabular" }, [model.rank]),
    ]),
  );

  let price = el("span", { class: "quote-price quote-price-empty" }, ["No price yet"]);

  if (model.price !== null) {
    price = el("span", { class: "quote-price tabular" }, [model.price]);
  }

  const fields = el("div", { class: "quote-fields" });

  for (const field of model.fields) {
    fields.appendChild(renderQuoteField(field));
  }

  const body = el("div", { class: "quote-body" }, [
    el("div", { class: "quote-price-line" }, [
      price,
      el("span", { class: `quote-gap tone-${model.gapTone}` }, [model.gapText]),
    ]),
    fields,
  ]);

  for (const note of model.notes) {
    body.appendChild(
      el("div", { class: "quote-note" }, [
        icon("file-text", 16),
        el("span", { class: "quote-note-label" }, ["Note:"]),
        el("span", { class: "quote-note-text" }, [note]),
      ]),
    );
  }

  card.appendChild(body);
}

/**
 * @param {HTMLElement} card
 * @param {string} sentence
 */
function renderAgentCard(card, sentence) {
  clear(card);
  card.appendChild(el("span", { class: "icon-square" }, [icon("network", 18)]));
  card.appendChild(
    el("div", { class: "panel-agent-text" }, [
      el("span", { class: "agent-label" }, ["Head agent"]),
      el("span", { class: "panel-agent-sentence" }, [sentence]),
    ]),
  );
}

/** @type {Record<MarkModel["kind"], IconName>} */
const MARK_ICONS = { price: "tag", lower: "arrow-down", note: "file-text" };

/**
 * @param {"agent" | "business"} speaker
 * @returns {HTMLElement}
 */
function renderSpeakerTag(speaker) {
  if (speaker === "agent") {
    return el("span", { class: "speaker-tag speaker-agent" }, ["AI"]);
  }

  return el("span", { class: "speaker-tag speaker-business" }, ["H"]);
}

/**
 * Voice runs will add audio controls here, so the mode is passed in from the start.
 * @param {TurnModel} turn
 * @param {TranscriptMode} mode
 * @returns {HTMLElement}
 */
function renderTurn(turn, mode) {
  const body = el("div", { class: "turn-body" }, [
    el("div", { class: "turn-head" }, [
      el("span", { class: `turn-name turn-name-${turn.speaker}` }, [turn.name]),
      el("span", { class: "turn-time tabular" }, [turn.time]),
    ]),
    el("p", { class: "turn-text" }, [turn.text]),
  ]);

  for (const mark of turn.marks) {
    body.appendChild(
      el("span", { class: `turn-mark turn-mark-${mark.kind}` }, [
        icon(MARK_ICONS[mark.kind], 14),
        mark.text,
      ]),
    );
  }

  return el("li", { class: `turn turn-${mode}` }, [renderSpeakerTag(turn.speaker), body]);
}

/**
 * @param {string} name
 * @returns {HTMLElement}
 */
function renderTyping(name) {
  let speaker = /** @type {"agent" | "business"} */ ("business");

  if (name === AGENT_NAME) {
    speaker = "agent";
  }

  return el("li", { class: "turn turn-typing" }, [
    renderSpeakerTag(speaker),
    el("span", { class: "typing-dots", "aria-hidden": "true" }, [
      el("span"),
      el("span"),
      el("span"),
    ]),
    el("span", { class: "typing-text" }, [`${name} is typing`]),
  ]);
}

/**
 * @param {HTMLElement} card
 */
function createTranscript(card) {
  const source = el("span", { class: "panel-card-rank" });
  const steps = el("div", { class: "transcript-steps" });
  const list = el("ol", { class: "transcript-list" });
  /** @type {{ node: HTMLElement, key: string }[]} */
  let renderedTurns = [];
  /** @type {HTMLElement | null} */
  let typingNode = null;
  let renderedCallId = "";
  let stickToBottom = true;

  card.appendChild(
    el("div", { class: "panel-card-header" }, [
      el("span", { class: "section-label" }, ["TRANSCRIPT"]),
      source,
    ]),
  );
  card.appendChild(steps);
  card.appendChild(list);

  // Reading older turns stops the jump to the newest one until the reader scrolls back down.
  list.addEventListener("scroll", () => {
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    stickToBottom = distance < STICK_TO_BOTTOM_PX;
  });

  /** @param {string[]} stepTexts */
  function renderSteps(stepTexts) {
    clear(steps);
    steps.hidden = stepTexts.length === 0;

    if (stepTexts.length > 0) {
      steps.appendChild(icon("phone", 14));
      steps.appendChild(el("span", {}, [stepTexts.join(" · ")]));
    }
  }

  function resetList() {
    clear(list);
    renderedTurns = [];
    typingNode = null;
    stickToBottom = true;
  }

  // Turns only ever get added, and only the newest can gain a mark, so most frames touch nothing.
  /** @param {TranscriptModel} model */
  function renderTurns(model) {
    model.turns.forEach((turn, index) => {
      const key = JSON.stringify(turn);
      const rendered = renderedTurns[index];

      if (rendered === undefined) {
        const node = renderTurn(turn, model.mode);
        list.insertBefore(node, typingNode);
        renderedTurns.push({ node, key });
      } else if (rendered.key !== key) {
        const node = renderTurn(turn, model.mode);
        list.replaceChild(node, rendered.node);
        renderedTurns[index] = { node, key };
      }
    });
  }

  /** @param {string | null} typingName */
  function renderTypingRow(typingName) {
    if (typingNode !== null) {
      list.removeChild(typingNode);
      typingNode = null;
    }

    if (typingName !== null) {
      typingNode = renderTyping(typingName);
      list.appendChild(typingNode);
    }
  }

  /** @param {TranscriptModel} model */
  function update(model) {
    if (model.callId !== renderedCallId) {
      renderedCallId = model.callId;
      resetList();
    }

    source.textContent = model.sourceLabel;
    renderSteps(model.steps);
    renderTurns(model);
    renderTypingRow(model.typingName);

    if (stickToBottom) {
      list.scrollTop = list.scrollHeight;
    }
  }

  return { update };
}

/**
 * Each card redraws on its own, so a ticking timer doesn't rebuild the transcript.
 * @param {HTMLElement} panel
 */
export function createCallPanel(panel) {
  const callCard = el("section", { class: "card panel-card call-card" });
  const quoteCard = el("section", { class: "card panel-card quote-card" });
  const agentCard = el("section", { class: "card panel-card panel-agent" });
  const transcriptCard = el("section", { class: "card panel-card transcript-card" });
  const transcript = createTranscript(transcriptCard);
  const lastKeys = { call: "", quote: "", agent: "", transcript: "" };

  panel.appendChild(callCard);
  panel.appendChild(quoteCard);
  panel.appendChild(agentCard);
  panel.appendChild(transcriptCard);

  /** @param {CallPanelModel} model */
  function update(model) {
    const callKey = JSON.stringify(model.call);
    const quoteKey = JSON.stringify(model.quote);
    const transcriptKey = JSON.stringify(model.transcript);

    if (callKey !== lastKeys.call) {
      lastKeys.call = callKey;
      renderCallCard(callCard, model.call);
    }

    if (quoteKey !== lastKeys.quote) {
      lastKeys.quote = quoteKey;
      renderQuoteCard(quoteCard, model.quote);
    }

    if (model.agentSentence !== lastKeys.agent) {
      lastKeys.agent = model.agentSentence;
      renderAgentCard(agentCard, model.agentSentence);
    }

    if (transcriptKey !== lastKeys.transcript) {
      lastKeys.transcript = transcriptKey;
      transcript.update(model.transcript);
    }
  }

  return { update };
}
