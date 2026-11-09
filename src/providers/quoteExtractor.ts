import OpenAI from "openai";
import { z } from "zod";
import type { IndustryConfig, QuoteFields, TranscriptLine } from "../core/types";

export type JsonCompletion = (
  instructions: string,
  input: string,
  schema: Record<string, unknown>,
) => Promise<string>;

export type Extraction = {
  fields: QuoteFields | null;
  notes: string[];
};

export type QuoteExtractor = (
  transcript: Omit<TranscriptLine, "at">[],
  industry: IndustryConfig,
) => Promise<Extraction>;

const COMPLETION_TIMEOUT_MS = 30_000;
const MAX_NOTES = 6;

// A client always wants these, so each gets its own slot instead of hoping a free note covers it.
// The order here is the order the notes are shown in.
export const NOTE_TOPICS = {
  breakfast: "whether breakfast is included, or what it costs",
  cancellation: "the cancellation terms, or that the rate is non-refundable",
  discounts: "any discount or lower rate the business offered or applied",
  extraFees: "any extra fee, such as parking, resort or deposit fees, or taxes on top",
} as const;

type NoteTopic = keyof typeof NOTE_TOPICS;

const topicNoteSchema = z.string().nullable().optional();

const envelopeSchema = z.object({
  quote: z.unknown().nullable(),
  topics: z
    .object({
      breakfast: topicNoteSchema,
      cancellation: topicNoteSchema,
      discounts: topicNoteSchema,
      extraFees: topicNoteSchema,
    })
    .optional(),
  notes: z.array(z.string()),
});

type TopicNotes = NonNullable<z.infer<typeof envelopeSchema>["topics"]>;

function describeTopics(): string {
  const lines = Object.entries(NOTE_TOPICS).map(([key, meaning]) => `- ${key}: ${meaning}`);
  return lines.join("\n");
}

function buildInstructions(industry: IndustryConfig): string {
  return [
    `You read the transcript of a phone call where an AI caller asked a ${industry.businessNoun.singular} for a price.`,
    `The caller's goal: ${industry.goal}`,
    "Set quote to the final total the business confirmed for the whole request, after any discount the business agreed to.",
    "Only fill a field the business actually stated. Leave out anything it did not say.",
    "If the business never gave a price, set quote to null.",
    "Fill each of these topics with one short sentence when the business mentioned it, and null when it did not:",
    describeTopics(),
    "Never guess or invent a topic. If the transcript doesn't mention it, it is null.",
    "Put anything else a client would want to know in notes, as short sentences. Never note what the caller said.",
  ].join("\n");
}

function formatTranscript(transcript: Omit<TranscriptLine, "at">[]): string {
  const lines = transcript.map((line) => {
    let speaker = "Caller";

    if (line.speaker === "business") {
      speaker = "Business";
    }

    return `${speaker}: ${line.text}`;
  });

  return lines.join("\n");
}

function buildResponseSchema(industry: IndustryConfig): Record<string, unknown> {
  const quoteSchema: Record<string, unknown> = { ...z.toJSONSchema(industry.quoteSchema) };

  // The response format nests this schema, where the key isn't expected.
  delete quoteSchema.$schema;

  const topicProperties: Record<string, unknown> = {};

  for (const topic of Object.keys(NOTE_TOPICS)) {
    topicProperties[topic] = { type: ["string", "null"] };
  }

  return {
    type: "object",
    properties: {
      quote: { anyOf: [quoteSchema, { type: "null" }] },
      topics: {
        type: "object",
        properties: topicProperties,
        required: Object.keys(NOTE_TOPICS),
        additionalProperties: false,
      },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["quote", "topics", "notes"],
    additionalProperties: false,
  };
}

function parseFields(raw: unknown, industry: IndustryConfig): QuoteFields | null {
  if (raw === null) {
    return null;
  }

  const result = industry.quoteSchema.safeParse(raw);

  if (result.success === false) {
    const issues = z.prettifyError(result.error);
    throw new Error(`The extracted quote did not match the quote schema:\n${issues}`);
  }

  return result.data;
}

function readTopicNotes(topics: TopicNotes | undefined): string[] {
  const notes: string[] = [];

  if (topics === undefined) {
    return notes;
  }

  for (const topic of Object.keys(NOTE_TOPICS) as NoteTopic[]) {
    const note = topics[topic];

    if (typeof note === "string") {
      notes.push(note);
    }
  }

  return notes;
}

// Topic notes come first so they are never the ones cut by the limit.
function cleanNotes(topicNotes: string[], otherNotes: string[]): string[] {
  const trimmed = [...topicNotes, ...otherNotes].map((note) => note.trim());
  const kept: string[] = [];

  for (const note of trimmed) {
    if (note !== "" && kept.includes(note) === false) {
      kept.push(note);
    }
  }

  return kept.slice(0, MAX_NOTES);
}

export function createQuoteExtractor(complete: JsonCompletion): QuoteExtractor {
  async function extract(
    transcript: Omit<TranscriptLine, "at">[],
    industry: IndustryConfig,
  ): Promise<Extraction> {
    // Nothing was said, so there is nothing to ask the model about.
    if (transcript.length === 0) {
      return { fields: null, notes: [] };
    }

    const reply = await complete(
      buildInstructions(industry),
      formatTranscript(transcript),
      buildResponseSchema(industry),
    );
    const envelope = envelopeSchema.parse(JSON.parse(reply));

    return {
      fields: parseFields(envelope.quote, industry),
      notes: cleanNotes(readTopicNotes(envelope.topics), envelope.notes),
    };
  }

  return extract;
}

export function openAIJsonCompletion(apiKey: string, model: string): JsonCompletion {
  const client = new OpenAI({ apiKey, timeout: COMPLETION_TIMEOUT_MS });

  async function complete(
    instructions: string,
    input: string,
    schema: Record<string, unknown>,
  ): Promise<string> {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: input },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "call_quote", schema, strict: false },
      },
    });

    const choice = completion.choices[0];

    if (choice === undefined || choice.message.content === null) {
      throw new Error("OpenAI returned no quote extraction.");
    }

    return choice.message.content;
  }

  return complete;
}
