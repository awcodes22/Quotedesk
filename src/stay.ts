import { z } from "zod";
import {
  ASK_ABOUT,
  BEDS,
  buildDatesSentence,
  buildRequestSentence,
  countNights,
  describeGuestsAndBed,
  formatShortDates,
  GUEST_NAME,
  MAX_GUESTS,
  MIN_GUESTS,
} from "../public/js/stay.js";
import type { BedKey, StayRequest } from "../public/js/stay.js";
import type { Job } from "./core/types";

export type { StayRequest };

const MAX_NIGHTS = 30;

const bedKeys = BEDS.map((bed) => bed.key) as [BedKey, ...BedKey[]];

// The browser sends today's date as the user sees it, but the server checks against its own.
export function todayIso(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const baseStaySchema = z.strictObject({
  area: z.string().trim().min(2).max(120),
  checkIn: z.iso.date(),
  checkOut: z.iso.date(),
  guests: z.number().int().min(MIN_GUESTS).max(MAX_GUESTS),
  bed: z.enum(bedKeys),
});

// Yesterday is allowed too, so a stay picked just before midnight in an earlier time zone still counts.
function addDays(isoDay: string, days: number): string {
  const date = new Date(`${isoDay}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function createStaySchema(today: string) {
  const earliest = addDays(today, -1);

  return baseStaySchema.superRefine((stay, context) => {
    if (stay.checkIn < earliest) {
      context.addIssue({ code: "custom", path: ["checkIn"], message: "can't be in the past" });
    }

    if (stay.checkOut <= stay.checkIn) {
      context.addIssue({ code: "custom", path: ["checkOut"], message: "must be after check-in" });
    }

    if (stay.checkOut > stay.checkIn && countNights(stay.checkIn, stay.checkOut) > MAX_NIGHTS) {
      context.addIssue({ code: "custom", path: ["checkOut"], message: `must be within ${MAX_NIGHTS} nights` });
    }
  });
}

export type StayResult = { ok: true; stay: StayRequest } | { ok: false; error: string };

export function parseStay(raw: unknown, today: string = todayIso()): StayResult {
  const result = createStaySchema(today).safeParse(raw);

  if (result.success === false) {
    return { ok: false, error: `This stay isn't complete:\n${z.prettifyError(result.error)}` };
  }

  return { ok: true, stay: result.data };
}

// A wizard stay becomes a run's job in memory, with the sentences the agent says already built.
export function stayToJob(stay: StayRequest): Job {
  const request = buildRequestSentence(stay);

  return {
    id: "new-quote",
    industryId: "hotels",
    title: `${stay.area} · ${formatShortDates(stay.checkIn, stay.checkOut)}`,
    request,
    details: [
      { label: "Area", value: stay.area, icon: "map-pin" },
      { label: "Dates", value: formatShortDates(stay.checkIn, stay.checkOut), icon: "calendar" },
      { label: "Guests", value: describeGuestsAndBed(stay), icon: "bed-double" },
    ],
    location: stay.area,
    stay: { checkIn: stay.checkIn, checkOut: stay.checkOut, beds: request },
    callBrief: {
      request,
      dates: buildDatesSentence(stay.checkIn, stay.checkOut),
      askAbout: ASK_ABOUT,
      guestName: GUEST_NAME,
    },
  };
}
