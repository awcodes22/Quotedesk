import request from "supertest";
import { describe, expect, it } from "vitest";
import { RunRegistry } from "../src/api/registry";
import { createApp } from "../src/app";
import { fakeProvider } from "../src/providers/fake";

describe("GET /health", () => {
  it("returns 200 and { ok: true }", async () => {
    const app = createApp({
      jobsDirectory: "data/jobs",
      runsDirectory: "runs",
      publicDirectory: "public",
      runOptions: {
        maxParallelCalls: 3,
        decisionWindowMs: 2_000,
        runTimeoutMs: 5_000,
        settleGraceMs: 50,
        priceFlagPct: 10,
      },
      maxTurns: 14,
      createProvider: () => fakeProvider({ stepMs: 1 }),
      registry: new RunRegistry(),
    });

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});
