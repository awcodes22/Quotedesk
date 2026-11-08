// @ts-check
import { el, icon } from "./dom.js";
import { renderBreakdown } from "./render/breakdown.js";
import {
  buildHeaderFrame,
  buildRequestFields,
  renderFields,
  renderNewRunButton,
} from "./render/header.js";

/**
 * @typedef {import("../../src/api/summary").RunSummary} RunSummary
 * @typedef {import("./render/view.js").JobListing} JobListing
 */

const BREAKDOWN_PATH = /^\/runs\/(run-[A-Za-z0-9-]+)\/breakdown\/?$/;

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

/** @returns {string | null} */
function readRunId() {
  const match = BREAKDOWN_PATH.exec(window.location.pathname);

  if (match === null || match[1] === undefined) {
    return null;
  }

  return match[1];
}

/** @returns {Promise<JobListing[]>} */
async function fetchJobs() {
  const response = await fetch("/api/jobs");

  if (response.ok === false) {
    return [];
  }

  const body = await response.json();
  return body.jobs;
}

/**
 * @param {string} runId
 * @returns {Promise<RunSummary | string>} The summary, or a message saying why there is none.
 */
async function fetchSummary(runId) {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/summary`);

  if (response.status === 409) {
    return "This run hasn't finished yet.";
  }

  if (response.ok === false) {
    return "There is no run with this id.";
  }

  return response.json();
}

/**
 * The summary is already in the page, so the file is built here instead of asking the server again.
 * @param {RunSummary} summary
 */
function exportSummary(summary) {
  const json = JSON.stringify(summary, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: `${summary.runId}.json` });

  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * @param {RunSummary} summary
 * @param {JobListing | null} listing
 */
function renderHeader(summary, listing) {
  const frame = buildHeaderFrame(findElement("topbar"));
  const fields = buildRequestFields(summary.job, summary.industryLabel, summary.counts.calls, listing);
  const exportButton = el("button", { class: "button", type: "button" }, [
    icon("download", 16),
    "Export",
  ]);

  exportButton.addEventListener("click", () => exportSummary(summary));
  renderFields(frame.fields, fields);
  frame.right.appendChild(exportButton);
  frame.right.appendChild(renderNewRunButton());
}

/**
 * @param {string} message
 * @param {string | null} runId
 */
function showMessage(message, runId) {
  const container = findElement("breakdown");
  let backLink = el("a", { class: "button", href: "/" }, ["New run"]);

  if (runId !== null) {
    backLink = el("a", { class: "button", href: `/runs/${encodeURIComponent(runId)}` }, [
      icon("arrow-left", 16),
      "Back to live view",
    ]);
  }

  container.appendChild(el("div", { class: "breakdown-message" }, [el("p", {}, [message]), backLink]));
}

async function main() {
  const runId = readRunId();

  if (runId === null) {
    showMessage("This page needs a run id in its address.", null);
    return;
  }

  const [jobs, summary] = await Promise.all([fetchJobs(), fetchSummary(runId)]);

  if (typeof summary === "string") {
    showMessage(summary, runId);
    return;
  }

  let listing = null;
  const found = jobs.find((job) => job.id === summary.job.id);

  if (found !== undefined) {
    listing = found;
  }

  renderHeader(summary, listing);
  renderBreakdown(findElement("breakdown"), { summary, listing });
}

main().catch(() => {
  showMessage("Could not load this run. Is the server running?", readRunId());
});
