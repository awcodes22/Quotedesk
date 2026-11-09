import { parseArgs } from "node:util";
import { config } from "./config";
import { onEvent } from "./core/events";
import type { AgentEvent } from "./core/events";
import { getRunLogPath, startRecorder } from "./core/recorder";
import { runJob } from "./core/run";
import type {
  Decision,
  IndustryConfig,
  Job,
  PriceCheck,
  PriceCheckRow,
  Quote,
  RunReport,
} from "./core/types";
import { getIndustry } from "./industries/index";
import { loadJob } from "./jobs";
import { createProvider } from "./providers/index";
import type { FakeProviderOptions } from "./providers/fake";
import type { RunOptions } from "./core/run";
import { describeError } from "./privacy";
import { scaleRun } from "./scale";

const RUNS_DIRECTORY = "runs";
const SOURCE_COLUMN_WIDTH = 26;
const ELAPSED_COLUMN_WIDTH = 6;
const MONEY_COLUMN_WIDTH = 11;
const DIFF_COLUMN_WIDTH = 9;

type BusinessNames = Map<string, string>;

type CliArguments = {
  jobPath: string;
  providerName: string;
  scale: number | undefined;
};

type PreparedRun = {
  job: Job;
  industry: IndustryConfig;
  fakeOptions: FakeProviderOptions;
  maxParallelCalls: number;
};

function readArguments(): CliArguments {
  const { values } = parseArgs({
    options: {
      job: { type: "string" },
      provider: { type: "string" },
      scale: { type: "string" },
    },
  });

  if (values.job === undefined) {
    throw new Error(
      "Usage: npm run job -- --job <path to job file> [--provider fake|text] [--scale N]",
    );
  }

  let providerName: string = config.PROVIDER;
  let scale: number | undefined = undefined;

  if (values.provider !== undefined) {
    providerName = values.provider;
  }

  if (values.scale !== undefined) {
    scale = Number(values.scale);
  }

  return { jobPath: values.job, providerName, scale };
}

// Fake calls cost nothing, so a scaled demo dials every business at once.
function prepareRun(job: Job, providerName: string, scale: number | undefined): PreparedRun {
  const industry = getIndustry(job.industryId);

  // Live runs need the allowlist and recording checks that only the server applies.
  if (providerName === "live") {
    throw new Error("Live calls run from the dashboard, not the CLI.");
  }

  if (scale === undefined) {
    return { job, industry, fakeOptions: {}, maxParallelCalls: config.MAX_PARALLEL_CALLS };
  }

  if (providerName !== "fake") {
    throw new Error("--scale only works with the fake provider.");
  }

  const scaled = scaleRun(job, industry, scale);

  return {
    job: scaled.job,
    industry: scaled.industry,
    fakeOptions: { failBusinessIds: scaled.noAnswerIds },
    maxParallelCalls: scaled.industry.simBusinesses.length,
  };
}

function getBusinessNames(industry: IndustryConfig): BusinessNames {
  const names: BusinessNames = new Map();

  for (const business of industry.simBusinesses) {
    names.set(business.id, business.name);
  }

  return names;
}

function getBusinessName(names: BusinessNames, businessId: string): string {
  let name = businessId;
  const knownName = names.get(businessId);

  if (knownName !== undefined) {
    name = knownName;
  }

  return name;
}

function getEventSource(event: AgentEvent, names: BusinessNames): string {
  if ("businessId" in event) {
    return getBusinessName(names, event.businessId);
  }

  return "QuoteDesk";
}

function describeDecision(decision: Decision, names: BusinessNames): string {
  if (decision.kind === "none") {
    return "Decision: no quotes received";
  }

  const winnerName = getBusinessName(names, decision.winner.businessId);
  return `Decision: ${winnerName} at $${decision.winner.total} (${decision.reason})`;
}

function describeEvent(event: AgentEvent, names: BusinessNames): string {
  switch (event.type) {
    case "run_started":
      return `Run ${event.runId} started on the ${event.provider} provider`;
    case "call_status":
      return `Status: ${event.status}`;
    case "transcript":
      return `${event.line.speaker}: ${event.line.text}`;
    case "quote":
      return `Quote: $${event.quote.total}`;
    case "note":
      return `Note: ${event.text}`;
    case "call_brief":
      return `Told the agent: ${event.variables.request}`;
    case "decision":
      return describeDecision(event.decision, names);
    case "decision_pushed":
      return `Pushed ${event.command}, delivered: ${event.delivered}`;
    case "decision_scheduled":
      return `Deciding in ${formatElapsed(event.deadlineAt - event.at).trim()} (${event.reason})`;
    case "price_check":
      return `Price check: ${event.check.flaggedCount} of ${event.check.rows.length} lines flagged`;
    case "run_finished":
      return "Run finished";
    case "alert":
      return `Alert ${event.level} ${event.code}: ${event.message}`;
  }
}

function formatElapsed(elapsedMs: number): string {
  const seconds = (elapsedMs / 1000).toFixed(1);
  return `${seconds}s`.padStart(ELAPSED_COLUMN_WIDTH);
}

function startEventPrinter(names: BusinessNames): void {
  const startedAt = Date.now();

  function printEvent(event: AgentEvent): void {
    const elapsed = formatElapsed(event.at - startedAt);
    const source = getEventSource(event, names).padEnd(SOURCE_COLUMN_WIDTH);
    const description = describeEvent(event, names);
    console.log(`${elapsed}  ${source}${description}`);
  }

  onEvent(printEvent);
}

function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatDiff(diffPct: number): string {
  const diff = `${diffPct.toFixed(1)}%`;

  if (diffPct > 0) {
    return `+${diff}`;
  }

  return diff;
}

function formatTableLine(
  item: string,
  reference: string,
  quoted: string,
  diff: string,
  itemWidth: number,
): string {
  const itemColumn = item.padEnd(itemWidth);
  const referenceColumn = reference.padStart(MONEY_COLUMN_WIDTH);
  const quotedColumn = quoted.padStart(MONEY_COLUMN_WIDTH);
  const diffColumn = diff.padStart(DIFF_COLUMN_WIDTH);
  return `  ${itemColumn}${referenceColumn}${quotedColumn}${diffColumn}`;
}

function formatRow(row: PriceCheckRow, itemWidth: number): string {
  const line = formatTableLine(
    row.item,
    formatMoney(row.reference),
    formatMoney(row.quoted),
    formatDiff(row.diffPct),
    itemWidth,
  );

  if (row.flagged) {
    return `${line}  FLAGGED`;
  }

  return line;
}

function describePriceCheck(check: PriceCheck): string {
  let source = "the reference prices";

  if (check.source !== undefined) {
    source = check.source;
  }

  return `${check.flaggedCount} of ${check.rows.length} lines off by more than ${check.thresholdPct}% vs ${source}`;
}

function printPriceCheck(check: PriceCheck): void {
  const itemHeading = "Item";
  const itemLengths = check.rows.map((row) => row.item.length);
  const itemWidth = Math.max(itemHeading.length, ...itemLengths);

  console.log(
    formatTableLine(itemHeading, "Reference", "Quoted", "Diff", itemWidth),
  );

  for (const row of check.rows) {
    console.log(formatRow(row, itemWidth));
  }

  console.log(describePriceCheck(check));
}

function printOtherQuotes(others: Quote[], names: BusinessNames): void {
  console.log("Others:");

  for (const quote of others) {
    const name = getBusinessName(names, quote.businessId);
    console.log(`  ${name}: ${formatMoney(quote.total)}`);
  }
}

function printDecisionResult(report: RunReport, names: BusinessNames): void {
  const { decision, priceCheck } = report;

  if (decision.kind === "none") {
    console.log("No quotes were received.");
    return;
  }

  const winnerName = getBusinessName(names, decision.winner.businessId);
  console.log(`Winner: ${winnerName} at ${formatMoney(decision.winner.total)}`);

  if (priceCheck !== undefined) {
    printPriceCheck(priceCheck);
  }

  printOtherQuotes(decision.others, names);
}

function printResult(report: RunReport, names: BusinessNames): void {
  console.log("");
  console.log("Result");
  printDecisionResult(report, names);
  console.log(`Log: ${getRunLogPath(RUNS_DIRECTORY, report.runId)}`);
}

async function main(): Promise<void> {
  const { jobPath, providerName, scale } = readArguments();
  const prepared = prepareRun(loadJob(jobPath), providerName, scale);
  const { job, industry } = prepared;
  const names = getBusinessNames(industry);
  const provider = createProvider(providerName, config, prepared.fakeOptions);

  startRecorder(RUNS_DIRECTORY);
  startEventPrinter(names);

  const runOptions: RunOptions = {
    maxParallelCalls: prepared.maxParallelCalls,
    decisionWindowMs: config.DECISION_WINDOW_MS,
    runTimeoutMs: config.RUN_TIMEOUT_MS,
    settleGraceMs: config.SETTLE_GRACE_MS,
    priceFlagPct: config.PRICE_FLAG_PCT,
  };
  const report = await runJob(job, industry, provider, runOptions);

  printResult(report, names);
}

function handleFailure(error: unknown): void {
  console.error(describeError(error));
  process.exitCode = 1;
}

main().catch(handleFailure);
