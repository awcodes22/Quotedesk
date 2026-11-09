// @ts-check
// The choices on the demo page and the run request each one makes. No page code, so tests can use it.

/**
 * @typedef {"demo" | "chats" | "simulated"} DemoMode
 */

/** @type {{ key: DemoMode, label: string, hint: string }[]} */
export const DEMO_MODES = [
  { key: "demo", label: "Demo", hint: "Scripted calls to the job's sample businesses." },
  { key: "chats", label: "Chats", hint: "Two AI models talk it out. Uses OpenAI." },
  { key: "simulated", label: "Simulated run", hint: "Scripted calls cloned up to the size you pick." },
];

export const SIMULATED_SIZES = [6, 24, 60, 200];

/**
 * What POST /api/runs gets for a demo choice.
 * @param {string} jobId
 * @param {DemoMode} mode
 * @param {number} size
 * @returns {{ jobId: string, provider: "fake" | "text", scale?: number }}
 */
export function buildDemoRequest(jobId, mode, size) {
  if (mode === "chats") {
    return { jobId, provider: "text" };
  }

  if (mode === "simulated") {
    return { jobId, provider: "fake", scale: size };
  }

  return { jobId, provider: "fake" };
}
