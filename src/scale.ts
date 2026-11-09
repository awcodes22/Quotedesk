import type { IndustryConfig, Job, QuoteFields, SimBusiness } from "./core/types";

// The run page fits about 20 small squares per row, so 200 calls is ten rows.
export const MAX_SCALE = 200;

const NO_ANSWER_SHARE = 0.08;
const NEVER_QUOTES_SHARE = 0.25;
const PRICE_DROP_SHARE = 0.2;
const DROP_MARKUP_MIN = 0.08;
const DROP_MARKUP_SPREAD = 0.1;
const LOWEST_FACTOR = 0.97;
const FACTOR_SPREAD = 0.2;
const SEED = 20261120;

const AREAS = [
  "Yorkville", "Bloor", "Danforth", "Leslieville", "Liberty", "Annex", "Kensington",
  "Parkdale", "Riverdale", "Rosedale", "Junction", "Distillery", "Cabbagetown",
  "Corktown", "Midtown", "Forest Hill", "Roncesvalles", "Ossington", "Dufferin",
  "Spadina", "Bathurst", "Yonge", "Front Street", "King West", "Queen East",
  "Harbourfront", "Lakeshore", "Davisville", "Leaside", "Summerhill", "Trinity",
  "Chinatown", "Greektown", "Little Italy", "Beaches", "Etobicoke", "Scarborough",
  "North York", "Mimico", "Swansea",
];

export type ScaledRun = {
  job: Job;
  industry: IndustryConfig;
  noAnswerIds: string[];
};

type Clone = {
  business: SimBusiness;
  noAnswer: boolean;
};

// A fixed seed makes every demo of the same size identical, which keeps it repeatable.
function createRandom(seed: number): () => number {
  let state = seed;

  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function pickBaseBusinesses(job: Job, industry: IndustryConfig): SimBusiness[] {
  if (job.businessIds === undefined || job.businessIds.length === 0) {
    return industry.simBusinesses;
  }

  const wanted = new Set(job.businessIds);
  return industry.simBusinesses.filter((business) => wanted.has(business.id));
}

function lastWord(name: string): string {
  const words = name.split(" ");
  const last = words[words.length - 1];

  if (last === undefined) {
    return name;
  }

  return last;
}

function createUniqueName(
  base: SimBusiness,
  areaIndex: number,
  usedNames: Set<string>,
): string {
  const area = AREAS[areaIndex % AREAS.length];
  const baseName = `${area} ${lastWord(base.name)}`;
  let name = baseName;
  let copy = 2;

  while (usedNames.has(name)) {
    name = `${baseName} ${copy}`;
    copy += 1;
  }

  usedNames.add(name);
  return name;
}

function pickOne<Value>(values: Value[], random: () => number): Value {
  const picked = values[Math.floor(random() * values.length)];

  if (picked === undefined) {
    throw new Error("Scaling needs at least one fake quote to draw from.");
  }

  return picked;
}

// Each field comes from its own random donor, so clones mix terms instead of copying one business.
function drawFields(donors: QuoteFields[], random: () => number): QuoteFields {
  const keys = new Set(donors.flatMap((donor) => Object.keys(donor)));
  const fields: Record<string, unknown> = {};

  for (const key of keys) {
    const donor = pickOne(donors, random);

    if (key !== "total" && Object.hasOwn(donor, key)) {
      fields[key] = donor[key];
    }
  }

  const priceDonor = pickOne(donors, random);
  const factor = LOWEST_FACTOR + random() * FACTOR_SPREAD;
  return { ...fields, total: Math.round(priceDonor.total * factor) };
}

// A few clones open higher and come down, like a front desk that negotiates.
function buildOffers(final: QuoteFields, random: () => number): QuoteFields[] {
  const dropsPrice = random() < PRICE_DROP_SHARE;
  const markup = 1 + DROP_MARKUP_MIN + random() * DROP_MARKUP_SPREAD;

  if (dropsPrice === false) {
    return [final];
  }

  const opening = { ...final, total: Math.round(final.total * markup) };
  return [opening, final];
}

function createClone(
  base: SimBusiness,
  index: number,
  donors: QuoteFields[],
  random: () => number,
  usedNames: Set<string>,
): Clone {
  const roll = random();
  const noAnswer = roll < NO_ANSWER_SHARE;
  const neverQuotes = roll >= NO_ANSWER_SHARE && roll < NO_ANSWER_SHARE + NEVER_QUOTES_SHARE;
  let fakeQuotes = buildOffers(drawFields(donors, random), random);

  // With nothing to offer, the fake call keeps talking until the decision closes it.
  if (neverQuotes) {
    fakeQuotes = [];
  }

  const business = {
    ...base,
    id: `${base.id}-${index}`,
    name: createUniqueName(base, index, usedNames),
    fakeQuotes,
  };

  return { business, noAnswer };
}

function buildClones(bases: SimBusiness[], size: number): Clone[] {
  const random = createRandom(SEED);
  const usedNames = new Set(bases.map((base) => base.name));
  const donors = bases.flatMap((base) => base.fakeQuotes);
  const clones: Clone[] = bases.slice(0, size).map((business) => {
    return { business, noAnswer: false };
  });

  for (let index = clones.length; index < size; index += 1) {
    const base = bases[index % bases.length];

    if (base !== undefined) {
      clones.push(createClone(base, index, donors, random, usedNames));
    }
  }

  return clones;
}

// The real businesses come first and unchanged, then jittered clones fill up to the size.
export function scaleRun(job: Job, industry: IndustryConfig, size: number): ScaledRun {
  if (Number.isInteger(size) === false || size < 1 || size > MAX_SCALE) {
    throw new Error(`Scale must be a whole number from 1 to ${MAX_SCALE}.`);
  }

  const bases = pickBaseBusinesses(job, industry);
  const clones = buildClones(bases, size);
  const simBusinesses = clones.map((clone) => clone.business);
  const noAnswerClones = clones.filter((clone) => clone.noAnswer);

  return {
    job: { ...job, businessIds: undefined },
    industry: { ...industry, simBusinesses },
    noAnswerIds: noAnswerClones.map((clone) => clone.business.id),
  };
}
