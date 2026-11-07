import dotenv from "dotenv";
import { z } from "zod";

// Returning undefined keeps zod's own message, which states the limit for range errors.
function describeNumberIssue(issue: z.core.$ZodRawIssue): string | undefined {
  if (issue.code === "invalid_type") {
    return "must be a whole number";
  }

  return undefined;
}

// Environment variables are always strings, so numbers must be coerced.
function wholeNumber() {
  return z.coerce.number({ error: describeNumberIssue }).int();
}

const configSchema = z.object({
  PORT: wholeNumber().min(1).max(65535).default(3001),
  MAX_PARALLEL_CALLS: wholeNumber().min(1).max(30).default(3),
  DECISION_WINDOW_MS: wholeNumber().min(1).default(20000),
  SETTLE_GRACE_MS: wholeNumber().min(0).default(5000),
  RUN_TIMEOUT_MS: wholeNumber().min(1).default(120000),
});

export type Config = z.infer<typeof configSchema>;

function formatIssue(issue: z.core.$ZodIssue): string {
  const variableName = issue.path.join(".");
  return `${variableName}: ${issue.message}`;
}

function buildErrorMessage(error: z.ZodError): string {
  const issueLines = error.issues.map(formatIssue);
  const issueList = issueLines.join("\n");
  return `Invalid environment variables:\n${issueList}`;
}

function loadConfig(): Config {
  // dotenv logs a banner on every load unless silenced.
  dotenv.config({ quiet: true });

  const result = configSchema.safeParse(process.env);

  if (result.success === false) {
    const message = buildErrorMessage(result.error);
    throw new Error(message);
  }

  return result.data;
}

export const config = loadConfig();
