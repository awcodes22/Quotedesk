import type { IndustryConfig, Job, QuoteFields, SimBusiness } from "./core/types";

// The live grid shows 20 squares per row and six rows fit on one screen.
export const MAX_SCALE = 120;

const NO_ANSWER_SHARE = 0.08;
const NEVER_QUOTES_SHARE = 0.25;
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

// Every offer from one clone moves by the same factor, so a price drop stays a drop.
function jitterQuotes(quotes: QuoteFields[], factor: number): QuoteFields[] {
  return quotes.map((quote) => {
    return { ...quote, total: Math.round(quote.total * factor) };
  });
}

function createClone(
  base: SimBusiness,
  index: number,
  random: () => number,
  usedNames: Set<string>,
): Clone {
  const roll = random();
  const factor = LOWEST_FACTOR + random() * FACTOR_SPREAD;
  const noAnswer = roll < NO_ANSWER_SHARE;
  const neverQuotes = roll >= NO_ANSWER_SHARE && roll < NO_ANSWER_SHARE + NEVER_QUOTES_SHARE;
  let fakeQuotes = jitterQuotes(base.fakeQuotes, factor);

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
  const clones: Clone[] = bases.slice(0, size).map((business) => {
    return { business, noAnswer: false };
  });

  for (let index = clones.length; index < size; index += 1) {
    const base = bases[index % bases.length];

    if (base !== undefined) {
      clones.push(createClone(base, index, random, usedNames));
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
