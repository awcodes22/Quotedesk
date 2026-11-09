import { z } from "zod";

export type FetchFunction = typeof fetch;

export type ConversationStatus = z.infer<typeof conversationStatusSchema>;
export type ConversationTurn = z.infer<typeof turnSchema>;
export type Conversation = z.infer<typeof conversationSchema>;

export type ElevenLabsClient = {
  startOutboundCall: (
    toNumber: string,
    dynamicVariables: Record<string, string>,
  ) => Promise<string>;
  getConversation: (conversationId: string) => Promise<Conversation>;
  getAudio: (conversationId: string) => Promise<Uint8Array>;
};

export type ElevenLabsSettings = {
  apiKey: string;
  agentId: string;
  phoneNumberId: string;
  fetch: FetchFunction;
};

const API_BASE = "https://api.elevenlabs.io/v1/convai";
const REQUEST_TIMEOUT_MS = 30_000;

const outboundCallSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  conversation_id: z.string().nullable(),
});

const conversationStatusSchema = z.enum([
  "initiated",
  "in-progress",
  "processing",
  "done",
  "failed",
]);

// "user" is whoever picked up the phone, "agent" is our caller.
const turnSchema = z.object({
  role: z.enum(["user", "agent"]),
  message: z.string().nullable().optional(),
  time_in_call_secs: z.number(),
});

const conversationSchema = z.object({
  status: conversationStatusSchema,
  transcript: z.array(turnSchema),
});

// Error text from the API can echo the number that was dialed, which must never reach a log.
export function hidePhoneNumbers(text: string): string {
  return text.replace(/\+?[0-9][0-9 ()-]{6,}[0-9]/g, "[number]");
}

function buildHeaders(apiKey: string): Record<string, string> {
  return { "xi-api-key": apiKey, "Content-Type": "application/json" };
}

async function readFailure(response: Response, action: string): Promise<Error> {
  let detail = "";

  try {
    detail = await response.text();
  } catch {
    detail = "";
  }

  const shortDetail = hidePhoneNumbers(detail).slice(0, 200);
  return new Error(`ElevenLabs ${action} failed with HTTP ${response.status}: ${shortDetail}`);
}

export function elevenLabsClient(settings: ElevenLabsSettings): ElevenLabsClient {
  const headers = buildHeaders(settings.apiKey);

  async function request(path: string, init: RequestInit, action: string): Promise<Response> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await settings.fetch(`${API_BASE}${path}`, { ...init, headers, signal });

    if (response.ok === false) {
      throw await readFailure(response, action);
    }

    return response;
  }

  async function startOutboundCall(
    toNumber: string,
    dynamicVariables: Record<string, string>,
  ): Promise<string> {
    const body = JSON.stringify({
      agent_id: settings.agentId,
      agent_phone_number_id: settings.phoneNumberId,
      to_number: toNumber,
      conversation_initiation_client_data: { dynamic_variables: dynamicVariables },
    });
    const response = await request("/twilio/outbound-call", { method: "POST", body }, "outbound call");
    const result = outboundCallSchema.parse(await response.json());

    if (result.success === false || result.conversation_id === null) {
      const reason = hidePhoneNumbers(result.message);
      throw new Error(`ElevenLabs did not start the call: ${reason}`);
    }

    return result.conversation_id;
  }

  async function getConversation(conversationId: string): Promise<Conversation> {
    const path = `/conversations/${encodeURIComponent(conversationId)}`;
    const response = await request(path, { method: "GET" }, "conversation lookup");
    return conversationSchema.parse(await response.json());
  }

  async function getAudio(conversationId: string): Promise<Uint8Array> {
    const path = `/conversations/${encodeURIComponent(conversationId)}/audio`;
    const response = await request(path, { method: "GET" }, "audio download");
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  return { startOutboundCall, getConversation, getAudio };
}
