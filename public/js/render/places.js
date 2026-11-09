// @ts-check
import { clear, el, icon } from "../dom.js";
import { formatPublicPhone } from "../phone.js";

/**
 * @typedef {import("./view.js").JobListing} JobListing
 *
 * @typedef {{
 *   placeId: string,
 *   name: string,
 *   address: string,
 *   phone: string,
 *   rating: number | null,
 *   reviewCount: number | null,
 *   priceLevel: string | null,
 *   website: string | null,
 *   tollFree: boolean,
 * }} PlaceHotel
 *
 * @typedef {{ ok: true, hotels: PlaceHotel[], sample: boolean } | { ok: false, error: string }} SearchOutcome
 *
 * @typedef {{
 *   search: (query: string) => Promise<SearchOutcome>,
 *   onStart: (placeIds: string[]) => Promise<string | null>,
 *   maxCalls: number,
 * }} PlacesFinderOptions
 */

export const SAMPLE_NOTICE = "Google Places not set up, showing sample hotels";

/**
 * @param {JobListing | null} listing
 * @returns {string}
 */
export function buildSearchQuery(listing) {
  if (listing === null || listing.location === null) {
    return "hotels";
  }

  return `hotels in ${listing.location}`;
}

/**
 * @param {number} picked
 * @param {number} maxCalls
 * @returns {string}
 */
export function describePickCount(picked, maxCalls) {
  return `${picked} of ${maxCalls} picked`;
}

/**
 * @param {number} picked
 * @returns {string}
 */
export function describePlacesConfirm(picked) {
  let hotels = `${picked} hotels`;

  if (picked === 1) {
    hotels = "1 hotel";
  }

  return `Call ${hotels} now? QuoteDesk says it's an AI and never books.`;
}

/**
 * @param {number | null} rating
 * @param {number | null} reviewCount
 * @returns {string | null}
 */
export function formatRating(rating, reviewCount) {
  if (rating === null) {
    return null;
  }

  const stars = rating.toFixed(1);

  if (reviewCount === null) {
    return stars;
  }

  const reviews = reviewCount.toLocaleString("en-US");
  let noun = "reviews";

  if (reviewCount === 1) {
    noun = "review";
  }

  return `${stars} (${reviews} ${noun})`;
}

/**
 * @param {PlaceHotel} hotel
 * @returns {HTMLElement}
 */
function renderHotelFacts(hotel) {
  const facts = el("div", { class: "place-facts" });
  const rating = formatRating(hotel.rating, hotel.reviewCount);

  if (rating !== null) {
    facts.appendChild(el("span", { class: "place-fact" }, [icon("star", 13), rating]));
  }

  if (hotel.priceLevel !== null) {
    facts.appendChild(el("span", { class: "place-fact" }, [hotel.priceLevel]));
  }

  facts.appendChild(el("span", { class: "place-fact tabular" }, [icon("phone", 13), formatPublicPhone(hotel.phone)]));

  if (hotel.website !== null) {
    facts.appendChild(
      el("a", { class: "place-link", href: hotel.website, target: "_blank", rel: "noopener noreferrer" }, ["Website"]),
    );
  }

  // A toll-free number reaches a chain's central desk, which may not quote the local rate.
  if (hotel.tollFree) {
    facts.appendChild(el("span", { class: "place-tag" }, ["Central reservations"]));
  }

  return facts;
}

/**
 * @param {PlaceHotel} hotel
 * @param {HTMLInputElement} checkbox
 * @returns {HTMLElement}
 */
function renderHotel(hotel, checkbox) {
  return el("li", { class: "place" }, [
    el("label", { class: "place-pick" }, [
      checkbox,
      el("div", { class: "place-body" }, [
        el("span", { class: "place-name" }, [hotel.name]),
        el("span", { class: "place-address" }, [icon("map-pin", 13), hotel.address]),
      ]),
    ]),
    renderHotelFacts(hotel),
  ]);
}

/**
 * Results live only in this panel's memory; nothing is saved to storage or the URL.
 * @param {HTMLElement} container
 * @param {PlacesFinderOptions} options
 */
export function createPlacesFinder(container, options) {
  const queryInput = el("input", {
    class: "picker-select places-query",
    type: "search",
    "aria-label": "Hotel search",
    autocomplete: "off",
  });
  const searchButton = el("button", { class: "button", type: "button" }, [icon("search", 14), "Search"]);
  const notice = el("p", { class: "places-notice" });
  const status = el("p", { class: "places-status", role: "status" });
  const list = el("ul", { class: "places-list" });
  const counter = el("span", { class: "places-counter tabular" });
  const pickButton = el("button", { class: "button button-primary", type: "button" }, ["Call picked hotels"]);
  const question = el("span", { class: "places-question" });
  const startButton = el("button", { class: "button button-primary", type: "button" }, ["Start calls"]);
  const cancelButton = el("button", { class: "button", type: "button" }, ["Cancel"]);
  const pickRow = el("div", { class: "places-row" }, [counter, pickButton]);
  const confirmRow = el("div", { class: "places-row" }, [question, startButton, cancelButton]);
  /** @type {Map<string, HTMLInputElement>} */
  let checkboxes = new Map();

  container.appendChild(
    el("div", { class: "places-head" }, [
      el("span", { class: "section-label" }, ["FIND HOTELS"]),
      el("div", { class: "places-search" }, [queryInput, searchButton]),
    ]),
  );
  container.appendChild(notice);
  container.appendChild(status);
  container.appendChild(list);
  container.appendChild(el("div", { class: "places-foot" }, [pickRow, confirmRow]));

  /** @returns {string[]} */
  function pickedIds() {
    const ids = [];

    for (const [placeId, checkbox] of checkboxes) {
      if (checkbox.checked) {
        ids.push(placeId);
      }
    }

    return ids;
  }

  /** @param {boolean} confirming */
  function showConfirm(confirming) {
    pickRow.hidden = confirming;
    confirmRow.hidden = confirming === false;
  }

  // Unpicked boxes lock once the limit is reached, so the count can never go over it.
  function updatePicks() {
    const picked = pickedIds().length;
    const full = picked >= options.maxCalls;

    for (const checkbox of checkboxes.values()) {
      checkbox.disabled = full && checkbox.checked === false;
    }

    counter.textContent = describePickCount(picked, options.maxCalls);
    pickButton.disabled = picked === 0;
    showConfirm(false);
  }

  /** @param {PlaceHotel[]} hotels */
  function showHotels(hotels) {
    clear(list);
    checkboxes = new Map();

    for (const hotel of hotels) {
      const checkbox = el("input", { type: "checkbox", "aria-label": `Pick ${hotel.name}` });
      checkbox.addEventListener("change", updatePicks);
      checkboxes.set(hotel.placeId, checkbox);
      list.appendChild(renderHotel(hotel, checkbox));
    }

    updatePicks();
  }

  async function search() {
    searchButton.disabled = true;
    status.textContent = "Searching...";
    const outcome = await options.search(queryInput.value);
    searchButton.disabled = false;

    if (outcome.ok === false) {
      status.textContent = outcome.error;
      return;
    }

    notice.hidden = outcome.sample === false;
    status.textContent = "";

    if (outcome.hotels.length === 0) {
      status.textContent = "No hotels with a phone number came up. Try a different search.";
    }

    showHotels(outcome.hotels);
  }

  function ask() {
    question.textContent = describePlacesConfirm(pickedIds().length);
    showConfirm(true);
  }

  async function start() {
    startButton.disabled = true;
    const error = await options.onStart(pickedIds());
    startButton.disabled = false;

    if (error !== null) {
      status.textContent = error;
      showConfirm(false);
    }
  }

  searchButton.addEventListener("click", search);
  queryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      search();
    }
  });
  pickButton.addEventListener("click", ask);
  startButton.addEventListener("click", start);
  cancelButton.addEventListener("click", () => showConfirm(false));
  notice.textContent = SAMPLE_NOTICE;
  notice.hidden = true;
  container.hidden = true;
  showHotels([]);

  /** @param {JobListing | null} listing */
  function open(listing) {
    container.hidden = false;
    queryInput.value = buildSearchQuery(listing);
    queryInput.focus();
  }

  function close() {
    container.hidden = true;
  }

  return { open, close };
}
