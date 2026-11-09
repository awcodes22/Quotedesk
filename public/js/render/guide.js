// @ts-check
import { clear, el, icon } from "../dom.js";
import { isSelfTestRun, selectCalls } from "../state.js";

/**
 * @typedef {import("./view.js").View} View
 * @typedef {import("../state.js").RunState} RunState
 *
 * @typedef {"done" | "active" | "todo"} GuidePhase
 * @typedef {{ number: number, text: string, phase: GuidePhase }} GuideStep
 * @typedef {"cards" | "head-agent" | null} GuideFocus
 * @typedef {{ visible: boolean, steps: GuideStep[], focus: GuideFocus }} GuideModel
 * @typedef {{ cards: HTMLElement, headAgent: HTMLElement }} GuideTargets
 */

const STEP_TEXTS = [
  "QuoteDesk calls you",
  "You play the front desk",
  "Your quote lands here",
  "The head agent picks the best",
];

// Steps 3 and 4 point at the part of the screen they talk about; the first two happen on the phone.
/** @type {GuideFocus[]} */
const STEP_FOCUS = [null, null, "cards", "head-agent"];

/** @type {GuideModel} */
const HIDDEN_GUIDE = { visible: false, steps: [], focus: null };

/**
 * Read from run events only, so the guide never runs ahead of what actually happened.
 * @param {RunState} state
 * @returns {number} The index of the step the call has reached.
 */
function findReachedStep(state) {
  const call = selectCalls(state)[0];

  if (state.decision !== null) {
    return 3;
  }

  if (call !== undefined && call.quote !== null) {
    return 2;
  }

  if (call !== undefined && call.answeredAt !== null) {
    return 1;
  }

  return 0;
}

/**
 * @param {number} index
 * @param {number} reached
 * @param {boolean} finished
 * @returns {GuidePhase}
 */
function findPhase(index, reached, finished) {
  if (finished || index < reached) {
    return "done";
  }

  if (index === reached) {
    return "active";
  }

  return "todo";
}

/**
 * Only test calls get the guide. It stays after the run ends with every step checked.
 * @param {View} view
 * @returns {GuideModel}
 */
export function selectGuideModel(view) {
  const { state } = view;

  if (isSelfTestRun(state) === false) {
    return HIDDEN_GUIDE;
  }

  const finished = state.finishedAt !== null;
  const reached = findReachedStep(state);
  const steps = STEP_TEXTS.map((text, index) => {
    return { number: index + 1, text, phase: findPhase(index, reached, finished) };
  });
  let focus = null;

  if (finished === false) {
    const reachedFocus = STEP_FOCUS[reached];

    if (reachedFocus !== undefined) {
      focus = reachedFocus;
    }
  }

  return { visible: true, steps, focus };
}

/**
 * @param {GuideStep} step
 * @returns {HTMLElement}
 */
function renderStep(step) {
  let marker = el("span", { class: "guide-marker tabular" }, [String(step.number)]);

  if (step.phase === "done") {
    marker = el("span", { class: "guide-marker" }, [icon("check", 14)]);
  }

  return el("li", { class: `guide-step guide-step-${step.phase}` }, [
    marker,
    el("span", { class: "guide-text" }, [step.text]),
  ]);
}

/**
 * @param {HTMLElement} container
 * @param {GuideTargets} targets The areas a step can point at.
 */
export function createGuide(container, targets) {
  const list = el("ol", { class: "guide-steps" });

  container.appendChild(list);

  /** @param {GuideModel} model */
  function update(model) {
    container.hidden = model.visible === false;
    targets.cards.classList.toggle("guide-focus", model.focus === "cards");
    targets.headAgent.classList.toggle("guide-focus", model.focus === "head-agent");
    clear(list);

    for (const step of model.steps) {
      list.appendChild(renderStep(step));
    }
  }

  return { update };
}
