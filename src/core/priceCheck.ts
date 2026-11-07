import type {
  IndustryConfig,
  PriceCheck,
  PriceCheckRow,
  Quote,
  ReferencePrices,
} from "./types";

const TOTAL_ITEM = "Total";

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function sameItem(a: string, b: string): boolean {
  const first = normalizeName(a);
  const second = normalizeName(b);

  // Every string contains the empty string, so a blank name would match anything.
  if (first === "" || second === "") {
    return false;
  }

  return first.includes(second) || second.includes(first);
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

export function buildRow(
  item: string,
  reference: number,
  quoted: number,
  thresholdPct: number,
): PriceCheckRow {
  const exactDiffPct = ((quoted - reference) / reference) * 100;
  const diffPct = roundToOneDecimal(exactDiffPct);

  // Comparing the rounded value keeps float noise from flagging a diff at the threshold.
  const flagged = Math.abs(diffPct) > thresholdPct;

  return { item, reference, quoted, diffPct, flagged };
}

function getQuotedLines(
  quote: Quote,
  industry: IndustryConfig,
): Record<string, number> {
  if (industry.linePrices === undefined) {
    return {};
  }

  return industry.linePrices(quote.fields);
}

function findQuotedLine(
  referenceItem: string,
  quotedLines: Record<string, number>,
): [string, number] | undefined {
  const entries = Object.entries(quotedLines);
  return entries.find(([quotedItem]) => sameItem(referenceItem, quotedItem));
}

function buildLineRows(
  quote: Quote,
  referenceLines: Record<string, number>,
  industry: IndustryConfig,
  thresholdPct: number,
): PriceCheckRow[] {
  const quotedLines = getQuotedLines(quote, industry);
  const rows: PriceCheckRow[] = [];

  for (const [referenceItem, referencePrice] of Object.entries(referenceLines)) {
    const match = findQuotedLine(referenceItem, quotedLines);

    if (match !== undefined) {
      const [quotedItem, quotedPrice] = match;
      rows.push(buildRow(quotedItem, referencePrice, quotedPrice, thresholdPct));
    }
  }

  return rows;
}

function buildRows(
  quote: Quote,
  reference: ReferencePrices,
  industry: IndustryConfig,
  thresholdPct: number,
): PriceCheckRow[] {
  let rows: PriceCheckRow[] = [];

  if (reference.lines !== undefined) {
    rows = buildLineRows(quote, reference.lines, industry, thresholdPct);
  }

  if (reference.total !== undefined) {
    rows.push(buildRow(TOTAL_ITEM, reference.total, quote.total, thresholdPct));
  }

  return rows;
}

export function runPriceCheck(
  quote: Quote,
  reference: ReferencePrices | undefined,
  industry: IndustryConfig,
  thresholdPct: number,
): PriceCheck | undefined {
  if (reference === undefined) {
    return undefined;
  }

  const rows = buildRows(quote, reference, industry, thresholdPct);

  if (rows.length === 0) {
    return undefined;
  }

  const flaggedRows = rows.filter((row) => row.flagged);

  return {
    businessId: quote.businessId,
    thresholdPct,
    rows,
    flaggedCount: flaggedRows.length,
    source: reference.source,
  };
}
