// @ts-check
import { clear, el, icon } from "../dom.js";
import { formatClock, formatDuration, pluralize } from "../format.js";
import { ICONS } from "../icons.js";
import { findBusinessNoun, runElapsedMs } from "./view.js";

/**
 * @typedef {import("./view.js").View} View
 * @typedef {import("./view.js").JobListing} JobListing
 * @typedef {import("../icons.js").IconName} IconName
 * @typedef {import("../../../src/core/types").Job} Job
 *
 * @typedef {{ icon: IconName | null, label: string, value: string }} RequestField
 * @typedef {{ fields: RequestField[], finished: boolean, elapsed: string }} RunHeaderModel
 * @typedef {{ jobId: string, provider: "fake" | "text", scale?: number }} StartRequest
 * @typedef {{ fields: HTMLElement, right: HTMLElement }} HeaderFrame
 */

/**
 * The server only accepts known icon names, and this keeps the page safe if that ever changes.
 * @param {string | undefined} name
 * @returns {IconName | null}
 */
function findIconName(name) {
  if (name === undefined || Object.hasOwn(ICONS, name) === false) {
    return null;
  }

  return /** @type {IconName} */ (name);
}

/**
 * Skips anything the job doesn't have, so every job gets a header that fits it.
 * @param {Job} job
 * @param {string} industryLabel
 * @param {number} callCount
 * @param {JobListing | null} listing
 * @returns {RequestField[]}
 */
export function buildRequestFields(job, industryLabel, callCount, listing) {
  const noun = findBusinessNoun(listing);

  /** @type {RequestField[]} */
  const fields = [{ icon: "search", label: "Looking for", value: industryLabel }];

  if (job.details !== undefined) {
    for (const detail of job.details) {
      fields.push({ icon: findIconName(detail.icon), label: detail.label, value: detail.value });
    }
  }

  fields.push({
    icon: "phone",
    label: "Calling",
    value: pluralize(callCount, noun.singular, noun.plural),
  });

  if (listing !== null) {
    const decideWithin = formatDuration(listing.decideWithinMs);
    fields.push({ icon: "clock", label: "Decide", value: `Within ${decideWithin}` });
  }

  if (job.contact !== undefined) {
    fields.push({ icon: "user", label: "Booking for", value: job.contact.name });
  }

  return fields;
}

/**
 * @param {View} view
 * @returns {RunHeaderModel}
 */
export function selectRunHeaderModel(view) {
  const { state } = view;
  let fields = /** @type {RequestField[]} */ ([]);

  if (state.job !== null) {
    fields = buildRequestFields(state.job, state.industryLabel, state.callOrder.length, view.listing);
  }

  return {
    fields,
    finished: state.finishedAt !== null,
    elapsed: formatClock(runElapsedMs(view)),
  };
}

/**
 * @param {RequestField} field
 * @returns {HTMLElement}
 */
function renderField(field) {
  let fieldIcon = null;

  if (field.icon !== null) {
    fieldIcon = icon(field.icon, 16);
  }

  return el("div", { class: "request-field" }, [
    fieldIcon,
    el("div", { class: "request-field-text" }, [
      el("span", { class: "request-field-label" }, [field.label]),
      el("span", { class: "request-field-value" }, [field.value]),
    ]),
  ]);
}

/**
 * @param {HTMLElement} container
 * @param {RequestField[]} fields
 */
export function renderFields(container, fields) {
  clear(container);

  for (const field of fields) {
    container.appendChild(renderField(field));
  }
}

/**
 * @param {RunHeaderModel} model
 * @returns {HTMLElement}
 */
function renderRunStatus(model) {
  if (model.finished) {
    return el("div", { class: "run-status" }, [
      icon("check", 16, "var(--win)"),
      el("span", { class: "run-status-label" }, ["Completed"]),
      el("span", { class: "run-status-time tabular" }, [model.elapsed]),
    ]);
  }

  return el("div", { class: "run-status" }, [
    el("span", { class: "live-dot" }),
    el("span", { class: "run-status-label" }, ["Live"]),
    el("span", { class: "run-status-time tabular" }, [model.elapsed]),
  ]);
}

/** @returns {HTMLElement} */
export function renderNewRunButton() {
  return el("a", { class: "button", href: "/" }, ["New run"]);
}

/**
 * @param {HTMLElement} header
 * @returns {HeaderFrame}
 */
export function buildHeaderFrame(header) {
  clear(header);
  const fields = el("div", { class: "request-fields" });
  const right = el("div", { class: "topbar-right" });

  header.appendChild(el("div", { class: "wordmark" }, ["QuoteDesk"]));
  header.appendChild(fields);
  header.appendChild(right);
  return { fields, right };
}

/**
 * The engine can't cancel a run yet, so a live run has no Stop button.
 * @param {HTMLElement} header
 */
export function createRunHeader(header) {
  const frame = buildHeaderFrame(header);

  /** @param {RunHeaderModel} model */
  function update(model) {
    renderFields(frame.fields, model.fields);
    clear(frame.right);
    frame.right.appendChild(renderRunStatus(model));

    if (model.finished) {
      frame.right.appendChild(renderNewRunButton());
    }
  }

  return { update };
}

/**
 * @param {JobListing[]} jobs
 * @returns {HTMLSelectElement}
 */
function renderJobSelect(jobs) {
  const select = el("select", { class: "picker-select", "aria-label": "Job" });

  for (const job of jobs) {
    select.appendChild(el("option", { value: job.id }, [job.title]));
  }

  return select;
}

/** @returns {HTMLSelectElement} */
function renderProviderSelect() {
  return el("select", { class: "picker-select", "aria-label": "Provider" }, [
    el("option", { value: "fake" }, ["Fake calls"]),
    el("option", { value: "text" }, ["AI text calls"]),
  ]);
}

/** @returns {HTMLInputElement} */
function renderScaleInput() {
  return el("input", {
    class: "picker-select picker-scale",
    type: "number",
    min: 1,
    max: 120,
    placeholder: "Scale",
    "aria-label": "Scale: number of fake calls",
    title: "Clone the businesses up to this many fake calls",
  });
}

/**
 * @param {string} value
 * @returns {"fake" | "text"}
 */
function readProvider(value) {
  if (value === "text") {
    return "text";
  }

  return "fake";
}

/**
 * An empty box means a normal run with the job's own businesses.
 * @param {"fake" | "text"} provider
 * @param {HTMLInputElement} scaleInput
 * @returns {StartRequest["scale"]}
 */
function readScale(provider, scaleInput) {
  if (provider !== "fake" || scaleInput.value.trim() === "") {
    return undefined;
  }

  return Number(scaleInput.value);
}

/**
 * Before a run, the header holds only the picker; the request fields arrive with the run.
 * @param {HTMLElement} header
 * @param {JobListing[]} jobs
 * @param {(request: StartRequest) => Promise<string | null>} onStart Resolves with an error to show, or null.
 */
export function createPickerHeader(header, jobs, onStart) {
  const frame = buildHeaderFrame(header);
  const jobSelect = renderJobSelect(jobs);
  const providerSelect = renderProviderSelect();
  const scaleInput = renderScaleInput();
  const startButton = el("button", { class: "button button-primary", type: "button" }, [
    "Start calls",
  ]);
  const errorText = el("span", { class: "picker-error", role: "alert" });

  function showScaleForFakeCalls() {
    scaleInput.hidden = providerSelect.value !== "fake";
  }

  async function startCalls() {
    startButton.disabled = true;
    errorText.textContent = "";

    const provider = readProvider(providerSelect.value);
    /** @type {StartRequest} */
    const request = { jobId: jobSelect.value, provider };
    const scale = readScale(provider, scaleInput);

    if (scale !== undefined) {
      request.scale = scale;
    }

    const error = await onStart(request);

    if (error !== null) {
      errorText.textContent = error;
      startButton.disabled = false;
    }
  }

  providerSelect.addEventListener("change", showScaleForFakeCalls);
  startButton.addEventListener("click", startCalls);
  frame.right.appendChild(errorText);
  frame.right.appendChild(jobSelect);
  frame.right.appendChild(providerSelect);
  frame.right.appendChild(scaleInput);
  frame.right.appendChild(startButton);
}
