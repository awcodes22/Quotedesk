import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Job } from "./core/types";

// Prices must be positive because the price check divides by them.
const referenceSchema = z.strictObject({
  total: z.number().positive().optional(),
  lines: z.record(z.string().min(1), z.number().positive()).optional(),
  source: z.string().min(1).optional(),
});

const contactSchema = z.strictObject({
  name: z.string().min(1),
  email: z.email(),
});

// Strict, so a misspelled businessIds fails instead of silently calling everyone.
const jobSchema = z.strictObject({
  id: z.string().min(1),
  industryId: z.string().min(1),
  title: z.string().min(1),
  request: z.string().min(1),
  businessIds: z.array(z.string()).optional(),
  reference: referenceSchema.optional(),
  contact: contactSchema.optional(),
});

function readJsonFile(path: string): unknown {
  try {
    const contents = readFileSync(path, "utf8");
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Could not read job file ${path}: ${String(error)}`);
  }
}

export function loadJob(path: string): Job {
  const raw = readJsonFile(path);
  const result = jobSchema.safeParse(raw);

  if (result.success === false) {
    const issues = z.prettifyError(result.error);
    throw new Error(`Invalid job file ${path}:\n${issues}`);
  }

  return result.data;
}

export function listJobs(directory: string = "data/jobs"): Job[] {
  const fileNames = readdirSync(directory);
  const jsonFileNames = fileNames.filter((name) => name.endsWith(".json"));
  jsonFileNames.sort();

  return jsonFileNames.map((name) => loadJob(join(directory, name)));
}
