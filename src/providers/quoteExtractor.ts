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
const MAX_NOTES = 4;

const envelopeSchema = z.object({
  quote: z.unknown().nullable(),
  notes: z.array(z.string()),
});

function buildInstructions(industry: IndustryConfig): string {
  return [
    `You read the transcript of a phone call where an AI caller asked a ${industry.businessNoun.singular} for a price.`,
    `The caller's goal: ${industry.goal}`,
    "Set quote to the final total the business confirmed for the whole request, after any discount the business agreed to.",
    "Only fill a field the business actually stated. Leave out anything it did not say.",
    "If the business never gave a price, set quote to null.",
    `Add up to ${MAX_NOTES} short notes about what the business said that a client would want to know, such as discounts, extra fees, cancellation terms or breakfast.`,
    "Each note is one short sentence. Never note what the caller said.",
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

  return {
    type: "object",
    properties: {
      quote: { anyOf: [quoteSchema, { type: "null" }] },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["quote", "notes"],
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

function cleanNotes(notes: string[]): string[] {
  const trimmed = notes.map((note) => note.trim());
  const kept = trimmed.filter((note) => note !== "");
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
      notes: cleanNotes(envelope.notes),
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
