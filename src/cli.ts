import { parseArgs } from "node:util";
import { config } from "./config";
import { onEvent } from "./core/events";
import type { AgentEvent } from "./core/events";
import { getRunLogPath, startRecorder } from "./core/recorder";
import { runJob } from "./core/run";
import type {
  Decision,
  IndustryConfig,
  PriceCheck,
  PriceCheckRow,
  Quote,
  RunReport,
} from "./core/types";
import { getIndustry } from "./industries/index";
import { loadJob } from "./jobs";
import { fakeProvider } from "./providers/fake";

const RUNS_DIRECTORY = "runs";
const SOURCE_COLUMN_WIDTH = 26;
const ELAPSED_COLUMN_WIDTH = 6;
const MONEY_COLUMN_WIDTH = 11;
const DIFF_COLUMN_WIDTH = 9;

type BusinessNames = Map<string, string>;

function readJobPath(): string {
  const { values } = parseArgs({ options: { job: { type: "string" } } });

  if (values.job === undefined) {
    throw new Error("Usage: npm run job -- --job <path to job file>");
  }

  return values.job;
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
    case "decision":
      return describeDecision(event.decision, names);
    case "decision_pushed":
      return `Pushed ${event.command}, delivered: ${event.delivered}`;
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
  const jobPath = readJobPath();
  const job = loadJob(jobPath);
  const industry = getIndustry(job.industryId);
  const names = getBusinessNames(industry);

  startRecorder(RUNS_DIRECTORY);
  startEventPrinter(names);

  const report = await runJob(job, industry, fakeProvider(), {
    maxParallelCalls: config.MAX_PARALLEL_CALLS,
    decisionWindowMs: config.DECISION_WINDOW_MS,
    runTimeoutMs: config.RUN_TIMEOUT_MS,
    settleGraceMs: config.SETTLE_GRACE_MS,
    priceFlagPct: config.PRICE_FLAG_PCT,
  });

  printResult(report, names);
}

function handleFailure(error: unknown): void {
  console.error(String(error));
  process.exitCode = 1;
}

main().catch(handleFailure);
