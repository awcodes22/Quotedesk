import OpenAI from "openai";
import { z } from "zod";
import {
  businessInstructions,
  callerInstructions,
  commandMessage,
} from "../core/prompts";
import type {
  CallCommand,
  CallInstruction,
  CallOutcome,
  CallStatus,
  IndustryConfig,
  TranscriptLine,
} from "../core/types";
import type { CallContext, CallHandle, CallProvider } from "./types";

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatReply = {
  content: string | null;
  toolCalls: ToolCall[];
};

export type ChatFunction = (
  messages: ChatMessage[],
  tools?: ToolDefinition[],
) => Promise<ChatReply>;

export type TextSimOptions = {
  chat: ChatFunction;
  maxTurns: number;
  waitForCommandMs: number;
};

type ToolResult = { ok: true } | { ok: false; error: string };

type OpenAIMessage = OpenAI.Chat.ChatCompletionMessageParam;
type OpenAIAssistantMessage = OpenAI.Chat.ChatCompletionAssistantMessageParam;
type OpenAIToolCall = OpenAI.Chat.ChatCompletionMessageFunctionToolCall;
type OpenAITool = OpenAI.Chat.ChatCompletionFunctionTool;
type OpenAIReplyToolCall = OpenAI.Chat.ChatCompletionMessageToolCall;

const CHAT_TIMEOUT_MS = 30_000;
const MAX_TOOL_ROUNDS = 3;
const MAX_TURNS_AFTER_COMMAND = 3;
const FIRST_TURN_AFTER_REPLY = 2;
const PHONE_RINGS = "(The phone rings. Answer it.)";
const EMPTY_BUSINESS_REPLY = "Sorry, could you repeat that?";

const noteSchema = z.object({ text: z.string().min(1) });

function toOpenAIToolCall(toolCall: ToolCall): OpenAIToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: { name: toolCall.name, arguments: toolCall.arguments },
  };
}

// The API rejects an empty tool_calls list, and null content without tool calls.
function toOpenAIAssistantMessage(
  content: string | null,
  toolCalls: ToolCall[] | undefined,
): OpenAIAssistantMessage {
  if (toolCalls !== undefined && toolCalls.length > 0) {
    return {
      role: "assistant",
      content,
      tool_calls: toolCalls.map(toOpenAIToolCall),
    };
  }

  let text = "";

  if (content !== null) {
    text = content;
  }

  return { role: "assistant", content: text };
}

function toOpenAIMessage(message: ChatMessage): OpenAIMessage {
  if (message.role === "assistant") {
    return toOpenAIAssistantMessage(message.content, message.toolCalls);
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  return { role: message.role, content: message.content };
}

function toOpenAITool(tool: ToolDefinition): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toOpenAITools(
  tools: ToolDefinition[] | undefined,
): OpenAITool[] | undefined {
  if (tools === undefined) {
    return undefined;
  }

  return tools.map(toOpenAITool);
}

function fromOpenAIToolCalls(
  toolCalls: OpenAIReplyToolCall[] | undefined,
): ToolCall[] {
  const keptToolCalls: ToolCall[] = [];

  if (toolCalls === undefined) {
    return keptToolCalls;
  }

  for (const toolCall of toolCalls) {
    if (toolCall.type === "function") {
      keptToolCalls.push({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }
  }

  return keptToolCalls;
}

export function openAIChat(apiKey: string, model: string): ChatFunction {
  // The SDK waits ten minutes by default, far longer than a whole run may take.
  const client = new OpenAI({ apiKey, timeout: CHAT_TIMEOUT_MS });

  async function chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): Promise<ChatReply> {
    const completion = await client.chat.completions.create({
      model,
      messages: messages.map(toOpenAIMessage),
      tools: toOpenAITools(tools),
    });

    const choice = completion.choices[0];

    if (choice === undefined) {
      throw new Error("OpenAI returned no reply.");
    }

    return {
      content: choice.message.content,
      toolCalls: fromOpenAIToolCalls(choice.message.tool_calls),
    };
  }

  return chat;
}

function buildQuoteParameters(
  industry: IndustryConfig,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = {
    ...z.toJSONSchema(industry.quoteSchema),
  };

  // OpenAI's tool format doesn't expect this key.
  delete parameters.$schema;
  return parameters;
}

export function buildTools(industry: IndustryConfig): ToolDefinition[] {
  return [
    {
      name: "report_quote",
      description:
        "Report the price the business just stated, as the total for the whole request.",
      parameters: buildQuoteParameters(industry),
    },
    {
      name: "report_note",
      description: "Record a useful fact learned on the call.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      name: "end_call",
      description: "Hang up. Only use this after an instruction to commit or close.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
}

function getSpokenText(content: string | null): string | undefined {
  if (content === null) {
    return undefined;
  }

  const text = content.trim();

  if (text === "") {
    return undefined;
  }

  return text;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

class TextSimCall {
  private readonly context: CallContext;
  private readonly chat: ChatFunction;
  private readonly maxTurns: number;
  private readonly waitForCommandMs: number;
  private readonly tools: ToolDefinition[];

  private readonly callerHistory: ChatMessage[];
  private readonly businessHistory: ChatMessage[];
  private readonly transcript: TranscriptLine[] = [];
  private readonly notes: string[] = [];

  private pendingInstruction: CallInstruction | undefined = undefined;
  private command: CallCommand | undefined = undefined;
  private ended = false;
  private hasQuoted = false;
  private callerTurnsSinceQuote = 0;
  private callerTurnsSinceCommand = 0;
  private spokeSinceCommand = false;
  private wakeWaitingCall: (() => void) | undefined = undefined;

  constructor(context: CallContext, options: TextSimOptions) {
    const { business, industry, job } = context;

    this.context = context;
    this.chat = options.chat;
    this.maxTurns = options.maxTurns;
    this.waitForCommandMs = options.waitForCommandMs;
    this.tools = buildTools(industry);
    this.callerHistory = [
      {
        role: "system",
        content: callerInstructions(industry, job, business),
      },
    ];
    this.businessHistory = [
      { role: "system", content: businessInstructions(business) },
    ];
  }

  send(instruction: CallInstruction): boolean {
    if (this.ended || this.hasNoCommand() === false) {
      return false;
    }

    this.pendingInstruction = instruction;

    if (this.wakeWaitingCall !== undefined) {
      this.wakeWaitingCall();
    }

    return true;
  }

  async run(): Promise<CallOutcome> {
    try {
      await this.playCall();
      return this.complete();
    } catch (error) {
      return this.fail(getErrorMessage(error));
    }
  }

  private async playCall(): Promise<void> {
    this.context.onStatus("connecting");
    this.context.onStatus("talking");

    this.businessHistory.push({ role: "user", content: PHONE_RINGS });
    await this.takeBusinessTurn();

    const finished = await this.runTurns();

    if (finished === false) {
      await this.finishAfterTurnLimit();
    }
  }

  private async runTurns(): Promise<boolean> {
    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      if (this.shouldWaitQuietly()) {
        await this.waitForCommand();
      }

      const finished = await this.takeRound();

      if (finished) {
        return true;
      }
    }

    return false;
  }

  // send() has told the run this call will act, so a command outlives the turn limit.
  private async finishAfterTurnLimit(): Promise<void> {
    if (this.hasQuoted && this.hasNoCommand()) {
      await this.waitForCommand();
    }

    if (this.hasNoCommand()) {
      return;
    }

    let finished = false;

    while (finished === false) {
      finished = await this.takeRound();
    }
  }

  private async takeRound(): Promise<boolean> {
    this.applyPendingCommand();
    await this.takeCallerTurn();

    if (this.isConversationOver()) {
      return true;
    }

    await this.takeBusinessTurn();
    return false;
  }

  private hasNoCommand(): boolean {
    return this.command === undefined && this.pendingInstruction === undefined;
  }

  private shouldWaitQuietly(): boolean {
    const followUpCount = this.context.industry.followUps.length;
    const outOfQuestions = this.callerTurnsSinceQuote > followUpCount + 1;

    return this.hasQuoted && this.hasNoCommand() && outOfQuestions;
  }

  private waitForCommand(): Promise<void> {
    return new Promise((resolve) => {
      // Without clearing this timer, the process would stay alive after the call.
      const waitTimer = setTimeout(resolve, this.waitForCommandMs);

      this.wakeWaitingCall = () => {
        clearTimeout(waitTimer);
        resolve();
      };
    });
  }

  private applyPendingCommand(): void {
    if (this.pendingInstruction === undefined) {
      return;
    }

    const instruction = this.pendingInstruction;
    this.pendingInstruction = undefined;
    this.command = instruction.command;

    let status: CallStatus = "closed";

    if (instruction.command === "commit") {
      status = "committed";
    }

    this.context.onStatus(status);

    const content = commandMessage(this.context.industry, instruction);
    this.callerHistory.push({ role: "system", content });
  }

  private isConversationOver(): boolean {
    const turnsUsedUp =
      this.callerTurnsSinceCommand >= MAX_TURNS_AFTER_COMMAND;

    return this.ended || turnsUsedUp;
  }

  private say(speaker: TranscriptLine["speaker"], text: string): void {
    const line = { speaker, text };
    this.transcript.push({ ...line, at: Date.now() });
    this.context.onTranscript(line);
  }

  private async takeBusinessTurn(): Promise<void> {
    const reply = await this.chat(this.businessHistory);

    let text = EMPTY_BUSINESS_REPLY;
    const spokenText = getSpokenText(reply.content);

    if (spokenText !== undefined) {
      text = spokenText;
    }

    this.businessHistory.push({ role: "assistant", content: text });
    this.callerHistory.push({ role: "user", content: text });
    this.say("business", text);
  }

  private countCallerTurn(): void {
    if (this.hasQuoted) {
      this.callerTurnsSinceQuote += 1;
    }

    if (this.command !== undefined) {
      this.callerTurnsSinceCommand += 1;
    }
  }

  private async takeCallerTurn(): Promise<void> {
    this.countCallerTurn();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const spoke = await this.askCaller();

      if (spoke || this.ended) {
        return;
      }
    }
  }

  private async askCaller(): Promise<boolean> {
    const reply = await this.chat(this.callerHistory, this.tools);
    const spokenText = getSpokenText(reply.content);

    this.callerHistory.push({
      role: "assistant",
      content: reply.content,
      toolCalls: reply.toolCalls,
    });

    // Noted before the tools run, so a goodbye and end_call in one reply counts as spoken.
    if (spokenText !== undefined && this.command !== undefined) {
      this.spokeSinceCommand = true;
    }

    this.runToolCalls(reply.toolCalls);

    if (spokenText === undefined) {
      return false;
    }

    this.say("agent", spokenText);
    this.businessHistory.push({ role: "user", content: spokenText });
    return true;
  }

  private runToolCalls(toolCalls: ToolCall[]): void {
    for (const toolCall of toolCalls) {
      const result = this.runTool(toolCall);

      this.callerHistory.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  // A model's mistake goes back to the model so it can recover, rather than ending the call.
  private runTool(toolCall: ToolCall): ToolResult {
    try {
      return this.dispatchTool(toolCall);
    } catch (error) {
      return { ok: false, error: getErrorMessage(error) };
    }
  }

  private dispatchTool(toolCall: ToolCall): ToolResult {
    switch (toolCall.name) {
      case "report_quote":
        return this.reportQuote(toolCall.arguments);
      case "report_note":
        return this.reportNote(toolCall.arguments);
      case "end_call":
        return this.endCall();
      default:
        return { ok: false, error: `Unknown tool: ${toolCall.name}` };
    }
  }

  private reportQuote(toolArguments: string): ToolResult {
    const raw: unknown = JSON.parse(toolArguments);
    const result = this.context.reportQuote(raw);

    if (result.ok === false) {
      return { ok: false, error: result.error };
    }

    this.hasQuoted = true;
    this.context.onStatus("quoted");
    return { ok: true };
  }

  private reportNote(toolArguments: string): ToolResult {
    const raw: unknown = JSON.parse(toolArguments);
    const note = noteSchema.parse(raw);

    this.notes.push(note.text);
    this.context.reportNote(note.text);
    return { ok: true };
  }

  private findHangUpRefusal(): string | undefined {
    // send() has told the run this call will act, so it can't hang up before it does.
    if (this.pendingInstruction !== undefined) {
      return "Stay on the line for your instruction.";
    }

    // This call may win, and a caller who has hung up can't be told to commit.
    if (this.hasQuoted && this.hasNoCommand()) {
      return "Stay on the line. Your instruction is coming.";
    }

    // A booking isn't made until the business has answered the request for it.
    const awaitingReply = this.callerTurnsSinceCommand < FIRST_TURN_AFTER_REPLY;

    if (this.command === "commit" && awaitingReply) {
      return "Wait for their reply before ending the call.";
    }

    // Hanging up in silence on a business that spent time quoting is rude.
    if (this.command === "close" && this.spokeSinceCommand === false) {
      return "Say goodbye before ending the call.";
    }

    return undefined;
  }

  private endCall(): ToolResult {
    const refusal = this.findHangUpRefusal();

    if (refusal !== undefined) {
      return { ok: false, error: refusal };
    }

    this.ended = true;
    return { ok: true };
  }

  private complete(): CallOutcome {
    this.ended = true;
    this.context.onStatus("ended");

    return {
      callId: this.context.callId,
      businessId: this.context.business.id,
      status: "completed",
      command: this.command,
      transcript: this.transcript,
      notes: this.notes,
    };
  }

  private fail(error: string): CallOutcome {
    this.ended = true;
    this.context.onStatus("failed");

    return {
      callId: this.context.callId,
      businessId: this.context.business.id,
      status: "failed",
      command: this.command,
      transcript: this.transcript,
      notes: this.notes,
      error,
    };
  }
}

export function textSimProvider(options: TextSimOptions): CallProvider {
  function startCall(context: CallContext): CallHandle {
    const call = new TextSimCall(context, options);

    return {
      done: call.run(),
      send: (instruction) => call.send(instruction),
    };
  }

  return { name: "text", startCall };
}
