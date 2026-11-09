import type { ExtractedQuote, QuoteFields } from "../core/types";

// Said when the rate can't be undone: "non-refundable", "no refunds", "it can't be cancelled".
const NON_REFUNDABLE =
  /\bnon[- ]?refundable\b|\bnot refundable\b|\bno refunds?\b|\b(?:can'?t|cannot|can not) be (?:cancell?ed|refunded)\b|\b(?:can'?t|cannot) (?:cancel|get a refund)\b/i;

// Said when cancelling costs nothing, even with a deadline: "free cancellation up to 2 days before".
const FREE_CANCELLATION =
  /\bfree cancell?ation\b|\bcancell?ation is free\b|\bfree to cancel\b|\bcancel(?:l?ed)? (?:it )?(?:for )?free\b|\bcancel\b[^.!?]{0,60}\b(?:without|no) (?:charge|fee|penalty|cost)\b/i;

const CANCELLATION_WORDS = /cancel|refund/i;

type CancellationTerms = {
  saysFree: boolean;
  saysNonRefundable: boolean;
};

function readCancellationTerms(businessLines: string[]): CancellationTerms {
  const spoken = businessLines.join(" ");

  return {
    saysFree: FREE_CANCELLATION.test(spoken),
    saysNonRefundable: NON_REFUNDABLE.test(spoken),
  };
}

function withoutFreeCancellation(fields: QuoteFields): QuoteFields {
  const copy: QuoteFields = { ...fields };
  delete copy.freeCancellation;
  return copy;
}

// A deadline ("up to 2 days before") still means free cancellation. Non-refundable needs the
// business to say the rate can't be cancelled or refunded. If both come up, the model's reading stands.
function correctFreeCancellation(fields: QuoteFields, terms: CancellationTerms): QuoteFields {
  if (terms.saysFree && terms.saysNonRefundable === false) {
    return { ...fields, freeCancellation: true };
  }

  if (terms.saysNonRefundable && terms.saysFree === false) {
    return { ...fields, freeCancellation: false };
  }

  if (fields.freeCancellation === false && terms.saysNonRefundable === false) {
    return withoutFreeCancellation(fields);
  }

  return fields;
}

function findCancellationSentence(businessLines: string[]): string | undefined {
  const sentences = businessLines.flatMap((line) => line.split(/(?<=[.!?])\s+/));
  const found = sentences.find((sentence) => CANCELLATION_WORDS.test(sentence));

  if (found === undefined) {
    return undefined;
  }

  return found.trim();
}

// The deadline lives in the notes, quoted from the business, so it is never made up.
function keepDeadlineNote(notes: string[], businessLines: string[]): string[] {
  const hasCancellationNote = notes.some((note) => CANCELLATION_WORDS.test(note));

  if (hasCancellationNote) {
    return notes;
  }

  const sentence = findCancellationSentence(businessLines);

  if (sentence === undefined) {
    return notes;
  }

  return [...notes, sentence];
}

export function reviewHotelExtraction(
  extracted: ExtractedQuote,
  businessLines: string[],
): ExtractedQuote {
  if (extracted.fields === null) {
    return extracted;
  }

  const terms = readCancellationTerms(businessLines);
  const fields = correctFreeCancellation(extracted.fields, terms);
  let notes = extracted.notes;

  if (fields.freeCancellation === true) {
    notes = keepDeadlineNote(notes, businessLines);
  }

  return { fields, notes };
}
