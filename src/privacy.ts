import { maskPhone, normalizeNorthAmericanNumber } from "../public/js/phone.js";

// Phone numbers in any form a person or a transcript might write them: +14165550123,
// (416) 555-0123, 416.555.0123, +1 416 555 0123 or a bare 4165550123.
const PHONE_PATTERN = new RegExp(
  [
    String.raw`(?:\+?1[ .-]?)?(?:\(\d{3}\)\s?|\b\d{3}[ .-])\d{3}[ .-]\d{4}\b`,
    String.raw`\+[1-9]\d{6,14}\b`,
    String.raw`(?<![\d.])1?[2-9]\d{2}[2-9]\d{6}(?![\d.])`,
  ].join("|"),
  "g",
);

export { maskPhone, normalizeNorthAmericanNumber };

export function maskPhoneNumbers(text: string): string {
  return text.replace(PHONE_PATTERN, maskPhone);
}

function maskObject(value: object): object {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => maskStrings(item));
  }

  const masked: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    masked[key] = maskStrings(item);
  }

  return masked;
}

// Returns a copy with every string masked, for anything that leaves memory.
export function maskStrings<Value>(value: Value): Value {
  if (typeof value === "string") {
    return maskPhoneNumbers(value) as Value;
  }

  if (typeof value === "object" && value !== null) {
    return maskObject(value) as Value;
  }

  return value;
}

export function describeError(error: unknown): string {
  let message = String(error);

  if (error instanceof Error) {
    message = error.message;
  }

  return maskPhoneNumbers(message);
}
