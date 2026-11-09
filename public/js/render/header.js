// @ts-check
import { clear, el, icon } from "../dom.js";
import { formatClock, formatDuration, pluralize } from "../format.js";
import { ICONS } from "../icons.js";
import { maskPhone, normalizeNorthAmericanNumber } from "../phone.js";
import { isSelfTestRun } from "../state.js";
import { findBusinessNoun, runElapsedMs } from "./view.js";

/**
 * @typedef {import("./view.js").View} View
 * @typedef {import("./view.js").JobListing} JobListing
 * @typedef {import("../icons.js").IconName} IconName
 * @typedef {import("../../../src/core/types").Job} Job
 *
 * @typedef {{ icon: IconName | null, label: string, value: string }} RequestField
 * @typedef {{ fields: RequestField[], finished: boolean, elapsed: string }} RunHeaderModel
 * @typedef {"fake" | "text" | "live"} ProviderName
 * @typedef {{ jobId: string, provider: ProviderName, scale?: number, testNumber?: string }} StartRequest
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
 * @param {boolean} [selfTestRun] A "Call me to test" run, which rings one person instead of businesses.
 * @returns {RequestField[]}
 */
export function buildRequestFields(job, industryLabel, callCount, listing, selfTestRun = false) {
  const noun = findBusinessNoun(listing);
  let calling = pluralize(callCount, noun.singular, noun.plural);

  if (selfTestRun) {
    calling = "Test call";
  }

  /** @type {RequestField[]} */
  const fields = [{ icon: "search", label: "Looking for", value: industryLabel }];

  if (job.details !== undefined) {
    for (const detail of job.details) {
      fields.push({ icon: findIconName(detail.icon), label: detail.label, value: detail.value });
    }
  }

  fields.push({ icon: "phone", label: "Calling", value: calling });

  if (listing !== null) {
    const decideWithin = formatDuration(listing.decideWithinMs);
    fields.push({ icon: "clock", label: "Decide", value: `Within ${decideWithin}` });
  }

  // A live run carries the name the caller gives on the phone, which wins over the job's contact.
  let guestName = null;

  if (job.contact !== undefined) {
    guestName = job.contact.name;
  }

  if (job.guestName !== undefined) {
    guestName = job.guestName;
  }

  if (guestName !== null) {
    fields.push({ icon: "user", label: "Guest", value: guestName });
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
    fields = buildRequestFields(
      state.job,
      state.industryLabel,
      state.callOrder.length,
      view.listing,
      isSelfTestRun(state),
    );
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

/** @type {{ value: ProviderName, label: string }[]} */
export const PROVIDER_OPTIONS = [
  { value: "fake", label: "Demo" },
  { value: "text", label: "Chats" },
  { value: "live", label: "Live call" },
];

/** @returns {HTMLSelectElement} */
function renderProviderSelect() {
  const options = PROVIDER_OPTIONS.map((option) => {
    return el("option", { value: option.value }, [option.label]);
  });

  return el("select", { class: "picker-select", "aria-label": "Mode" }, options);
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
 * @returns {ProviderName}
 */
function readProvider(value) {
  const option = PROVIDER_OPTIONS.find((candidate) => candidate.value === value);

  if (option === undefined) {
    return "fake";
  }

  return option.value;
}

/**
 * An empty box means a normal run with the job's own businesses.
 * @param {ProviderName} provider
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
 * The option needs the server's switch on, and only makes sense for live calls.
 * @param {string} provider
 * @param {boolean} selfTest
 * @returns {boolean}
 */
export function showsSelfTest(provider, selfTest) {
  return selfTest && provider === "live";
}

/**
 * @param {string} number A number already checked by normalizeNorthAmericanNumber.
 * @returns {string}
 */
export function describeSelfTestCall(number) {
  return `Call ${maskPhone(number)} once to test?`;
}

const SELF_TEST_FORMAT_ERROR = "Enter a North American number: 10 digits, with or without +1.";

/**
 * The number is only ever in this input and in the one request that starts the call.
 * No name the browser would autofill or remember, and nothing is saved anywhere.
 * @returns {HTMLInputElement}
 */
function renderSelfTestInput() {
  return el("input", {
    class: "picker-select picker-self-test",
    type: "tel",
    name: "call-me-to-test",
    autocomplete: "off",
    placeholder: "+1 your number",
    "aria-label": "Your number for one test call",
  });
}

/**
 * Asks before dialing, showing only the masked number.
 * @param {(number: string) => Promise<string | null>} onCall Starts the call; resolves with an error or null.
 * @param {(message: string) => void} showError
 */
function createSelfTestOption(onCall, showError) {
  const input = renderSelfTestInput();
  const askButton = el("button", { class: "button", type: "button" }, ["Call me to test"]);
  const question = el("span", { class: "self-test-question" });
  const callButton = el("button", { class: "button button-primary", type: "button" }, ["Call me"]);
  const cancelButton = el("button", { class: "button", type: "button" }, ["Cancel"]);
  const asking = el("span", { class: "self-test-row" }, [input, askButton]);
  const confirming = el("span", { class: "self-test-row" }, [question, callButton, cancelButton]);
  const root = el("span", { class: "self-test" }, [asking, confirming]);
  /** @type {string | null} */
  let pendingNumber = null;

  /** @param {boolean} isConfirming */
  function showStep(isConfirming) {
    asking.hidden = isConfirming;
    confirming.hidden = isConfirming === false;
  }

  function ask() {
    showError("");
    const number = normalizeNorthAmericanNumber(input.value);

    if (number === null) {
      showError(SELF_TEST_FORMAT_ERROR);
      return;
    }

    pendingNumber = number;
    question.textContent = describeSelfTestCall(number);
    showStep(true);
  }

  function cancel() {
    pendingNumber = null;
    question.textContent = "";
    showStep(false);
  }

  async function call() {
    if (pendingNumber === null) {
      return;
    }

    callButton.disabled = true;
    const error = await onCall(pendingNumber);
    callButton.disabled = false;

    if (error !== null) {
      showError(error);
      cancel();
      return;
    }

    // The run has started, so the number has nothing left to do in the page.
    input.value = "";
    cancel();
  }

  function hasNumber() {
    return input.value.trim() !== "";
  }

  askButton.addEventListener("click", ask);
  cancelButton.addEventListener("click", cancel);
  callButton.addEventListener("click", call);
  showStep(false);
  return { root, ask, hasNumber };
}

/**
 * Before a run, the header holds only the picker; the request fields arrive with the run.
 * @param {HTMLElement} header
 * @param {JobListing[]} jobs
 * @param {boolean} selfTest Whether the server allows Call me to test.
 * @param {(request: StartRequest) => Promise<string | null>} onStart Resolves with an error to show, or null.
 */
export function createPickerHeader(header, jobs, selfTest, onStart) {
  const frame = buildHeaderFrame(header);
  const jobSelect = renderJobSelect(jobs);
  const providerSelect = renderProviderSelect();
  const scaleInput = renderScaleInput();
  const startButton = el("button", { class: "button button-primary", type: "button" }, [
    "Start calls",
  ]);
  const errorText = el("span", { class: "picker-error", role: "alert" });

  /** @param {string} message */
  function showError(message) {
    errorText.textContent = message;
  }

  /** @param {string} testNumber */
  function startSelfTest(testNumber) {
    return onStart({ jobId: jobSelect.value, provider: "live", testNumber });
  }

  const selfTestOption = createSelfTestOption(startSelfTest, showError);

  function showModeOptions() {
    scaleInput.hidden = providerSelect.value !== "fake";
    selfTestOption.root.hidden = showsSelfTest(providerSelect.value, selfTest) === false;
  }

  async function startCalls() {
    const provider = readProvider(providerSelect.value);

    // A typed number means a test call, which has to go through its own confirm step.
    // Starting a normal live run here would ignore the number and dial the job's businesses.
    if (showsSelfTest(provider, selfTest) && selfTestOption.hasNumber()) {
      selfTestOption.ask();
      return;
    }

    startButton.disabled = true;
    showError("");

    /** @type {StartRequest} */
    const request = { jobId: jobSelect.value, provider };
    const scale = readScale(provider, scaleInput);

    if (scale !== undefined) {
      request.scale = scale;
    }

    const error = await onStart(request);

    if (error !== null) {
      showError(error);
      startButton.disabled = false;
    }
  }

  providerSelect.addEventListener("change", showModeOptions);
  startButton.addEventListener("click", startCalls);
  showModeOptions();
  frame.right.appendChild(errorText);
  frame.right.appendChild(jobSelect);
  frame.right.appendChild(selfTestOption.root);
  frame.right.appendChild(providerSelect);
  frame.right.appendChild(scaleInput);
  frame.right.appendChild(startButton);
}
