import type { Config } from "../config";
import { elevenLabsClient } from "./elevenLabs";
import { fakeProvider } from "./fake";
import type { FakeProviderOptions } from "./fake";
import { liveProvider } from "./live";
import { createQuoteExtractor, openAIJsonCompletion } from "./quoteExtractor";
import { openAIChat, textSimProvider } from "./textSim";
import type { CallProvider } from "./types";

export type ProviderConfig = Pick<
  Config,
  "OPENAI_API_KEY" | "OPENAI_MODEL" | "MAX_TURNS" | "DECISION_WINDOW_MS"
> &
  Partial<
    Pick<
      Config,
      | "ELEVENLABS_API_KEY"
      | "ELEVENLABS_AGENT_ID"
      | "ELEVENLABS_PHONE_NUMBER_ID"
      | "LIVE_GUEST_NAME"
      | "LIVE_ALLOWED_NUMBERS"
      | "LIVE_MAX_CALLS"
      | "LIVE_CALL_TIMEOUT_MS"
    >
  >;

const DEFAULT_RUNS_DIRECTORY = "runs";

function requireValue(name: string, value: string | undefined): string {
  if (value === undefined) {
    throw new Error(`The text provider needs ${name} to be set.`);
  }

  return value;
}

function createTextProvider(config: ProviderConfig): CallProvider {
  const apiKey = requireValue("OPENAI_API_KEY", config.OPENAI_API_KEY);
  const model = requireValue("OPENAI_MODEL", config.OPENAI_MODEL);

  return textSimProvider({
    chat: openAIChat(apiKey, model),
    maxTurns: config.MAX_TURNS,
    waitForCommandMs: config.DECISION_WINDOW_MS,
  });
}

// Only names are listed, never values, since these are keys.
// An empty LIVE_ALLOWED_NUMBERS is fine: test calls don't need it, and private jobs are refused per number.
export function findMissingLiveSettings(config: ProviderConfig): string[] {
  const required: [string, unknown][] = [
    ["ELEVENLABS_API_KEY", config.ELEVENLABS_API_KEY],
    ["ELEVENLABS_AGENT_ID", config.ELEVENLABS_AGENT_ID],
    ["ELEVENLABS_PHONE_NUMBER_ID", config.ELEVENLABS_PHONE_NUMBER_ID],
    ["LIVE_GUEST_NAME", config.LIVE_GUEST_NAME],
    ["OPENAI_API_KEY", config.OPENAI_API_KEY],
    ["OPENAI_MODEL", config.OPENAI_MODEL],
  ];
  const missing: string[] = [];

  for (const [name, value] of required) {
    if (value === undefined) {
      missing.push(name);
    }
  }

  return missing;
}

function createLiveProvider(config: ProviderConfig, runsDirectory: string): CallProvider {
  const missing = findMissingLiveSettings(config);

  if (missing.length > 0) {
    throw new Error(`Live calls are unavailable. Set these in .env: ${missing.join(", ")}.`);
  }

  // Checked above; these assignments only narrow the types.
  const apiKey = String(config.ELEVENLABS_API_KEY);
  const agentId = String(config.ELEVENLABS_AGENT_ID);
  const phoneNumberId = String(config.ELEVENLABS_PHONE_NUMBER_ID);
  const guestName = String(config.LIVE_GUEST_NAME);
  const openAIKey = String(config.OPENAI_API_KEY);
  const openAIModel = String(config.OPENAI_MODEL);
  let allowedNumbers: string[] = [];
  let maxCalls = 1;

  if (config.LIVE_ALLOWED_NUMBERS !== undefined) {
    allowedNumbers = config.LIVE_ALLOWED_NUMBERS;
  }
  let callTimeoutMs = 300_000;

  if (config.LIVE_MAX_CALLS !== undefined) {
    maxCalls = config.LIVE_MAX_CALLS;
  }

  if (config.LIVE_CALL_TIMEOUT_MS !== undefined) {
    callTimeoutMs = config.LIVE_CALL_TIMEOUT_MS;
  }

  return liveProvider({
    client: elevenLabsClient({ apiKey, agentId, phoneNumberId, fetch }),
    extractQuote: createQuoteExtractor(openAIJsonCompletion(openAIKey, openAIModel)),
    guestName,
    allowedNumbers,
    maxCalls,
    callTimeoutMs,
    runsDirectory,
  });
}

export function createProvider(
  name: string,
  config: ProviderConfig,
  fakeOptions: FakeProviderOptions = {},
  runsDirectory: string = DEFAULT_RUNS_DIRECTORY,
): CallProvider {
  if (name === "text") {
    return createTextProvider(config);
  }

  if (name === "fake") {
    return fakeProvider(fakeOptions);
  }

  if (name === "live") {
    return createLiveProvider(config, runsDirectory);
  }

  throw new Error(`Unknown provider "${name}". Valid providers: fake, text, live`);
}
