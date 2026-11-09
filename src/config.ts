import dotenv from "dotenv";
import { z } from "zod";

// Returning undefined keeps zod's own message, which states the limit for range errors.
function buildTypeErrorMessage(message: string) {
  function describeIssue(issue: z.core.$ZodRawIssue): string | undefined {
    if (issue.code === "invalid_type") {
      return message;
    }

    return undefined;
  }

  return describeIssue;
}

// Environment variables are always strings, so numbers must be coerced.
function wholeNumber() {
  const error = buildTypeErrorMessage("must be a whole number");
  return z.coerce.number({ error }).int();
}

function positiveNumber() {
  const error = buildTypeErrorMessage("must be a number");
  return z.coerce.number({ error }).positive();
}

// A copied .env.example leaves "OPENAI_API_KEY=", which must count as missing.
function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value.trim();
}

function optionalText() {
  return z.string().optional().transform(blankToUndefined);
}

const PHONE_NUMBER_PATTERN = /^\+[1-9][0-9]{6,14}$/;

function splitNumberList(value: string | undefined): string[] {
  const text = blankToUndefined(value);

  if (text === undefined) {
    return [];
  }

  const entries = text.split(",").map((entry) => entry.trim());
  return entries.filter((entry) => entry !== "");
}

// The message never repeats the entry, since these are real phone numbers.
function phoneNumberList() {
  const error = "must be comma-separated numbers in E.164 format, such as +15551234567";
  const numbers = z.array(z.string().regex(PHONE_NUMBER_PATTERN, { error }));
  return z.string().optional().transform(splitNumberList).pipe(numbers);
}

type OpenAIValues = {
  PROVIDER: string;
  OPENAI_API_KEY: string | undefined;
  OPENAI_MODEL: string | undefined;
};

function requireOpenAIValues(
  values: OpenAIValues,
  context: z.RefinementCtx,
): void {
  if (values.PROVIDER !== "text") {
    return;
  }

  const message = 'must be set when PROVIDER is "text"';

  if (values.OPENAI_API_KEY === undefined) {
    context.addIssue({ code: "custom", path: ["OPENAI_API_KEY"], message });
  }

  if (values.OPENAI_MODEL === undefined) {
    context.addIssue({ code: "custom", path: ["OPENAI_MODEL"], message });
  }
}

const configSchema = z
  .object({
    HOST: z.string().trim().min(1).default("127.0.0.1"),
    PORT: wholeNumber().min(1).max(65535).default(3001),
    MAX_PARALLEL_CALLS: wholeNumber().min(1).max(30).default(3),
    DECISION_WINDOW_MS: wholeNumber().min(1).default(20000),
    SETTLE_GRACE_MS: wholeNumber().min(0).default(3000),
    RUN_TIMEOUT_MS: wholeNumber().min(1).default(120000),
    PRICE_FLAG_PCT: positiveNumber().default(10),
    PROVIDER: z.enum(["fake", "text"]).default("fake"),
    OPENAI_API_KEY: optionalText(),
    OPENAI_MODEL: optionalText(),
    MAX_TURNS: wholeNumber().min(1).default(14),
    ELEVENLABS_API_KEY: optionalText(),
    ELEVENLABS_AGENT_ID: optionalText(),
    ELEVENLABS_PHONE_NUMBER_ID: optionalText(),
    LIVE_GUEST_NAME: optionalText(),
    LIVE_ALLOWED_NUMBERS: phoneNumberList(),
    // The ElevenLabs plan allows six calls at once, so the cap can't go higher.
    LIVE_MAX_CALLS: wholeNumber().min(1).max(6).default(6),
    LIVE_CALL_TIMEOUT_MS: wholeNumber().min(1).default(300000),
  })
  .superRefine(requireOpenAIValues);

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
