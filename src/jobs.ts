import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ICONS } from "../public/js/icons.js";
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

// The dashboard draws these icons, so a job may only name one it actually has.
const iconNames = Object.keys(ICONS) as [string, ...string[]];

const detailSchema = z.strictObject({
  label: z.string().min(1),
  value: z.string().min(1),
  icon: z.enum(iconNames).optional(),
});

const isoDay = z.iso.date();

const staySchema = z.strictObject({
  checkIn: isoDay,
  checkOut: isoDay,
  beds: z.string().min(1),
});

const liveBusinessSchema = z.strictObject({
  name: z.string().min(1),
  phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/, { error: "must be in E.164 format, such as +15551234567" }),
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
  details: z.array(detailSchema).optional(),
  stay: staySchema.optional(),
  liveBusinesses: z.array(liveBusinessSchema).optional(),
});

// Example files show the format for a job you fill in yourself, so they are never offered as jobs.
const EXAMPLE_SUFFIX = ".example.json";

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
  const jsonFileNames = fileNames.filter((name) => {
    return name.endsWith(".json") && name.endsWith(EXAMPLE_SUFFIX) === false;
  });
  jsonFileNames.sort();

  return jsonFileNames.map((name) => loadJob(join(directory, name)));
}
