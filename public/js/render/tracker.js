// @ts-check
import { clear, el, icon } from "../dom.js";
import { selectRunStatus, selectStats } from "../state.js";

/**
 * @typedef {import("./view.js").View} View
 * @typedef {import("../state.js").RunStatus} RunStatus
 *
 * @typedef {"done" | "current" | "future"} StepPhase
 * @typedef {{ text: string, count: string | null, phase: StepPhase }} TrackerStep
 * @typedef {{ label: string, steps: TrackerStep[] }} TrackerModel
 */

/** @type {{ status: RunStatus, text: string }[]} */
const STEPS = [
  { status: "calling", text: "Calling" },
  { status: "quotes", text: "Quotes" },
  { status: "deciding", text: "Deciding" },
  { status: "booking", text: "Booking" },
  { status: "done", text: "Done" },
];

const VIEW_OPTIONS = ["Diagram", "Top 4 + grid", "Table"];
const WORKING_VIEW = "Top 4 + grid";

/**
 * @param {number} index
 * @param {number} currentIndex
 * @param {boolean} finished
 * @returns {StepPhase}
 */
function findPhase(index, currentIndex, finished) {
  if (index < currentIndex || finished) {
    return "done";
  }

  if (index === currentIndex) {
    return "current";
  }

  return "future";
}

/**
 * @param {View} view
 * @returns {TrackerModel}
 */
export function selectTrackerModel(view) {
  const status = selectRunStatus(view.state);
  const finished = status === "done";
  const currentIndex = STEPS.findIndex((step) => step.status === status);
  const quoteCount = selectStats(view.state).quoteCount;
  const callCount = view.state.callOrder.length;

  const steps = STEPS.map((step, index) => {
    let count = null;

    if (step.status === "quotes") {
      count = `${quoteCount}/${callCount}`;
    }

    return { text: step.text, count, phase: findPhase(index, currentIndex, finished) };
  });

  let label = "LIVE CALLS";

  if (finished) {
    label = "RUN COMPLETE";
  }

  return { label, steps };
}

/**
 * @param {StepPhase} phase
 * @returns {Element}
 */
function renderStepMarker(phase) {
  if (phase === "done") {
    return icon("check", 14);
  }

  return el("span", { class: `step-dot step-dot-${phase}` });
}

/**
 * @param {TrackerStep} step
 * @returns {HTMLElement}
 */
function renderStep(step) {
  let count = null;

  if (step.count !== null) {
    count = el("span", { class: "step-count tabular" }, [step.count]);
  }

  return el("li", { class: `step step-${step.phase}` }, [
    renderStepMarker(step.phase),
    el("span", {}, [step.text]),
    count,
  ]);
}

/** @returns {HTMLElement} */
function renderViewToggle() {
  const toggle = el("div", { class: "view-toggle", role: "group", "aria-label": "View" });

  for (const option of VIEW_OPTIONS) {
    const isWorking = option === WORKING_VIEW;
    let title;

    if (isWorking === false) {
      title = "Coming later";
    }

    toggle.appendChild(
      el(
        "button",
        {
          class: "view-toggle-option",
          type: "button",
          "aria-pressed": String(isWorking),
          disabled: isWorking === false,
          title,
        },
        [option],
      ),
    );
  }

  return toggle;
}

/**
 * @param {HTMLElement} container
 */
export function createTracker(container) {
  const label = el("span", { class: "section-label" });
  const steps = el("ol", { class: "steps" });

  container.appendChild(label);
  container.appendChild(steps);
  container.appendChild(renderViewToggle());

  /** @param {TrackerModel} model */
  function update(model) {
    label.textContent = model.label;
    clear(steps);

    for (const step of model.steps) {
      steps.appendChild(renderStep(step));
    }
  }

  return { update };
}
