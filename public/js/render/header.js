// @ts-check
import { clear, el, icon } from "../dom.js";
import { formatClock, formatDuration, pluralize } from "../format.js";
import { runElapsedMs } from "./view.js";

/**
 * @typedef {import("./view.js").View} View
 * @typedef {import("./view.js").JobListing} JobListing
 * @typedef {import("../icons.js").IconName} IconName
 *
 * @typedef {{ icon: IconName | null, label: string, value: string }} RequestField
 * @typedef {{ fields: RequestField[], finished: boolean, elapsed: string }} RunHeaderModel
 * @typedef {{ jobId: string, provider: "fake" | "text" }} StartRequest
 */

/**
 * @typedef {{
 *   lookingFor: string,
 *   details: { label: string, value: string }[],
 *   callCount: number,
 *   decideWithinMs: number | null,
 *   contactName: string | null,
 * }} FieldSource
 */

/**
 * Skips anything the job doesn't have, so every job gets a header that fits it.
 * @param {FieldSource} source
 * @returns {RequestField[]}
 */
function buildRequestFields(source) {
  /** @type {RequestField[]} */
  const fields = [{ icon: "search", label: "Looking for", value: source.lookingFor }];

  for (const detail of source.details) {
    fields.push({ icon: null, label: detail.label, value: detail.value });
  }

  fields.push({
    icon: "phone",
    label: "Calling",
    value: pluralize(source.callCount, "business", "businesses"),
  });

  if (source.decideWithinMs !== null) {
    const decideWithin = formatDuration(source.decideWithinMs);
    fields.push({ icon: "clock", label: "Decide", value: `Within ${decideWithin}` });
  }

  if (source.contactName !== null) {
    fields.push({ icon: "user", label: "Booking for", value: source.contactName });
  }

  return fields;
}

/**
 * @param {JobListing} listing
 * @returns {RequestField[]}
 */
function buildListingFields(listing) {
  let details = /** @type {{ label: string, value: string }[]} */ ([]);

  if (listing.details !== undefined) {
    details = listing.details;
  }

  return buildRequestFields({
    lookingFor: listing.industry.label,
    details,
    callCount: listing.businessCount,
    decideWithinMs: listing.decideWithinMs,
    contactName: listing.contactName,
  });
}

/**
 * @param {View} view
 * @returns {RunHeaderModel}
 */
export function selectRunHeaderModel(view) {
  const { state, listing } = view;
  let details = /** @type {{ label: string, value: string }[]} */ ([]);
  let decideWithinMs = null;
  let contactName = null;

  if (state.job !== null && state.job.details !== undefined) {
    details = state.job.details;
  }

  if (state.job !== null && state.job.contact !== undefined) {
    contactName = state.job.contact.name;
  }

  if (listing !== null) {
    decideWithinMs = listing.decideWithinMs;
  }

  const fields = buildRequestFields({
    lookingFor: state.industryLabel,
    details,
    callCount: state.callOrder.length,
    decideWithinMs,
    contactName,
  });

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
function renderFields(container, fields) {
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

/**
 * The engine has no way to cancel a run yet, so Stop says so instead of pretending.
 * @param {RunHeaderModel} model
 * @returns {HTMLElement}
 */
function renderRunAction(model) {
  if (model.finished) {
    return el("a", { class: "button", href: "/" }, ["New run"]);
  }

  return el(
    "button",
    {
      class: "button",
      type: "button",
      disabled: true,
      title: "Stopping a run early isn't supported yet.",
    },
    ["Stop"],
  );
}

/**
 * @param {HTMLElement} header
 */
function buildHeaderFrame(header) {
  clear(header);
  const fields = el("div", { class: "request-fields" });
  const right = el("div", { class: "topbar-right" });

  header.appendChild(el("div", { class: "wordmark" }, ["QuoteDesk"]));
  header.appendChild(fields);
  header.appendChild(right);
  return { fields, right };
}

/**
 * @param {HTMLElement} header
 */
export function createRunHeader(header) {
  const frame = buildHeaderFrame(header);

  /** @param {RunHeaderModel} model */
  function update(model) {
    renderFields(frame.fields, model.fields);
    clear(frame.right);
    frame.right.appendChild(renderRunStatus(model));
    frame.right.appendChild(renderRunAction(model));
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
 * @param {HTMLElement} header
 * @param {JobListing[]} jobs
 * @param {(request: StartRequest) => Promise<string | null>} onStart Resolves with an error to show, or null.
 */
export function createPickerHeader(header, jobs, onStart) {
  const frame = buildHeaderFrame(header);
  const jobSelect = renderJobSelect(jobs);
  const providerSelect = renderProviderSelect();
  const startButton = el("button", { class: "button button-primary", type: "button" }, [
    "Start calls",
  ]);
  const errorText = el("span", { class: "picker-error", role: "alert" });

  function showPickedJob() {
    const job = jobs.find((candidate) => candidate.id === jobSelect.value);

    if (job === undefined) {
      clear(frame.fields);
      return;
    }

    renderFields(frame.fields, buildListingFields(job));
  }

  async function startCalls() {
    startButton.disabled = true;
    errorText.textContent = "";

    const error = await onStart({
      jobId: jobSelect.value,
      provider: readProvider(providerSelect.value),
    });

    if (error !== null) {
      errorText.textContent = error;
      startButton.disabled = false;
    }
  }

  jobSelect.addEventListener("change", showPickedJob);
  startButton.addEventListener("click", startCalls);
  frame.right.appendChild(errorText);
  frame.right.appendChild(jobSelect);
  frame.right.appendChild(providerSelect);
  frame.right.appendChild(startButton);
  showPickedJob();
}
