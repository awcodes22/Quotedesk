// @ts-check
import { clear, el } from "../dom.js";
import { buildDemoRequest, DEMO_MODES, SIMULATED_SIZES } from "./demoOptions.js";

/**
 * @typedef {{ id: string, title: string }} JobListing
 * @typedef {import("./demoOptions.js").DemoMode} DemoMode
 */

/** @returns {Promise<JobListing[]>} */
async function fetchJobs() {
  const response = await fetch("/api/jobs");
  const body = await response.json();
  return body.jobs;
}

/**
 * @param {string} label
 * @param {boolean} on
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function chip(label, on, onClick) {
  let className = "chip";

  if (on) {
    className = "chip is-on";
  }

  const button = el("button", { class: className, type: "button", "aria-pressed": String(on) }, [label]);
  button.addEventListener("click", onClick);
  return button;
}

/**
 * @param {HTMLElement} card
 * @param {JobListing[]} jobs
 */
function createPicker(card, jobs) {
  const jobSelect = el(
    "select",
    { class: "input", "aria-label": "Job" },
    jobs.map((job) => el("option", { value: job.id }, [job.title])),
  );
  const modes = el("div", { class: "chips" });
  const sizes = el("div", { class: "chips" });
  const hint = el("p", { class: "field-hint" });
  const sizeGroup = el("div", { class: "chip-group" }, [el("span", { class: "field-label" }, ["Calls"]), sizes]);
  const start = el("button", { class: "btn btn-primary", type: "button" }, ["Start"]);
  const errorText = el("p", { class: "error-text", role: "alert" });
  /** @type {DemoMode} */
  let mode = "simulated";
  let size = 24;

  function paint() {
    clear(modes);
    clear(sizes);

    for (const option of DEMO_MODES) {
      modes.appendChild(
        chip(option.label, mode === option.key, () => {
          mode = option.key;
          paint();
        }),
      );

      if (mode === option.key) {
        hint.textContent = option.hint;
      }
    }

    for (const option of SIMULATED_SIZES) {
      sizes.appendChild(
        chip(String(option), size === option, () => {
          size = option;
          paint();
        }),
      );
    }

    sizeGroup.hidden = mode !== "simulated";
  }

  async function startRun() {
    start.disabled = true;
    errorText.textContent = "";

    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildDemoRequest(jobSelect.value, mode, size)),
      });
      const body = await response.json();

      if (response.status !== 201) {
        errorText.textContent = "Could not start the run.";

        if (typeof body.error === "string") {
          errorText.textContent = body.error;
        }

        start.disabled = false;
        return;
      }

      window.location.assign(`/run/${encodeURIComponent(body.runId)}`);
    } catch (error) {
      errorText.textContent = "Could not reach the server.";
      start.disabled = false;
    }
  }

  start.addEventListener("click", startRun);
  paint();

  card.appendChild(el("label", { class: "field" }, [el("span", { class: "field-label" }, ["Job"]), jobSelect]));
  card.appendChild(el("div", { class: "chip-group" }, [el("span", { class: "field-label" }, ["Mode"]), modes, hint]));
  card.appendChild(sizeGroup);
  card.appendChild(errorText);
  card.appendChild(el("div", { class: "modal-actions" }, [start]));
}

async function main() {
  const card = document.getElementById("demo");

  if (card === null) {
    return;
  }

  try {
    createPicker(card, await fetchJobs());
  } catch (error) {
    card.appendChild(el("p", { class: "error-text" }, ["Could not load the jobs. Is the server running?"]));
  }
}

main();
