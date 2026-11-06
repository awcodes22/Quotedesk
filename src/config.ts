import dotenv from "dotenv";
import { z } from "zod";

const configSchema = z.object({
  // Environment variables are always strings, so PORT must be coerced to a number.
  PORT: z.coerce.number({ error: "must be set to a number" }).int().min(1).max(65535),
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
