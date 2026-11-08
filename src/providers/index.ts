import type { Config } from "../config";
import { fakeProvider } from "./fake";
import type { FakeProviderOptions } from "./fake";
import { openAIChat, textSimProvider } from "./textSim";
import type { CallProvider } from "./types";

type ProviderConfig = Pick<
  Config,
  "OPENAI_API_KEY" | "OPENAI_MODEL" | "MAX_TURNS" | "DECISION_WINDOW_MS"
>;

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

export function createProvider(
  name: string,
  config: ProviderConfig,
  fakeOptions: FakeProviderOptions = {},
): CallProvider {
  if (name === "text") {
    return createTextProvider(config);
  }

  if (name === "fake") {
    return fakeProvider(fakeOptions);
  }

  throw new Error(`Unknown provider "${name}". Valid providers: fake, text`);
}
