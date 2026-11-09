import { afterEach, describe, expect, it, vi } from "vitest";
import { onEvent } from "../src/core/events";
import type { AgentEvent } from "../src/core/events";
import {
  businessInstructions,
  callerInstructions,
  commandMessage,
} from "../src/core/prompts";
import { runJob } from "../src/core/run";
import type { RunOptions } from "../src/core/run";
import type {
  IndustryConfig,
  Job,
  Quote,
  QuoteFields,
  SimBusiness,
} from "../src/core/types";
import { carRentals } from "../src/industries/carRentals";
import { hotels } from "../src/industries/hotels";
import { createProvider } from "../src/providers/index";
import {
  buildTools,
  openAIChat,
  textSimProvider,
} from "../src/providers/textSim";
import type {
  ChatFunction,
  ChatMessage,
  ChatReply,
  ToolCall,
} from "../src/providers/textSim";
import type { CallContext } from "../src/providers/types";

type CallerScript = (messages: ChatMessage[]) => ChatReply;

const unsubscribers: (() => void)[] = [];

const hotelJob: Job = {
  id: "test-hotel",
  industryId: "hotels",
  title: "Test stay",
  request: "A room for two nights.",
};

const oneHotelJob: Job = { ...hotelJob, businessIds: ["harbour-inn"] };

const testOptions: RunOptions = {
  maxParallelCalls: 3,
  decisionWindowMs: 2_000,
  runTimeoutMs: 5_000,
  settleGraceMs: 50,
  priceFlagPct: 10,
};

const noGraceOptions: RunOptions = { ...testOptions, settleGraceMs: 0 };

function findPrice(text: string): number | undefined {
  const match = /\$(\d+)/.exec(text);

  if (match === null) {
    return undefined;
  }

  return Number(match[1]);
}

function buildToolCall(name: string, toolArguments: string): ToolCall {
  return { id: `tool-${name}`, name, arguments: toolArguments };
}

function speak(text: string): ChatReply {
  return { content: text, toolCalls: [] };
}

function useTools(...toolCalls: ToolCall[]): ChatReply {
  return { content: null, toolCalls };
}

function reportTotal(total: number): ToolCall {
  return buildToolCall("report_quote", JSON.stringify({ total }));
}

function endCall(): ToolCall {
  return buildToolCall("end_call", "{}");
}

function hasInstruction(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "system" && message.content.startsWith("INSTRUCTION"),
  );
}

function hasSpoken(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) => message.role === "assistant" && message.content !== null,
  );
}

function findLastPrice(messages: ChatMessage[]): number | undefined {
  const lastMessage = messages.at(-1);

  if (lastMessage === undefined || lastMessage.role !== "user") {
    return undefined;
  }

  return findPrice(lastMessage.content);
}

function scriptedCaller(messages: ChatMessage[]): ChatReply {
  if (hasInstruction(messages)) {
    return { content: "Goodbye.", toolCalls: [endCall()] };
  }

  if (hasSpoken(messages) === false) {
    return speak("Hi, I'm an AI assistant calling about a room.");
  }

  const price = findLastPrice(messages);

  if (price !== undefined) {
    return useTools(reportTotal(price));
  }

  return speak("Is breakfast included?");
}

function scriptedBusiness(messages: ChatMessage[]): ChatReply {
  const systemMessage = messages[0];

  if (systemMessage === undefined || systemMessage.role !== "system") {
    throw new Error("The business needs a system message.");
  }

  const price = findPrice(systemMessage.content);
  return speak(`The total is $${price}.`);
}

function buildChat(caller: CallerScript): ChatFunction {
  async function chat(
    messages: ChatMessage[],
    tools?: unknown[],
  ): Promise<ChatReply> {
    if (tools === undefined) {
      return scriptedBusiness(messages);
    }

    return caller(messages);
  }

  return chat;
}

function buildProvider(caller: CallerScript, maxTurns: number = 14) {
  return textSimProvider({
    chat: buildChat(caller),
    maxTurns,
    waitForCommandMs: 1_000,
  });
}

function collectEvents(): AgentEvent[] {
  const events: AgentEvent[] = [];
  const unsubscribe = onEvent((event) => {
    events.push(event);
  });
  unsubscribers.push(unsubscribe);
  return events;
}

function getAlertCodes(events: AgentEvent[]): string[] {
  const alerts = events.filter((event) => event.type === "alert");
  return alerts.map((alert) => alert.code);
}

function getTranscriptLines(events: AgentEvent[]) {
  const transcripts = events.filter((event) => event.type === "transcript");
  return transcripts.map((event) => event.line);
}

function getToolResults(messages: ChatMessage[]): string[] {
  const results: string[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      results.push(message.content);
    }
  }

  return results;
}

function countActiveTimers(): number {
  const resources = process.getActiveResourcesInfo();
  return resources.filter((resource) => resource === "Timeout").length;
}

function getBusiness(id: string): SimBusiness {
  const business = hotels.simBusinesses.find(
    (candidate) => candidate.id === id,
  );

  if (business === undefined) {
    throw new Error(`No sim business named ${id}.`);
  }

  return business;
}

function buildCallContext(): CallContext {
  return {
    runId: "run-test",
    callId: "call-1",
    job: oneHotelJob,
    industry: hotels,
    business: getBusiness("harbour-inn"),
    reportQuote: () => ({ ok: false, error: "Not used" }),
    reportNote: () => {},
    onStatus: () => {},
    onTranscript: () => {},
  };
}

function buildQuote(fields: QuoteFields): Quote {
  return {
    callId: "call-1",
    businessId: "business-1",
    total: fields.total,
    fields,
    receivedAt: 1,
  };
}

function buildCommitMessage(
  industry: IndustryConfig,
  fields: QuoteFields,
): string {
  return commandMessage(industry, {
    command: "commit",
    quote: buildQuote(fields),
  });
}

function getBusinessLines(events: AgentEvent[], businessId: string): string[] {
  const texts: string[] = [];

  for (const event of events) {
    if (event.type === "transcript" && event.businessId === businessId) {
      texts.push(event.line.text);
    }
  }

  return texts;
}

function buildOpenAIResponse(message: unknown): Response {
  const body = JSON.stringify({ choices: [{ message }] });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) {
    unsubscribe();
  }

  vi.unstubAllGlobals();
});

describe("a text sim run", () => {
  it("commits to the cheapest hotel and closes the others", async () => {
    const events = collectEvents();
    const provider = buildProvider(scriptedCaller);

    const report = await runJob(hotelJob, hotels, provider, testOptions);

    expect(report.provider).toBe("text");
    expect(report.decision).toMatchObject({
      kind: "commit",
      winner: { businessId: "harbour-inn", total: 412 },
    });
    expect(report.calls).toEqual([
      expect.objectContaining({
        businessId: "harbour-inn",
        status: "completed",
        command: "commit",
      }),
      expect.objectContaining({
        businessId: "queen-west-suites",
        status: "completed",
        command: "close",
      }),
      expect.objectContaining({
        businessId: "union-station-hotel",
        status: "completed",
        command: "close",
      }),
    ]);

    const lines = getTranscriptLines(events);
    const agentTexts = lines
      .filter((line) => line.speaker === "agent")
      .map((line) => line.text);

    expect(lines[0]).toMatchObject({ speaker: "business" });
    expect(agentTexts.join(" ")).toContain("AI assistant");
  });

  it("leaves no timers running after the run", async () => {
    const timersBefore = countActiveTimers();
    const provider = buildProvider(scriptedCaller);

    await runJob(hotelJob, hotels, provider, testOptions);

    expect(countActiveTimers()).toBeLessThanOrEqual(timersBefore);
  });

  it("makes every call fail with the chat error, and decides none", async () => {
    async function failingChat(): Promise<ChatReply> {
      throw new Error("Model unavailable");
    }

    const provider = textSimProvider({
      chat: failingChat,
      maxTurns: 14,
      waitForCommandMs: 1_000,
    });

    const report = await runJob(hotelJob, hotels, provider, testOptions);

    expect(report.decision).toEqual({ kind: "none", reason: "no-quotes" });
    expect(report.calls).toHaveLength(3);

    for (const call of report.calls) {
      expect(call).toMatchObject({
        status: "failed",
        error: "Model unavailable",
      });
    }
  });
});

describe("the turn loop", () => {
  it("waits quietly once the caller runs out of questions", async () => {
    const events = collectEvents();
    const options = { ...testOptions, settleGraceMs: 200 };

    await runJob(oneHotelJob, hotels, buildProvider(scriptedCaller), options);

    const decisionIndex = events.findIndex(
      (event) => event.type === "decision",
    );
    const linesBeforeDecision = getTranscriptLines(
      events.slice(0, decisionIndex),
    );
    const agentLines = linesBeforeDecision.filter(
      (line) => line.speaker === "agent",
    );

    // The greeting, the quoting turn, then the follow-ups plus two more turns.
    expect(agentLines).toHaveLength(hotels.followUps.length + 4);
  });

  it("asks the model at most 3 times for one silent turn", async () => {
    let callerRequests = 0;

    function caller(): ChatReply {
      callerRequests += 1;
      const note = JSON.stringify({ text: "Still thinking" });
      return useTools(buildToolCall("report_note", note));
    }

    await runJob(
      oneHotelJob,
      hotels,
      buildProvider(caller, 1),
      testOptions,
    );

    expect(callerRequests).toBe(3);
  });

  it("passes the caller's words to the business", async () => {
    let businessHistory: ChatMessage[] = [];

    async function chat(
      messages: ChatMessage[],
      tools?: unknown[],
    ): Promise<ChatReply> {
      if (tools === undefined) {
        businessHistory = [...messages];
        return scriptedBusiness(messages);
      }

      return scriptedCaller(messages);
    }

    const provider = textSimProvider({
      chat,
      maxTurns: 14,
      waitForCommandMs: 1_000,
    });

    await runJob(oneHotelJob, hotels, provider, testOptions);

    expect(businessHistory).toContainEqual({
      role: "user",
      content: "Hi, I'm an AI assistant calling about a room.",
    });
  });

  it("replaces an empty business reply so the call can continue", async () => {
    const events = collectEvents();

    async function chat(
      messages: ChatMessage[],
      tools?: unknown[],
    ): Promise<ChatReply> {
      if (tools === undefined) {
        return speak("   ");
      }

      return scriptedCaller(messages);
    }

    const provider = textSimProvider({
      chat,
      maxTurns: 1,
      waitForCommandMs: 1_000,
    });

    await runJob(oneHotelJob, hotels, provider, testOptions);

    expect(getTranscriptLines(events)[0]).toMatchObject({
      speaker: "business",
      text: "Sorry, could you repeat that?",
    });
  });
});

describe("the caller's tools", () => {
  it("returns bad JSON to the model and keeps the call going", async () => {
    let sentBadJson = false;
    let historySeen: ChatMessage[] = [];

    function caller(messages: ChatMessage[]): ChatReply {
      historySeen = [...messages];

      if (sentBadJson === false && hasSpoken(messages)) {
        sentBadJson = true;
        return useTools(buildToolCall("report_quote", "{not json"));
      }

      return scriptedCaller(messages);
    }

    const provider = buildProvider(caller);

    const report = await runJob(oneHotelJob, hotels, provider, testOptions);

    const firstResult = getToolResults(historySeen)[0];

    expect(firstResult).toContain('"ok":false');
    expect(report.decision).toMatchObject({
      kind: "commit",
      winner: { total: 412 },
    });
  });

  it("returns an unknown tool to the model and keeps the call going", async () => {
    let sentUnknownTool = false;
    let historySeen: ChatMessage[] = [];

    function caller(messages: ChatMessage[]): ChatReply {
      historySeen = [...messages];

      if (sentUnknownTool === false && hasSpoken(messages)) {
        sentUnknownTool = true;
        return useTools(buildToolCall("send_fax", "{}"));
      }

      return scriptedCaller(messages);
    }

    const report = await runJob(
      oneHotelJob,
      hotels,
      buildProvider(caller),
      testOptions,
    );

    expect(getToolResults(historySeen)[0]).toContain("Unknown tool: send_fax");
    expect(report.decision).toMatchObject({ kind: "commit" });
  });

  it("records notes in the event stream and the outcome", async () => {
    const events = collectEvents();
    let sentNote = false;

    function caller(messages: ChatMessage[]): ChatReply {
      if (sentNote === false && hasSpoken(messages)) {
        sentNote = true;
        const note = JSON.stringify({ text: "Breakfast is included" });
        return useTools(buildToolCall("report_note", note));
      }

      return scriptedCaller(messages);
    }

    const report = await runJob(
      oneHotelJob,
      hotels,
      buildProvider(caller),
      testOptions,
    );

    const notes = events.filter((event) => event.type === "note");

    expect(notes).toHaveLength(1);
    expect(report.calls[0]).toMatchObject({
      notes: ["Breakfast is included"],
    });
  });

  it("emits LATE_QUOTE, not BAD_QUOTE, for a quote after the decision", async () => {
    const events = collectEvents();

    function caller(messages: ChatMessage[]): ChatReply {
      if (hasInstruction(messages)) {
        return useTools(reportTotal(300), endCall());
      }

      return scriptedCaller(messages);
    }

    const report = await runJob(
      oneHotelJob,
      hotels,
      buildProvider(caller),
      noGraceOptions,
    );

    expect(getAlertCodes(events)).toContain("LATE_QUOTE");
    expect(getAlertCodes(events)).not.toContain("BAD_QUOTE");
    expect(events).toContainEqual(
      expect.objectContaining({ code: "LATE_QUOTE", level: "info" }),
    );
    expect(report.decision).toMatchObject({ winner: { total: 412 } });
  });

  it("keeps BAD_QUOTE for an invalid quote before the decision", async () => {
    const events = collectEvents();
    let sentBadQuote = false;

    function caller(messages: ChatMessage[]): ChatReply {
      if (sentBadQuote === false && hasSpoken(messages)) {
        sentBadQuote = true;
        return useTools(reportTotal(-5));
      }

      return scriptedCaller(messages);
    }

    await runJob(oneHotelJob, hotels, buildProvider(caller), testOptions);

    expect(getAlertCodes(events)).toEqual(["BAD_QUOTE"]);
  });
});

describe("the end of a call", () => {
  it("stops within 3 turns of a command if end_call never comes", async () => {
    let turnsAfterCommand = 0;

    function caller(messages: ChatMessage[]): ChatReply {
      if (hasInstruction(messages)) {
        turnsAfterCommand += 1;
        return speak("Thanks for waiting.");
      }

      return scriptedCaller(messages);
    }

    const report = await runJob(
      oneHotelJob,
      hotels,
      buildProvider(caller),
      testOptions,
    );

    expect(turnsAfterCommand).toBe(3);
    expect(report.calls[0]).toMatchObject({
      status: "completed",
      command: "commit",
    });
  });

  it("refuses end_call until a pending command has been applied", async () => {
    const events = collectEvents();

    function caller(messages: ChatMessage[]): ChatReply {
      const lastMessage = messages.at(-1);

      if (lastMessage !== undefined && lastMessage.role === "tool") {
        if (hasInstruction(messages) === false) {
          return useTools(endCall());
        }
      }

      return scriptedCaller(messages);
    }

    const report = await runJob(
      oneHotelJob,
      hotels,
      buildProvider(caller),
      noGraceOptions,
    );

    expect(report.calls[0]).toMatchObject({ command: "commit" });
    expect(getAlertCodes(events)).not.toContain("WINNER_GONE");
  });

  it("pushes the exact winning offer to the caller with the commit", async () => {
    const job = { ...hotelJob, businessIds: ["queen-west-suites"] };
    let pushedMessage = "";

    function caller(messages: ChatMessage[]): ChatReply {
      for (const message of messages) {
        if (message.role === "system") {
          pushedMessage = message.content;
        }
      }

      const hasHeardPrice = findLastPrice(messages) !== undefined;

      if (hasSpoken(messages) && hasHeardPrice) {
        if (hasInstruction(messages) === false) {
          const offer = { total: 398, freeCancellation: false };
          return useTools(buildToolCall("report_quote", JSON.stringify(offer)));
        }
      }

      return scriptedCaller(messages);
    }

    await runJob(job, hotels, buildProvider(caller), testOptions);

    expect(pushedMessage).toContain("at $398 total, non-refundable.");
    expect(pushedMessage).toContain("Book exactly that offer.");
    expect(pushedMessage).not.toContain("$455");
  });

  it("makes the caller wait for a reply after asking to book", async () => {
    const events = collectEvents();
    let historySeen: ChatMessage[] = [];

    function caller(messages: ChatMessage[]): ChatReply {
      historySeen = [...messages];

      if (hasInstruction(messages)) {
        return { content: "Please book it.", toolCalls: [endCall()] };
      }

      return scriptedCaller(messages);
    }

    const report = await runJob(
      oneHotelJob,
      hotels,
      buildProvider(caller),
      testOptions,
    );

    const lines = getBusinessLines(events, "harbour-inn");
    const bookingIndex = lines.indexOf("Please book it.");

    expect(getToolResults(historySeen)).toContain(
      JSON.stringify({
        ok: false,
        error: "Wait for their reply before ending the call.",
      }),
    );
    expect(lines[bookingIndex + 1]).toBe("The total is $412.");
    expect(lines.at(-1)).toBe("Please book it.");
    expect(report.calls[0]).toMatchObject({ command: "commit" });
  });

  it("refuses a silent hang-up after a close, then allows it after speech", async () => {
    let repliesAfterClose = 0;
    let historySeen: ChatMessage[] = [];

    function caller(messages: ChatMessage[]): ChatReply {
      historySeen = [...messages];

      if (hasInstruction(messages) === false) {
        return scriptedCaller(messages);
      }

      repliesAfterClose += 1;

      if (repliesAfterClose === 2) {
        return speak("Thanks so much, have a great day.");
      }

      return useTools(endCall());
    }

    const handle = buildProvider(caller).startCall(buildCallContext());
    handle.send({ command: "close" });

    const outcome = await handle.done;

    expect(getToolResults(historySeen)).toEqual([
      JSON.stringify({
        ok: false,
        error: "Say goodbye before ending the call.",
      }),
    ]);

    // The third reply is the last one, so its end_call must have been accepted.
    expect(repliesAfterClose).toBe(3);
    expect(outcome).toMatchObject({ status: "completed", command: "close" });
  });

  it("doesn't count speech from before the close as a goodbye", async () => {
    let repliesAfterClose = 0;
    let historySeen: ChatMessage[] = [];
    let sendClose = () => {};

    function caller(messages: ChatMessage[]): ChatReply {
      historySeen = [...messages];

      if (hasInstruction(messages) === false) {
        sendClose();
        return speak("Hi, I'm an AI assistant calling about a room.");
      }

      repliesAfterClose += 1;

      if (repliesAfterClose === 1) {
        return useTools(endCall());
      }

      return { content: "Goodbye.", toolCalls: [endCall()] };
    }

    const handle = buildProvider(caller).startCall(buildCallContext());

    sendClose = () => {
      handle.send({ command: "close" });
    };

    await handle.done;

    expect(getToolResults(historySeen)).toContain(
      JSON.stringify({
        ok: false,
        error: "Say goodbye before ending the call.",
      }),
    );
  });

  it("stops a caller that never says goodbye after a close", async () => {
    let repliesAfterClose = 0;

    function caller(messages: ChatMessage[]): ChatReply {
      if (hasInstruction(messages)) {
        repliesAfterClose += 1;
        return useTools(endCall());
      }

      return scriptedCaller(messages);
    }

    const handle = buildProvider(caller).startCall(buildCallContext());
    handle.send({ command: "close" });

    const outcome = await handle.done;

    expect(repliesAfterClose).toBe(9);
    expect(outcome).toMatchObject({ status: "completed", command: "close" });
  });

  it("lets a closed call hang up straight away", async () => {
    const events = collectEvents();
    const provider = buildProvider(scriptedCaller);

    await runJob(hotelJob, hotels, provider, testOptions);

    const lines = getBusinessLines(events, "union-station-hotel");
    const goodbyes = lines.filter((line) => line === "Goodbye.");

    expect(goodbyes).toHaveLength(1);
    expect(lines.at(-1)).toBe("Goodbye.");
  });

  it("keeps a quoted caller on the line until its command arrives", async () => {
    const events = collectEvents();
    let historySeen: ChatMessage[] = [];

    function caller(messages: ChatMessage[]): ChatReply {
      historySeen = [...messages];
      const lastMessage = messages.at(-1);

      if (lastMessage !== undefined && lastMessage.role === "tool") {
        if (hasInstruction(messages) === false) {
          return useTools(endCall());
        }
      }

      return scriptedCaller(messages);
    }

    const report = await runJob(
      oneHotelJob,
      hotels,
      buildProvider(caller),
      testOptions,
    );

    const refusal = JSON.stringify({
      ok: false,
      error: "Stay on the line. Your instruction is coming.",
    });

    expect(getToolResults(historySeen)).toContain(refusal);
    expect(report.calls[0]).toMatchObject({
      status: "completed",
      command: "commit",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "decision_pushed",
        command: "commit",
        delivered: true,
      }),
    );
    expect(getAlertCodes(events)).not.toContain("WINNER_GONE");
  });

  it("lets a caller who never quoted end the call", async () => {
    let historySeen: ChatMessage[] = [];

    function caller(messages: ChatMessage[]): ChatReply {
      historySeen = [...messages];

      if (hasSpoken(messages)) {
        return useTools(endCall());
      }

      return speak("Hi, I'm an AI assistant calling about a room.");
    }

    const report = await runJob(
      oneHotelJob,
      hotels,
      buildProvider(caller),
      testOptions,
    );

    expect(report.decision).toEqual({ kind: "none", reason: "no-quotes" });
    expect(report.calls[0]).toMatchObject({ status: "completed" });
    expect(report.calls[0]).not.toHaveProperty("command", "close");
    expect(historySeen.at(-1)).toMatchObject({ role: "user" });
  });

  it("still delivers the command when the turn limit is reached", async () => {
    const events = collectEvents();
    const provider = buildProvider(scriptedCaller, 2);

    const report = await runJob(oneHotelJob, hotels, provider, testOptions);

    expect(report.calls[0]).toMatchObject({ command: "commit" });
    expect(getAlertCodes(events)).not.toContain("WINNER_GONE");
  });

  it("stops at the turn limit when the caller never quotes", async () => {
    let callerTurns = 0;

    function caller(): ChatReply {
      callerTurns += 1;
      return speak("Could you say that again?");
    }

    const report = await runJob(
      oneHotelJob,
      hotels,
      buildProvider(caller, 4),
      testOptions,
    );

    expect(callerTurns).toBe(4);
    expect(report.decision).toEqual({ kind: "none", reason: "no-quotes" });
  });
});

describe("send", () => {
  it("accepts one command and refuses any after it or after the call", async () => {
    const context = buildCallContext();
    const commitInstruction = {
      command: "commit" as const,
      quote: buildQuote({ total: 412 }),
    };
    const provider = buildProvider(scriptedCaller);

    const handle = provider.startCall(context);

    expect(handle.send({ command: "close" })).toBe(true);
    expect(handle.send(commitInstruction)).toBe(false);

    const outcome = await handle.done;

    expect(outcome.command).toBe("close");
    expect(handle.send(commitInstruction)).toBe(false);
  });
});

describe("prompts", () => {
  it("never shows the caller the business's prices", () => {
    const business = getBusiness("harbour-inn");

    const prompt = callerInstructions(hotels, hotelJob, business);

    expect(prompt).toContain("Harbour Inn");
    expect(prompt).toContain(hotelJob.request);
    expect(prompt).not.toContain("$412");
  });

  it("tells the caller to open briefly, ask one thing, and hold on", () => {
    const business = getBusiness("harbour-inn");

    const prompt = callerInstructions(hotels, hotelJob, business);

    expect(prompt).toContain(
      "Keep your opening to two short sentences: say you're an AI assistant calling for a guest, then ask for the total for the request. Don't read out every detail unless they ask.",
    );
    expect(prompt).toContain(
      "Ask one question per turn. Never stack two questions.",
    );
    expect(prompt).toContain(
      "Never say goodbye or hang up until you receive an instruction to commit or close. If you have nothing left to ask, say 'Just one moment while I confirm,' then wait.",
    );
    expect(prompt).not.toContain("give the request");
  });

  it("doesn't let the tool description invite a hang-up", () => {
    const tools = buildTools(hotels);
    const endCallTool = tools.find((tool) => tool.name === "end_call");

    expect(endCallTool).toMatchObject({
      description:
        "Hang up. Only use this after an instruction to commit or close.",
    });
  });

  it("gives the business its instructions and the phone rules", () => {
    const business = getBusiness("harbour-inn");

    const prompt = businessInstructions(business);

    expect(prompt).toContain(business.instructions);
    expect(prompt).toContain("Never mention that you are a simulation.");
  });

  it("gives the caller the job's contact details", () => {
    const business = getBusiness("harbour-inn");
    const job = {
      ...hotelJob,
      contact: { name: "Jane Doe", email: "jane.doe@example.com" },
    };

    const prompt = callerInstructions(hotels, job, business);

    expect(prompt).toContain(
      "If they ask for a name or email for the booking, give: Jane Doe, jane.doe@example.com.",
    );
    expect(prompt).not.toContain("the client will follow up");
  });

  it("gives the caller a fallback when the job has no contact", () => {
    const business = getBusiness("harbour-inn");

    const prompt = callerInstructions(hotels, hotelJob, business);

    expect(prompt).toContain(
      "If they ask for contact details, say the client will follow up with them directly.",
    );
    expect(prompt).not.toContain("give:");
  });

  it("forbids invented details and questions before the first price", () => {
    const business = getBusiness("harbour-inn");

    const prompt = callerInstructions(hotels, hotelJob, business);

    expect(prompt).toContain(
      "Never claim information is on file or already shared. If you weren't given a detail, say you don't have it.",
    );
    expect(prompt).toContain(
      "Don't ask about discounts or details until they've given you a price.",
    );
  });

  it("only allows notes for what the business said", () => {
    const business = getBusiness("harbour-inn");

    const prompt = callerInstructions(hotels, hotelJob, business);

    expect(prompt).toContain(
      "Only call report_note for facts the business told you. Never note your own questions.",
    );
  });

  it("asks the caller to report every field of an offer", () => {
    const business = getBusiness("harbour-inn");

    const prompt = callerInstructions(hotels, hotelJob, business);
    const tools = buildTools(hotels);

    expect(prompt).toContain(
      "In report_quote, fill in every field the business has told you about that offer.",
    );
    expect(JSON.stringify(tools[0])).toContain(
      "False only when the business says the rate can't be cancelled or refunded.",
    );
  });

  it("words a hotel commit with the exact offer", () => {
    const message = buildCommitMessage(hotels, {
      total: 398,
      freeCancellation: false,
      includesTaxes: true,
    });

    expect(message).toBe(
      `INSTRUCTION: Your client chose this business at $398 total, non-refundable, taxes and fees included. Book exactly that offer. Do not switch to a different rate. Say 'Thanks for waiting.' Then: ${hotels.commitInstruction} After asking, wait for their reply. Then thank them and call end_call.`,
    );
  });

  it("keeps a car rental commit readable", () => {
    const message = buildCommitMessage(carRentals, {
      total: 240,
      unlimitedMileage: true,
      lines: [
        { item: "daily rate", unitPrice: 55 },
        { item: "insurance per day", unitPrice: 25 },
      ],
    });

    expect(message).toContain(
      "at $240 total, unlimited mileage, daily rate $55, insurance per day $25. Book exactly that offer.",
    );
    expect(message).not.toContain("[object Object]");
  });

  it("describes fields an industry has no labels for", () => {
    const unlabelled = { ...hotels, fieldLabels: undefined };

    const message = buildCommitMessage(unlabelled, {
      total: 398.5,
      freeCancellation: false,
      roomType: "king",
      extras: ["parking"],
    });

    expect(message).toContain(
      "at $398.50 total, free cancellation: no, room type: king. Book",
    );
  });

  it("words a close without any offer", () => {
    expect(commandMessage(hotels, { command: "close" })).toBe(
      "INSTRUCTION: Your client went with another option. Say 'Thanks so much for your help, we've gone with another option. Have a great day.' Then call end_call.",
    );
  });
});

describe("buildTools", () => {
  it("builds report_quote's parameters from the industry schema", () => {
    const tools = buildTools(hotels);
    const reportQuote = tools.find((tool) => tool.name === "report_quote");

    expect(tools.map((tool) => tool.name)).toEqual([
      "report_quote",
      "report_note",
      "end_call",
    ]);
    expect(reportQuote).toBeDefined();
    expect(reportQuote).toMatchObject({
      parameters: {
        required: ["total"],
        properties: { freeCancellation: { type: "boolean" } },
      },
    });
    expect(reportQuote).not.toHaveProperty("parameters.$schema");
  });
});

describe("openAIChat", () => {
  it("converts messages and tools to the SDK's format and back", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => {
      return buildOpenAIResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "kept",
            type: "function",
            function: { name: "end_call", arguments: "{}" },
          },
          {
            id: "dropped",
            type: "custom",
            custom: { name: "other", input: "x" },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchStub);

    const chat = openAIChat("test-key", "test-model");
    const reply = await chat(
      [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi", toolCalls: [] },
        { role: "assistant", content: null, toolCalls: [] },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "t1", name: "end_call", arguments: "{}" }],
        },
        { role: "tool", toolCallId: "t1", content: '{"ok":true}' },
      ],
      buildTools(hotels),
    );

    const request = fetchStub.mock.calls[0];

    if (request === undefined || request[1] === undefined) {
      throw new Error("The SDK made no request.");
    }

    const body = JSON.parse(String(request[1].body));

    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "assistant", content: "" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "end_call", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: '{"ok":true}' },
    ]);
    expect(body.tools[0]).toMatchObject({
      type: "function",
      function: { name: "report_quote" },
    });
    expect(reply).toEqual({
      content: null,
      toolCalls: [{ id: "kept", name: "end_call", arguments: "{}" }],
    });
  });

  it("sends no tools when a business turn has none", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => {
      return buildOpenAIResponse({ role: "assistant", content: "Hello" });
    });
    vi.stubGlobal("fetch", fetchStub);

    const chat = openAIChat("test-key", "test-model");
    const reply = await chat([{ role: "user", content: "Hi" }]);

    const request = fetchStub.mock.calls[0];

    if (request === undefined || request[1] === undefined) {
      throw new Error("The SDK made no request.");
    }

    const body = JSON.parse(String(request[1].body));

    expect(body).not.toHaveProperty("tools");
    expect(reply).toEqual({ content: "Hello", toolCalls: [] });
  });
});

describe("createProvider", () => {
  const fullConfig = {
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "test-model",
    MAX_TURNS: 14,
    DECISION_WINDOW_MS: 20_000,
  };

  it("creates each provider by name", () => {
    expect(createProvider("fake", fullConfig).name).toBe("fake");
    expect(createProvider("text", fullConfig).name).toBe("text");
  });

  it("names the missing OpenAI value for the text provider", () => {
    const noKey = { ...fullConfig, OPENAI_API_KEY: undefined };
    const noModel = { ...fullConfig, OPENAI_MODEL: undefined };

    expect(() => createProvider("text", noKey)).toThrow("OPENAI_API_KEY");
    expect(() => createProvider("text", noModel)).toThrow("OPENAI_MODEL");
  });

  it("doesn't need OpenAI values for the fake provider", () => {
    const noOpenAI = {
      ...fullConfig,
      OPENAI_API_KEY: undefined,
      OPENAI_MODEL: undefined,
    };

    expect(createProvider("fake", noOpenAI).name).toBe("fake");
  });

  it("throws on an unknown provider", () => {
    expect(() => createProvider("voice", fullConfig)).toThrow(
      'Unknown provider "voice"',
    );
  });
});
