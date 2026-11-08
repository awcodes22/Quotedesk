import { describe, expect, it } from "vitest";
import { buildHistogram, priceColor, priceTextColor } from "../public/js/price.js";

describe("priceColor", () => {
  it("colors the best quote solid green", () => {
    expect(priceColor(398, 398)).toBe("#12B76A");
  });

  it("steps through the scale at 3, 8 and 13 percent above the best", () => {
    expect(priceColor(103, 100)).toBe("#A6F4C5");
    expect(priceColor(103.5, 100)).toBe("#D1FADF");
    expect(priceColor(108, 100)).toBe("#D1FADF");
    expect(priceColor(108.5, 100)).toBe("#FEF0C7");
    expect(priceColor(113, 100)).toBe("#FEF0C7");
    expect(priceColor(113.5, 100)).toBe("#FEDF89");
    expect(priceColor(500, 100)).toBe("#FEDF89");
  });

  it("pairs each fill with readable text", () => {
    expect(priceTextColor(100, 100)).toBe("#FFFFFF");
    expect(priceTextColor(105, 100)).toBe("#067647");
    expect(priceTextColor(120, 100)).toBe("#B54708");
  });

  it("works the same for any price range", () => {
    expect(priceColor(51.5, 50)).toBe("#A6F4C5");
    expect(priceColor(5150, 5000)).toBe("#A6F4C5");
  });
});

describe("buildHistogram", () => {
  it("returns no bins without quotes", () => {
    expect(buildHistogram([])).toEqual([]);
  });

  it("splits the lowest to the highest quote into 10 bins", () => {
    const bins = buildHistogram([390, 398, 412, 430, 480]);

    expect(bins).toHaveLength(10);
    expect(bins[0]).toMatchObject({ from: 390, to: 399, count: 2, color: "#12B76A" });
    expect(bins[9]).toMatchObject({ from: 471, to: 480, count: 1, color: "#FEDF89" });
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(5);
  });

  it("puts every quote in the first bin when they are all equal", () => {
    const bins = buildHistogram([400, 400, 400]);

    expect(bins[0]).toMatchObject({ count: 3 });
    expect(bins.slice(1).every((bin) => bin.count === 0)).toBe(true);
  });
});
