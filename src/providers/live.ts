import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CallBrief,
  CallOutcome,
  Job,
  LiveBusiness,
  SimBusiness,
  Stay,
  TranscriptLine,
} from "../core/types";
import { describeError } from "../privacy";
import {
  ASK_ABOUT,
  buildDatesSentence,
  formatSpokenDay,
  formatStayDates,
} from "../../public/js/stay.js";
import type { Conversation, ConversationStatus, ConversationTurn, ElevenLabsClient } from "./elevenLabs";
import type { Extraction, QuoteExtractor } from "./quoteExtractor";
import type { CallContext, CallHandle, CallProvider, SpokenLine } from "./types";

export type LiveLimits = {
  allowedNumbers: string[];
  maxCalls: number;
  callTimeoutMs: number;
  // Whether the dashboard may ring a number typed in for one test call.
  selfTest?: boolean;
  // The name the caller gives, shown in the run header as who the quote is for.
  guestName?: string;
};

export type LiveProviderOptions = LiveLimits & {
  client: ElevenLabsClient;
  extractQuote: QuoteExtractor;
  guestName: string;
  runsDirectory: string;
  pollMs?: number;
  spacingMs?: number;
};

// Twilio starts about one new call per second, so parallel calls are spread a bit wider.
export const CALL_SPACING_MS = 1200;
export const POLL_MS = 3000;

// Time after the last call ends for the transcript, the quote extraction and the audio.
const WRAP_UP_MS = 60_000;
const MAX_POLL_ERRORS = 3;
const AUDIO_ATTEMPTS = 3;

// Re-exported so job runs and wizard runs say dates the same way.
export { formatStayDates };

function requireStay(job: Job): Stay {
  if (job.stay === undefined) {
    throw new Error(`Job "${job.id}" has no stay, so the caller wouldn't know the dates.`);
  }

  return job.stay;
}

// A request written for the text callers may hold ISO dates, which would be read out digit by digit.
export function speakDates(text: string): string {
  return text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, formatSpokenDay);
}

export type CallMode = "test" | "live";

// The agent opens with this line. A test call explains what QuoteDesk does and that this is a test;
// a real call says up front that it is an assistant and that the call may be recorded.
export const FIRST_MESSAGE_INTROS: Record<CallMode, string> = {
  test: "Hi, this is QuoteDesk. I'm an AI that calls hotels for you, gets quotes from several at once, and picks the best deal. This is a test call, so you'll get to see how it works.",
  live: "Hi there, I'm an assistant calling on behalf of a guest who's looking to book a stay. Just so you know, this call may be recorded. Do you have a quick moment to check a rate for me?",
};

export function findCallMode(business: SimBusiness): CallMode {
  if (business.callMode !== undefined) {
    return business.callMode;
  }

  if (business.selfTest === true) {
    return "test";
  }

  return "live";
}

// The variables the call panel shows. The opening line is left out because it is the same on every call.
export const BRIEF_SHOWN = ["request", "dates", "ask_about", "guest_name", "call_mode"];

export function pickBriefShown(variables: Record<string, string>): Record<string, string> {
  const shown: Record<string, string> = {};

  for (const key of BRIEF_SHOWN) {
    const value = variables[key];

    if (value !== undefined) {
      shown[key] = value;
    }
  }

  return shown;
}

// A wizard run brings its own sentences; a job run builds them from the job file.
function findCallBrief(job: Job, guestName: string): CallBrief {
  if (job.callBrief !== undefined) {
    return job.callBrief;
  }

  const stay = requireStay(job);

  return {
    request: speakDates(job.request),
    dates: buildDatesSentence(stay.checkIn, stay.checkOut),
    askAbout: ASK_ABOUT,
    guestName,
  };
}

// Only what the agent may say out loud.
export function buildDynamicVariables(
  job: Job,
  guestName: string,
  callMode: CallMode,
): Record<string, string> {
  const brief = findCallBrief(job, guestName);

  return {
    request: brief.request,
    dates: brief.dates,
    ask_about: brief.askAbout,
    guest_name: brief.guestName,
    call_mode: callMode,
    first_message_intro: FIRST_MESSAGE_INTROS[callMode],
  };
}

// Voice tags such as [happy] steer the voice and were never said out loud.
export function cleanSpokenText(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined) {
    return undefined;
  }

  const withoutTags = text.replace(/\[[^\]]*\]/g, " ");
  const cleaned = withoutTags.replace(/\s+/g, " ").trim();
  const onlyDots = /^[.…\s]*$/.test(cleaned);

  if (onlyDots) {
    return undefined;
  }

  return cleaned;
}

function toSpeaker(role: ConversationTurn["role"]): TranscriptLine["speaker"] {
  if (role === "user") {
    return "business";
  }

  return "agent";
}

export function toTranscriptLines(turns: ConversationTurn[], answeredAt: number): SpokenLine[] {
  const lines: SpokenLine[] = [];

  for (const turn of turns) {
    const text = cleanSpokenText(turn.message);

    if (text !== undefined) {
      const at = answeredAt + turn.time_in_call_secs * 1000;
      lines.push({ speaker: toSpeaker(turn.role), text, at });
    }
  }

  return lines;
}

// Checked before a run starts, so a bad list is refused before anyone is dialed.
export function checkLiveBusinesses(
  businesses: LiveBusiness[],
  limits: LiveLimits,
): string | undefined {
  if (businesses.length === 0) {
    return "This job has no live businesses to call.";
  }

  if (businesses.length > limits.maxCalls) {
    return `This job lists ${businesses.length} businesses, but LIVE_MAX_CALLS allows ${limits.maxCalls}.`;
  }

  for (const business of businesses) {
    if (limits.allowedNumbers.includes(business.phone) === false) {
      return `${business.name} is not on LIVE_ALLOWED_NUMBERS, so it won't be dialed.`;
    }
  }

  return undefined;
}

function slugify(name: string): string {
  const lower = name.toLowerCase();
  const dashed = lower.replace(/[^a-z0-9]+/g, "-");
  return dashed.replace(/^-+|-+$/g, "");
}

// Ids also become file names for the recordings, so they are kept to letters, digits and dashes.
export function toSimBusinesses(businesses: LiveBusiness[]): SimBusiness[] {
  return businesses.map((business, index) => {
    let slug = slugify(business.name);

    if (slug === "") {
      slug = "business";
    }

    return {
      id: `${slug}-${index + 1}`,
      name: business.name,
      instructions: "",
      fakeQuotes: [],
      phone: business.phone,
    };
  });
}

export function liveRunTimeoutMs(callTimeoutMs: number, callCount: number): number {
  return callTimeoutMs + callCount * CALL_SPACING_MS + WRAP_UP_MS;
}

export function audioPath(runsDirectory: string, runId: string, callId: string): string {
  return join(runsDirectory, runId, `${callId}.mp3`);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type CallPlan = {
  options: LiveProviderOptions;
  startDelayMs: number;
  refusal: string | undefined;
};

class LiveCall {
  private readonly context: CallContext;
  private readonly options: LiveProviderOptions;
  private readonly startDelayMs: number;
  private readonly refusal: string | undefined;
  private readonly pollMs: number;

  private readonly transcript: TranscriptLine[] = [];
  private readonly notes: string[] = [];
  private lastStatus: ConversationStatus = "initiated";
  private dialedAt = 0;
  private answeredAt: number | undefined = undefined;

  constructor(context: CallContext, plan: CallPlan) {
    this.context = context;
    this.options = plan.options;
    this.startDelayMs = plan.startDelayMs;
    this.refusal = plan.refusal;
    this.pollMs = POLL_MS;

    if (plan.options.pollMs !== undefined) {
      this.pollMs = plan.options.pollMs;
    }
  }

  async run(): Promise<CallOutcome> {
    if (this.refusal !== undefined) {
      return this.fail(this.refusal);
    }

    try {
      return await this.playCall();
    } catch (error) {
      return this.fail(describeError(error));
    }
  }

  private async playCall(): Promise<CallOutcome> {
    const phone = this.requirePhone();
    const callMode = findCallMode(this.context.business);
    const variables = buildDynamicVariables(this.context.job, this.options.guestName, callMode);

    await pause(this.startDelayMs);

    const conversationId = await this.options.client.startOutboundCall(phone, variables);
    this.dialedAt = Date.now();
    this.context.reportBrief(pickBriefShown(variables));
    this.context.onStatus("connecting");

    const conversation = await this.waitForEnd(conversationId);
    await this.reportConversation(conversation);
    await this.saveAudio(conversationId);
    return this.complete();
  }

  private requirePhone(): string {
    const phone = this.context.business.phone;

    if (phone === undefined) {
      throw new Error(`${this.context.business.name} has no phone number.`);
    }

    return phone;
  }

  private async waitForEnd(conversationId: string): Promise<Conversation> {
    const deadline = this.dialedAt + this.options.callTimeoutMs;
    let errorsInARow = 0;

    while (Date.now() < deadline) {
      await pause(this.pollMs);

      const conversation = await this.lookUp(conversationId, errorsInARow);

      if (conversation === undefined) {
        errorsInARow += 1;
      } else {
        errorsInARow = 0;
      }

      if (conversation !== undefined && this.isFinished(conversation.status)) {
        return conversation;
      }
    }

    const minutes = Math.round(this.options.callTimeoutMs / 60_000);
    throw new Error(`The call had no result after ${minutes} minutes.`);
  }

  // One dropped request shouldn't end a call that is still going, but a run of them does.
  private async lookUp(
    conversationId: string,
    errorsSoFar: number,
  ): Promise<Conversation | undefined> {
    try {
      return await this.options.client.getConversation(conversationId);
    } catch (error) {
      if (errorsSoFar + 1 >= MAX_POLL_ERRORS) {
        throw error;
      }

      return undefined;
    }
  }

  private isFinished(status: ConversationStatus): boolean {
    this.reportStatusChange(status);

    if (status === "failed") {
      throw new Error("The call failed or nobody answered.");
    }

    return status === "done";
  }

  private reportStatusChange(status: ConversationStatus): void {
    if (status === this.lastStatus) {
      return;
    }

    this.lastStatus = status;

    if (status === "in-progress") {
      this.answeredAt = Date.now();
      this.context.onStatus("talking");
    }
  }

  private async reportConversation(conversation: Conversation): Promise<void> {
    let answeredAt = this.dialedAt;

    if (this.answeredAt !== undefined) {
      answeredAt = this.answeredAt;
    }

    const lines = toTranscriptLines(conversation.transcript, answeredAt);

    for (const line of lines) {
      this.context.onTranscript(line);
      this.transcript.push({ speaker: line.speaker, text: line.text, at: Date.now() });
    }

    await this.reportQuote(lines);
  }

  // The call itself went fine, so a failed read keeps its transcript and recording.
  private async reportQuote(lines: SpokenLine[]): Promise<void> {
    let extraction: Extraction;

    try {
      extraction = await this.options.extractQuote(lines, this.context.industry);
    } catch (error) {
      this.context.reportNote(`The price could not be read from the call: ${describeError(error)}`);
      return;
    }

    for (const note of extraction.notes) {
      this.notes.push(note);
      this.context.reportNote(note);
    }

    if (extraction.fields === null) {
      return;
    }

    const result = this.context.reportQuote(extraction.fields);

    if (result.ok) {
      this.context.onStatus("quoted");
    }
  }

  // The recording is a bonus, so a failed download never fails the call.
  private async saveAudio(conversationId: string): Promise<void> {
    const path = audioPath(this.options.runsDirectory, this.context.runId, this.context.callId);

    for (let attempt = 1; attempt <= AUDIO_ATTEMPTS; attempt += 1) {
      try {
        const audio = await this.options.client.getAudio(conversationId);
        await mkdir(join(this.options.runsDirectory, this.context.runId), { recursive: true });
        await writeFile(path, audio);
        return;
      } catch (error) {
        if (attempt === AUDIO_ATTEMPTS) {
          console.error(`Recording for ${this.context.callId} not saved: ${describeError(error)}`);
          return;
        }

        await pause(this.pollMs);
      }
    }
  }

  private complete(): CallOutcome {
    this.context.onStatus("ended");

    return {
      callId: this.context.callId,
      businessId: this.context.business.id,
      status: "completed",
      transcript: this.transcript,
      notes: this.notes,
    };
  }

  // The reason goes in as a note, which is the only place the dashboard shows it.
  private fail(error: string): CallOutcome {
    this.context.reportNote(`Call failed: ${error}`);
    this.context.onStatus("failed");

    return {
      callId: this.context.callId,
      businessId: this.context.business.id,
      status: "failed",
      transcript: this.transcript,
      notes: this.notes,
      error,
    };
  }
}

function findRefusal(
  context: CallContext,
  options: LiveProviderOptions,
  callsStarted: number,
): string | undefined {
  const phone = context.business.phone;
  // A typed-in test number or a hotel picked from Places search was approved for this run alone,
  // so it skips the allowlist.
  const approvedForRun = context.business.selfTest === true || context.business.approvedForRun === true;

  if (callsStarted >= options.maxCalls) {
    return `LIVE_MAX_CALLS allows ${options.maxCalls} calls per run.`;
  }

  if (phone === undefined) {
    return `${context.business.name} has no phone number, so it was not dialed.`;
  }

  if (approvedForRun === false && options.allowedNumbers.includes(phone) === false) {
    return `${context.business.name} is not on LIVE_ALLOWED_NUMBERS, so it was not dialed.`;
  }

  return undefined;
}

// Live calls only gather quotes. The head agent's pick is a recommendation and nobody is booked.
export function liveProvider(options: LiveProviderOptions): CallProvider {
  let spacingMs = CALL_SPACING_MS;
  let callsStarted = 0;
  let nextStartAt = 0;

  if (options.spacingMs !== undefined) {
    spacingMs = options.spacingMs;
  }

  function reserveStartDelay(): number {
    const now = Date.now();
    const startAt = Math.max(now, nextStartAt);
    nextStartAt = startAt + spacingMs;
    return startAt - now;
  }

  function startCall(context: CallContext): CallHandle {
    const refusal = findRefusal(context, options, callsStarted);
    let startDelayMs = 0;

    if (refusal === undefined) {
      callsStarted += 1;
      startDelayMs = reserveStartDelay();
    }

    const call = new LiveCall(context, { options, startDelayMs, refusal });

    return {
      done: call.run(),
      send: () => false,
    };
  }

  return { name: "live", startCall, recommendsOnly: true };
}
