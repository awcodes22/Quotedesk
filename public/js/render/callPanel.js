// @ts-check
import { clear, el, icon } from "../dom.js";
import { formatPublicPhone } from "../phone.js";
import { formatRating } from "./places.js";
import {
  formatClock,
  formatMoney,
  formatSeconds,
  initials,
  labelFromKey,
} from "../format.js";
import {
  isSelfTestCall,
  selectGettingThrough,
  selectOutcomeLabel,
  selectRanking,
} from "../state.js";
import {
  callElapsedMs,
  describeCallStatus,
  findFieldLabels,
  isLiveRun,
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
 * @typedef {{ label: string, value: string | null, missing: string }} QuoteFieldModel
 * @typedef {{
 *   heading: string,
 *   rank: string,
 *   price: string | null,
 *   emptyPrice: string,
 *   gapText: string,
 *   gapTone: "win" | "alert" | "muted",
 *   fields: QuoteFieldModel[],
 *   notes: string[],
 *   showAllNotes: boolean,
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
 *   audioUrl: string | null,
 * }} TranscriptModel
 * @typedef {{
 *   call: CallCardModel,
 *   quote: QuoteCardModel,
 *   agentSentence: string,
 *   transcript: TranscriptModel,
 *   info: InfoCardModel | null,
 *   brief: BriefRow[] | null,
 * }} CallPanelModel
 * @typedef {{ label: string, value: string }} BriefRow
 * @typedef {{
 *   name: string,
 *   address: string,
 *   phone: string,
 *   phoneHref: string,
 *   rating: string | null,
 *   website: string | null,
 * }} InfoCardModel
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
  const startedAt = view.state.startedAt;

  if (call.endedAt !== null && startedAt !== null) {
    return `Call ended at ${formatClock(call.endedAt - startedAt)}`;
  }

  const timer = formatClock(callElapsedMs(call, view.now));
  const turns = countCallerTurns(call);

  // The transcript only arrives after a live call ends, so there are no turns to count yet.
  if (isLiveRun(view)) {
    return timer;
  }

  if (isTextRun(view) && view.listing !== null) {
    return `${timer} · turn ${turns} of ${view.listing.maxTurns}`;
  }

  return `${timer} · turn ${turns}`;
}

/** @type {Record<"pending" | "success" | "warning", StatusText["tone"]>} */
const OUTCOME_TONES = { pending: "live", success: "win", warning: "warning" };

/**
 * The winner shows how the booking went instead of the raw line status.
 * @param {View} view
 * @param {CallState} call
 * @returns {StatusText}
 */
function findCallStatus(view, call) {
  const decision = view.state.decision;
  const outcome = selectOutcomeLabel(view.state);
  const isWinner = decision !== null && decision.kind === "commit" && decision.winner.callId === call.callId;

  if (isWinner && outcome !== null) {
    return { text: outcome.text, tone: OUTCOME_TONES[outcome.tone] };
  }

  return describeCallStatus(call.status, isLiveRun(view));
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

  if (isLiveRun(view)) {
    subtitle = "Live phone call";
  }

  // The server only ever sends the masked form, such as +1 ••• ••• ••23.
  if (isLiveRun(view) && call.maskedPhone !== null) {
    subtitle = `Live phone call · ${call.maskedPhone}`;
  }

  return {
    name: call.name,
    initials: initials(call.name),
    subtitle,
    status: findCallStatus(view, call),
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
 * A finished call that never quoted won't get a price, so it stops saying "yet".
 * @param {CallState} call
 * @returns {string}
 */
export function describeEmptyPrice(call) {
  if (call.endedAt === null) {
    return "No price yet";
  }

  return "No price given";
}

/**
 * On a test call the person answering is the user; on a real live call it is whoever staffs the desk.
 * @param {View} view
 * @param {CallState} call
 * @returns {string}
 */
export function businessSpeakerName(view, call) {
  if (isLiveRun(view) && isSelfTestCall(call)) {
    return "You";
  }

  if (isLiveRun(view)) {
    return "Front desk";
  }

  return call.name;
}

/**
 * While the call is on, a missing field may still come up. Once it has ended, a call with a price
 * simply never mentioned the field, and a call without one never got far enough to ask.
 * @param {CallState} call
 * @returns {string}
 */
export function describeMissingField(call) {
  if (call.endedAt === null) {
    return "Not asked yet";
  }

  if (call.quote !== null) {
    return "Not mentioned";
  }

  return "Not asked";
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
  const missing = describeMissingField(call);

  if (call.quote !== null) {
    fields = call.quote.fields;
    total = formatMoney(call.quote.total);
  }

  const models = [{ label: "Total", value: total, missing }];

  for (const key of Object.keys(findFieldLabels(view))) {
    models.push({ label: labelFromKey(key), value: formatFieldValue(fields[key]), missing });
  }

  return models;
}

/**
 * @param {RankedQuote | undefined} ranked
 * @param {boolean} decided
 * @returns {{ gapText: string, gapTone: QuoteCardModel["gapTone"] }}
 */
function describeGap(ranked, decided) {
  if (ranked === undefined) {
    return { gapText: "", gapTone: "muted" };
  }

  const saving = ranked.firstTotal - ranked.total;

  if (ranked.rank === 1 && saving > 0) {
    return { gapText: `${formatMoney(saving)} less than first quote`, gapTone: "win" };
  }

  if (ranked.rank === 1 && decided) {
    return { gapText: "Lowest total", gapTone: "win" };
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
    emptyPrice: describeEmptyPrice(call),
    ...describeGap(ranked, view.state.decision !== null),
    fields: buildQuoteFields(view, call),
    notes: call.notes,
    showAllNotes: isLiveRun(view),
  };
}

/**
 * Live calls hang up on their own and never book, so nothing here was closed or booked.
 * @param {View} view
 * @param {CallState} call
 * @param {RankedQuote | undefined} ranked
 * @returns {string}
 */
function describeLiveAfterDecision(view, call, ranked) {
  const decision = view.state.decision;

  if (decision !== null && decision.kind === "commit" && decision.winner.callId === call.callId) {
    return "Lowest total, so it's the best quote.";
  }

  if (ranked !== undefined) {
    return `${formatMoney(ranked.gapToLeader)} above the best quote.`;
  }

  return "The call ended without a price.";
}

/**
 * @param {View} view
 * @param {CallState} call
 * @param {RankedQuote | undefined} ranked
 * @returns {string}
 */
function describeAfterDecision(view, call, ranked) {
  const decision = view.state.decision;

  if (isLiveRun(view)) {
    return describeLiveAfterDecision(view, call, ranked);
  }

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

  if (ranked !== undefined && ranked.rank === 1 && isLiveRun(view)) {
    return `Leading. Best quote if nothing beats ${formatMoney(ranked.total)}.`;
  }

  if (ranked !== undefined && ranked.rank === 1) {
    return `Leading. Wins if nothing beats ${formatMoney(ranked.total)}.`;
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
 * @param {import("../state.js").TurnMark} mark
 * @returns {MarkModel}
 */
function describeMark(mark) {
  if (mark.kind === "note") {
    return { kind: "note", text: "Note saved" };
  }

  if (mark.lower) {
    return { kind: "lower", text: `Lower price recorded: ${formatMoney(mark.total)}` };
  }

  return { kind: "price", text: `Price recorded: ${formatMoney(mark.total)}` };
}

/**
 * A live call saves all its notes at once, so they collapse into one line such as "4 notes saved",
 * shown where the first one landed. A repeated identical mark also shows once.
 * @param {Turn} turn
 * @returns {MarkModel[]}
 */
export function buildMarks(turn) {
  const noteCount = turn.marks.filter((mark) => mark.kind === "note").length;
  /** @type {MarkModel[]} */
  const marks = [];
  let notesShown = false;

  for (const mark of turn.marks) {
    const described = describeMark(mark);
    const previous = marks[marks.length - 1];
    const repeatsPrevious = previous !== undefined && previous.text === described.text;

    if (mark.kind === "note" && notesShown === false && noteCount > 1) {
      marks.push({ kind: "note", text: `${noteCount} notes saved` });
      notesShown = true;
    } else if (mark.kind === "note" && notesShown === false) {
      marks.push(described);
      notesShown = true;
    } else if (mark.kind !== "note" && repeatsPrevious === false) {
      marks.push(described);
    }
  }

  return marks;
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

  if (isLiveRun(view)) {
    sourceLabel = "Live call · recorded";
  }

  if (dialedAt === null) {
    dialedAt = 0;
  }

  const steps = selectGettingThrough(call).map((step) => {
    return `Answered ${formatSeconds(step.afterMs)}`;
  });

  if (isLiveRun(view) && call.endedAt === null) {
    steps.push("The transcript arrives when the call ends");
  }

  let typingName = findTypingName(call);

  // Nothing is typed on a live call; the whole transcript lands at the end.
  if (isLiveRun(view)) {
    typingName = null;
  }

  const turns = call.turns.map((turn) => {
    let name = AGENT_NAME;

    if (turn.speaker === "business") {
      name = businessSpeakerName(view, call);
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
    typingName,
    audioUrl: findAudioUrl(view, call),
  };
}

/**
 * Only a live call that ended normally has a recording.
 * @param {View} view
 * @param {CallState} call
 * @returns {string | null}
 */
function findAudioUrl(view, call) {
  const runId = view.state.runId;

  if (isLiveRun(view) === false || call.status !== "ended" || runId === null) {
    return null;
  }

  return `/api/runs/${encodeURIComponent(runId)}/calls/${encodeURIComponent(call.callId)}/audio`;
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
    info: buildInfoCard(call),
    brief: buildBriefRows(view, call),
  };
}

/**
 * Only a hotel found through Google Places has a public listing. Its number is shown in full
 * because anyone can look it up; a test number or a private job's number never gets here.
 * @param {CallState} call
 * @returns {InfoCardModel | null}
 */
export function buildInfoCard(call) {
  const listing = call.listing;

  if (listing === null) {
    return null;
  }

  return {
    name: call.name,
    address: listing.address,
    phone: formatPublicPhone(listing.phone),
    phoneHref: `tel:${listing.phone}`,
    rating: formatRating(listing.rating, listing.reviewCount),
    website: listing.website,
  };
}

/**
 * @param {HTMLElement} card
 * @param {InfoCardModel | null} model
 */
function renderInfoCard(card, model) {
  clear(card);
  card.hidden = model === null;

  if (model === null) {
    return;
  }

  card.appendChild(el("span", { class: "section-label" }, ["HOTEL"]));
  card.appendChild(el("span", { class: "call-card-name" }, [model.name]));
  card.appendChild(el("span", { class: "info-line" }, [icon("map-pin", 14), model.address]));
  card.appendChild(
    el("span", { class: "info-line tabular" }, [icon("phone", 14), el("a", { href: model.phoneHref }, [model.phone])]),
  );

  if (model.rating !== null) {
    card.appendChild(el("span", { class: "info-line" }, [icon("star", 14), model.rating]));
  }

  if (model.website !== null) {
    card.appendChild(
      el("span", { class: "info-line" }, [
        el("a", { href: model.website, target: "_blank", rel: "noopener noreferrer" }, ["Website"]),
      ]),
    );
  }
}

// Only these are shown, in this order. The budget and any phone number are never among them.
const BRIEF_LABELS = [
  { key: "request", label: "Request" },
  { key: "dates", label: "Dates" },
  { key: "ask_about", label: "Asks about" },
  { key: "guest_name", label: "Guest name" },
  { key: "call_mode", label: "Call mode" },
];

/** @type {Record<string, string>} */
const CALL_MODE_NAMES = { live: "Real call script (live)", test: "Tutorial (test)" };

/**
 * What the agent was told for this call, for live runs only.
 * @param {View} view
 * @param {CallState} call
 * @returns {BriefRow[] | null}
 */
export function buildBriefRows(view, call) {
  if (isLiveRun(view) === false || call.brief === null) {
    return null;
  }

  const brief = call.brief;
  /** @type {BriefRow[]} */
  const rows = [];

  for (const { key, label } of BRIEF_LABELS) {
    const value = brief[key];

    if (value !== undefined) {
      let shown = value;
      const modeName = CALL_MODE_NAMES[value];

      if (key === "call_mode" && modeName !== undefined) {
        shown = modeName;
      }

      rows.push({ label, value: shown });
    }
  }

  return rows;
}

/**
 * Collapsed by default, since it is for checking the setup rather than reading every call.
 * @param {HTMLElement} card
 * @param {BriefRow[] | null} rows
 */
function renderBriefCard(card, rows) {
  clear(card);
  card.hidden = rows === null;

  if (rows === null) {
    return;
  }

  const list = el("dl", { class: "brief-list" });

  for (const row of rows) {
    list.appendChild(el("dt", {}, [row.label]));
    list.appendChild(el("dd", {}, [row.value]));
  }

  card.appendChild(el("details", {}, [el("summary", { class: "section-label" }, ["Sent to the agent"]), list]));
}

/**
 * @param {StatusText} status
 * @returns {Element}
 */
function renderStatusMarker(status) {
  if (status.tone === "win") {
    return icon("check", 14);
  }

  return el("span", { class: "status-dot" });
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
        renderStatusMarker(model.status),
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
      el("span", { class: "quote-field-missing" }, [field.missing]),
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
 * A live call's notes all arrive together when it ends and are few, so they fit as a short list.
 * @param {string[]} notes
 * @returns {HTMLElement}
 */
function renderNoteList(notes) {
  const items = notes.map((note) => el("li", { class: "quote-note-text" }, [note]));

  return el("div", { class: "quote-note quote-note-list" }, [
    icon("file-text", 16),
    el("div", {}, [
      el("span", { class: "quote-note-label" }, ["Notes"]),
      el("ul", {}, items),
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

  let price = el("span", { class: "quote-price quote-price-empty" }, [model.emptyPrice]);

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

  if (model.showAllNotes && model.notes.length > 0) {
    body.appendChild(renderNoteList(model.notes));
    card.appendChild(body);
    return;
  }

  // Only the newest note fits next to the transcript; the rest stay in the transcript itself.
  const latestNote = model.notes[model.notes.length - 1];

  if (latestNote !== undefined) {
    const note = el("div", { class: "quote-note" }, [
      icon("file-text", 16),
      el("span", { class: "quote-note-label" }, ["Note:"]),
      el("span", { class: "quote-note-text" }, [latestNote]),
    ]);
    const earlierCount = model.notes.length - 1;

    if (earlierCount > 0) {
      note.appendChild(el("span", { class: "quote-note-more" }, [`+${earlierCount} earlier`]));
    }

    body.appendChild(note);
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
 * One button that plays or pauses the selected call's recording.
 * The audio loads on the first press, so browsing calls downloads nothing.
 */
function createRecordingPlayer() {
  const label = el("span", {}, ["Play recording"]);
  const button = el("button", { class: "button button-small", type: "button" }, [icon("headphones", 14), label]);
  /** @type {HTMLAudioElement | null} */
  let audio = null;
  /** @type {string | null} */
  let currentUrl = null;

  /** @param {string} text */
  function showLabel(text) {
    label.textContent = text;
  }

  function stop() {
    if (audio !== null) {
      audio.pause();
    }

    audio = null;
    button.disabled = false;
    showLabel("Play recording");
  }

  /** @param {string} url */
  function load(url) {
    const loaded = new Audio(url);
    loaded.addEventListener("ended", () => showLabel("Play recording"));
    loaded.addEventListener("error", () => {
      showLabel("Recording unavailable");
      button.disabled = true;
    });
    return loaded;
  }

  function toggle() {
    if (currentUrl === null) {
      return;
    }

    if (audio === null) {
      audio = load(currentUrl);
    }

    if (audio.paused) {
      audio.play().catch(() => showLabel("Recording unavailable"));
      showLabel("Pause");
    } else {
      audio.pause();
      showLabel("Play recording");
    }
  }

  /** @param {string | null} url */
  function update(url) {
    if (url !== currentUrl) {
      stop();
      currentUrl = url;
    }

    button.hidden = url === null;
  }

  button.addEventListener("click", toggle);
  button.hidden = true;
  return { button, update };
}

/**
 * @param {HTMLElement} card
 */
function createTranscript(card) {
  const source = el("span", { class: "panel-card-rank" });
  const steps = el("div", { class: "transcript-steps" });
  const list = el("ol", { class: "transcript-list" });
  const player = createRecordingPlayer();
  /** @type {{ node: HTMLElement, key: string }[]} */
  let renderedTurns = [];
  /** @type {HTMLElement | null} */
  let typingNode = null;
  let renderedCallId = "";
  let stickToBottom = true;

  card.appendChild(
    el("div", { class: "panel-card-header" }, [
      el("span", { class: "section-label" }, ["TRANSCRIPT"]),
      el("span", { class: "transcript-source" }, [player.button, source]),
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
    player.update(model.audioUrl);
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
  const infoCard = el("section", { class: "card panel-card info-card", "aria-label": "Hotel details" });
  const briefCard = el("section", { class: "card panel-card brief-card" });
  const transcript = createTranscript(transcriptCard);
  const lastKeys = { call: "", quote: "", agent: "", transcript: "", info: "", brief: "" };

  panel.appendChild(callCard);
  panel.appendChild(infoCard);
  panel.appendChild(briefCard);
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

    const infoKey = JSON.stringify(model.info);
    const briefKey = JSON.stringify(model.brief);

    if (briefKey !== lastKeys.brief) {
      lastKeys.brief = briefKey;
      renderBriefCard(briefCard, model.brief);
    }

    if (infoKey !== lastKeys.info) {
      lastKeys.info = infoKey;
      renderInfoCard(infoCard, model.info);
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
