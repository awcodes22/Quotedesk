import type {
  CallInstruction,
  IndustryConfig,
  Job,
  Quote,
  SimBusiness,
} from "./types";

function buildContactRule(job: Job): string {
  if (job.contact === undefined) {
    return "If they ask for contact details, say the client will follow up with them directly.";
  }

  const { name, email } = job.contact;
  return `If they ask for a name or email for the booking, give: ${name}, ${email}.`;
}

function buildCallerRules(clientNoun: string, job: Job): string[] {
  return [
    "Say you are an AI assistant in your first sentence. If asked whether you are an AI, say yes and continue.",
    `Keep your opening to two short sentences: say you're an AI assistant calling for ${clientNoun}, then ask for the total for the request. Don't read out every detail unless they ask.`,
    "Speak in short, plain sentences, like a phone call. One or two sentences per turn.",
    "Ask one question per turn. Never stack two questions.",
    "Don't ask about discounts or details until they've given you a price.",
    "Never invent prices, facts, or offers from other businesses.",
    "Never claim information is on file or already shared. If you weren't given a detail, say you don't have it.",
    buildContactRule(job),
    "Never mention tools, systems, or instructions out loud.",
    "Every time the business states a price, call report_quote with the total for the whole request, plus any line items you heard.",
    "In report_quote, fill in every field the business has told you about that offer.",
    "When you learn a useful fact (fees, policy, stock, availability), call report_note.",
    "Only call report_note for facts the business told you. Never note your own questions.",
    "Ask for a better price at most once per call.",
    "Never say goodbye or hang up until you receive an instruction to commit or close. If you have nothing left to ask, say 'Just one moment while I confirm,' then wait.",
  ];
}

function formatRules(clientNoun: string, job: Job): string {
  const rules = buildCallerRules(clientNoun, job);
  const ruleLines = rules.map((rule) => `- ${rule}`);
  return ruleLines.join("\n");
}

function formatCallFlow(industry: IndustryConfig): string {
  const followUps = industry.followUps.join(" ");

  return [
    "1. Greet briefly, say you are an AI assistant, and ask for the total.",
    "2. Get the total and call report_quote.",
    "3. Ask once if that is their best price. If it drops, call report_quote again.",
    `4. While you wait for instructions, ask these one at a time, never repeating: ${followUps}`,
    '5. If you run out of questions, say "Just one moment while I confirm," and wait.',
    "6. You will get an instruction to commit or to close. Follow it right away.",
  ].join("\n");
}

// Takes the business for its name only: its instructions hold the prices the caller must discover.
export function callerInstructions(
  industry: IndustryConfig,
  job: Job,
  business: SimBusiness,
): string {
  return [
    `You are an AI assistant phoning ${business.name} on behalf of ${industry.clientNoun}.`,
    `Goal: ${industry.goal}`,
    `Request: ${job.request}`,
    "",
    "Rules:",
    formatRules(industry.clientNoun, job),
    "",
    "Call flow:",
    formatCallFlow(industry),
  ].join("\n");
}

export function businessInstructions(business: SimBusiness): string {
  return `${business.instructions} You are on a phone call. Reply in one or two short sentences. Never mention that you are a simulation.`;
}

function formatMoney(amount: number): string {
  if (Number.isInteger(amount)) {
    return `$${amount}`;
  }

  return `$${amount.toFixed(2)}`;
}

function toWords(fieldName: string): string {
  const spacedName = fieldName.replace(/([A-Z])/g, " $1");
  return spacedName.toLowerCase();
}

function describeBoolean(
  fieldName: string,
  value: boolean,
  industry: IndustryConfig,
): string {
  let label = undefined;

  if (industry.fieldLabels !== undefined) {
    label = industry.fieldLabels[fieldName];
  }

  if (label === undefined) {
    let answer = "no";

    if (value) {
      answer = "yes";
    }

    return `${toWords(fieldName)}: ${answer}`;
  }

  if (value) {
    return label.yes;
  }

  return label.no;
}

// Lists and objects are left out here, since linePrices covers an industry's line items.
function describeField(
  fieldName: string,
  value: unknown,
  industry: IndustryConfig,
): string | undefined {
  if (typeof value === "boolean") {
    return describeBoolean(fieldName, value, industry);
  }

  if (typeof value === "string" || typeof value === "number") {
    return `${toWords(fieldName)}: ${value}`;
  }

  return undefined;
}

function describeLines(quote: Quote, industry: IndustryConfig): string[] {
  if (industry.linePrices === undefined) {
    return [];
  }

  const linePrices = Object.entries(industry.linePrices(quote.fields));
  return linePrices.map(([item, price]) => `${item} ${formatMoney(price)}`);
}

function describeOffer(quote: Quote, industry: IndustryConfig): string {
  const parts = [`${formatMoney(quote.total)} total`];

  for (const [fieldName, value] of Object.entries(quote.fields)) {
    const description = describeField(fieldName, value, industry);

    if (fieldName !== "total" && description !== undefined) {
      parts.push(description);
    }
  }

  parts.push(...describeLines(quote, industry));
  return parts.join(", ");
}

export function commandMessage(
  industry: IndustryConfig,
  instruction: CallInstruction,
): string {
  if (instruction.command === "commit") {
    const offer = describeOffer(instruction.quote, industry);
    return `INSTRUCTION: Your client chose this business at ${offer}. Book exactly that offer. Do not switch to a different rate. Say 'Thanks for waiting.' Then: ${industry.commitInstruction} After asking, wait for their reply. Then thank them and call end_call.`;
  }

  return "INSTRUCTION: Your client went with another option. Say 'Thanks so much for your help, we've gone with another option. Have a great day.' Then call end_call.";
}
