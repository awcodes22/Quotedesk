import type {
  CallCommand,
  CallOutcome,
  QuoteFields,
  TranscriptLine,
} from "../core/types";
import type { CallContext, CallHandle, CallProvider } from "./types";

export type FakeProviderOptions = {
  stepMs?: number;
  failBusinessIds?: string[];
};

const DEFAULT_STEP_MS = 700;
const COMMAND_LIMIT_MS = 60_000;
const JITTER_RATIO = 0.5;

function pause(stepMs: number): Promise<void> {
  const jitterMs = Math.random() * stepMs * JITTER_RATIO;

  return new Promise((resolve) => {
    setTimeout(resolve, stepMs + jitterMs);
  });
}

class FakeCall {
  private readonly context: CallContext;
  private readonly stepMs: number;
  private readonly noAnswer: boolean;

  private readonly transcript: TranscriptLine[] = [];
  private command: CallCommand | undefined = undefined;
  private finished = false;
  private deliverToWaitingCall: ((command: CallCommand) => void) | undefined =
    undefined;

  constructor(context: CallContext, stepMs: number, noAnswer: boolean) {
    this.context = context;
    this.stepMs = stepMs;
    this.noAnswer = noAnswer;
  }

  send(command: CallCommand): boolean {
    if (this.finished || this.command !== undefined) {
      return false;
    }

    this.command = command;

    if (this.deliverToWaitingCall !== undefined) {
      this.deliverToWaitingCall(command);
    }

    return true;
  }

  async run(): Promise<CallOutcome> {
    try {
      return await this.playScript();
    } catch (error) {
      return this.fail(String(error));
    }
  }

  private async playScript(): Promise<CallOutcome> {
    this.context.onStatus("connecting");
    await pause(this.stepMs);

    if (this.noAnswer) {
      return this.fail("No answer");
    }

    this.context.onStatus("talking");
    await this.openConversation();
    await this.reportQuotes();
    await this.askFollowUp();

    const command = await this.waitForCommand();
    await this.playEnding(command);
    return this.complete(command);
  }

  private say(speaker: TranscriptLine["speaker"], text: string): void {
    const line = { speaker, text };
    this.transcript.push({ ...line, at: Date.now() });
    this.context.onTranscript(line);
  }

  private async openConversation(): Promise<void> {
    const { business, industry, job } = this.context;

    this.say("business", `Hello, ${business.name}, how can I help?`);
    await pause(this.stepMs);
    this.say(
      "agent",
      `Hi, I'm an AI assistant calling for ${industry.clientNoun}. ${job.request}`,
    );
  }

  private async reportQuotes(): Promise<void> {
    const { fakeQuotes } = this.context.business;

    for (const [index, fakeQuote] of fakeQuotes.entries()) {
      await pause(this.stepMs);

      // A decision can land mid-negotiation, and any quote after it would be rejected.
      if (this.command !== undefined) {
        return;
      }

      if (index > 0) {
        this.say("agent", "Is that the best price you can offer?");
      }

      this.reportQuote(fakeQuote);
    }
  }

  private reportQuote(fakeQuote: QuoteFields): void {
    this.say("business", `The total comes to $${fakeQuote.total}.`);

    const result = this.context.reportQuote(fakeQuote);

    if (result.ok) {
      this.context.onStatus("quoted");
    }
  }

  private async askFollowUp(): Promise<void> {
    const followUp = this.context.industry.followUps[0];

    if (followUp === undefined || this.command !== undefined) {
      return;
    }

    await pause(this.stepMs);
    this.say("agent", followUp);
  }

  private waitForCommand(): Promise<CallCommand> {
    return new Promise((resolve) => {
      if (this.command !== undefined) {
        resolve(this.command);
        return;
      }

      // Without clearing this timer, the process would stay alive for the full limit.
      const safetyTimer = setTimeout(() => {
        this.command = "close";
        resolve("close");
      }, COMMAND_LIMIT_MS);

      this.deliverToWaitingCall = (command) => {
        clearTimeout(safetyTimer);
        resolve(command);
      };
    });
  }

  private async playEnding(command: CallCommand): Promise<void> {
    if (command === "commit") {
      await this.playCommit();
    } else {
      await this.playClose();
    }
  }

  private async playCommit(): Promise<void> {
    this.context.onStatus("committed");
    this.say(
      "agent",
      "Thanks for waiting. We'd like to go ahead. Could you email that over in writing?",
    );
    await pause(this.stepMs);
    this.say("business", "Of course, I'll email that over now.");
  }

  private async playClose(): Promise<void> {
    this.context.onStatus("closed");
    this.say("agent", "Thank you for your time. We went with another option.");
    await pause(this.stepMs);
    this.say("business", "No problem. Goodbye.");
  }

  private complete(command: CallCommand): CallOutcome {
    this.finished = true;
    this.context.onStatus("ended");

    return {
      callId: this.context.callId,
      businessId: this.context.business.id,
      status: "completed",
      command,
      transcript: this.transcript,
      notes: [],
    };
  }

  private fail(error: string): CallOutcome {
    this.finished = true;
    this.context.onStatus("failed");

    return {
      callId: this.context.callId,
      businessId: this.context.business.id,
      status: "failed",
      transcript: this.transcript,
      notes: [],
      error,
    };
  }
}

export function fakeProvider(options: FakeProviderOptions = {}): CallProvider {
  let stepMs = DEFAULT_STEP_MS;

  if (options.stepMs !== undefined) {
    stepMs = options.stepMs;
  }

  let failBusinessIds: string[] = [];

  if (options.failBusinessIds !== undefined) {
    failBusinessIds = options.failBusinessIds;
  }

  function startCall(context: CallContext): CallHandle {
    const noAnswer = failBusinessIds.includes(context.business.id);
    const call = new FakeCall(context, stepMs, noAnswer);

    return {
      done: call.run(),
      send: (command) => call.send(command),
    };
  }

  return { name: "fake", startCall };
}
