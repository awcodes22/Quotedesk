// @ts-check
import { clear, el } from "../dom.js";
import { maskPhone, normalizeNorthAmericanNumber } from "../phone.js";
import { buildSampleStay, todayIso } from "./wizardState.js";

/**
 * @typedef {{ runId: string, title: string, provider: string, startedAt: number, callCount: number }} PastRun
 */

const FORMAT_ERROR = "Enter a North American number: 10 digits, with or without +1.";
const PROVIDER_NAMES = /** @type {Record<string, string>} */ ({ live: "Live", text: "Chats", fake: "Demo" });

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

/**
 * @param {string} url
 * @param {unknown} body
 * @returns {Promise<{ ok: boolean, body: Record<string, unknown> }>}
 */
async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await response.json();
  return { ok: response.ok, body: parsed };
}

/** @returns {Promise<boolean>} */
async function fetchSelfTest() {
  try {
    const response = await fetch("/api/jobs");
    const body = await response.json();
    return body.selfTest === true;
  } catch (error) {
    return false;
  }
}

/**
 * Starts the one test call. The number goes into this request and nowhere else.
 * @param {string} testNumber
 * @returns {Promise<string | null>}
 */
async function startTestCall(testNumber) {
  const stay = buildSampleStay(todayIso(new Date()));

  try {
    const result = await postJson("/api/runs", { provider: "live", stay, testNumber });

    if (result.ok === false) {
      let message = "Could not start the test call.";

      if (typeof result.body.error === "string") {
        message = result.body.error;
      }

      return message;
    }

    window.location.assign(`/runs/${encodeURIComponent(String(result.body.runId))}`);
    return null;
  } catch (error) {
    return "Could not reach the server.";
  }
}

/**
 * "Try it on yourself": a phone field, then a confirm step that only ever shows the masked number.
 * @param {HTMLElement} card
 * @param {boolean} enabled
 */
function createTryCard(card, enabled) {
  const input = el("input", {
    class: "input",
    type: "tel",
    name: "call-me-to-test",
    autocomplete: "off",
    placeholder: "+1 your number",
    "aria-label": "Your phone number for one test call",
  });
  const callButton = el("button", { class: "btn btn-primary", type: "button" }, ["Call me"]);
  const question = el("p", { class: "try-question" });
  const confirmButton = el("button", { class: "btn btn-primary btn-small", type: "button" }, ["Call me"]);
  const cancelButton = el("button", { class: "btn btn-small", type: "button" }, ["Cancel"]);
  const errorText = el("p", { class: "error-text", role: "alert" });
  const askRow = el("div", { class: "try-row" }, [input, callButton]);
  const confirmRow = el("div", { class: "try-confirm" }, [question, confirmButton, cancelButton]);
  /** @type {string | null} */
  let pendingNumber = null;

  /** @param {boolean} confirming */
  function showConfirm(confirming) {
    askRow.hidden = confirming;
    confirmRow.hidden = confirming === false;
  }

  function ask() {
    errorText.textContent = "";
    const number = normalizeNorthAmericanNumber(input.value);

    if (number === null) {
      errorText.textContent = FORMAT_ERROR;
      return;
    }

    pendingNumber = number;
    question.textContent = `Call ${maskPhone(number)} once to test?`;
    showConfirm(true);
  }

  function cancel() {
    pendingNumber = null;
    showConfirm(false);
  }

  async function call() {
    if (pendingNumber === null) {
      return;
    }

    confirmButton.disabled = true;
    const error = await startTestCall(pendingNumber);
    confirmButton.disabled = false;

    if (error !== null) {
      errorText.textContent = error;
      cancel();
      return;
    }

    // The run has started, so the number has nothing left to do in the page.
    input.value = "";
    pendingNumber = null;
  }

  card.appendChild(el("span", { class: "eyebrow" }, ["Try it on yourself"]));
  card.appendChild(el("h2", { class: "card-title" }, ["Get a test call"]));
  card.appendChild(
    el("p", { class: "muted" }, ["Play the front desk of a hotel in downtown Toronto and hear how the agent asks for a rate."]),
  );
  card.appendChild(askRow);
  card.appendChild(confirmRow);
  card.appendChild(el("p", { class: "field-hint" }, ["Used for this one call. Never saved."]));
  card.appendChild(errorText);

  callButton.addEventListener("click", ask);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      ask();
    }
  });
  confirmButton.addEventListener("click", call);
  cancelButton.addEventListener("click", cancel);
  showConfirm(false);

  if (enabled === false) {
    input.disabled = true;
    callButton.disabled = true;
    errorText.textContent = "Test calls are turned off on this server.";
  }
}

/**
 * @param {number} startedAt
 * @returns {string}
 */
function formatWhen(startedAt) {
  return new Date(startedAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * @param {HTMLElement} card
 */
async function showPastQuotes(card) {
  clear(card);
  card.appendChild(el("h2", { class: "card-title" }, ["Past quotes"]));

  try {
    const response = await fetch("/api/runs");
    const body = await response.json();
    /** @type {PastRun[]} */
    const runs = body.runs;

    if (runs.length === 0) {
      card.appendChild(el("p", { class: "muted" }, ["No quotes yet."]));
      return;
    }

    const items = runs.map((run) => {
      let mode = run.provider;
      const knownName = PROVIDER_NAMES[run.provider];

      if (knownName !== undefined) {
        mode = knownName;
      }

      return el("li", {}, [
        el("a", { href: `/runs/${encodeURIComponent(run.runId)}` }, [
          el("strong", {}, [run.title]),
          el("span", { class: "muted" }, [`${mode} · ${formatWhen(run.startedAt)}`]),
        ]),
      ]);
    });

    card.appendChild(el("ul", { class: "past-list" }, items));
  } catch (error) {
    card.appendChild(el("p", { class: "muted" }, ["Could not load past quotes."]));
  }
}

async function main() {
  const pastCard = findElement("past");
  const pastToggle = findElement("past-toggle");

  pastToggle.addEventListener("click", () => {
    pastCard.hidden = pastCard.hidden === false;

    if (pastCard.hidden === false) {
      showPastQuotes(pastCard);
    }
  });

  createTryCard(findElement("try"), await fetchSelfTest());
}

main();
