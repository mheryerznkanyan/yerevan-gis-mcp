import { describe, it, expect } from "vitest";
import { BUS_STOPS } from "../src/data/bus-stops.js";
import { BUS_ROUTES } from "../src/data/bus-routes.js";

/** The two baked-in files join on OSM node id — that join is what can silently rot. */
describe("baked-in transit data", () => {
  const ids = new Set(BUS_STOPS.map((s) => s.id));

  it("has no duplicate stop ids", () => {
    expect(ids.size).toBe(BUS_STOPS.length);
  });

  it("resolves every route stop to a known stop", () => {
    const dangling = BUS_ROUTES.flatMap((r) => r.stops.filter((s) => !ids.has(s)));
    expect(dangling).toEqual([]);
  });

  it("keeps every stop inside the Yerevan bounding box", () => {
    const outside = BUS_STOPS.filter(
      (s) => s.lat < 40.0 || s.lat > 40.35 || s.lon < 44.3 || s.lon > 44.75,
    );
    expect(outside).toEqual([]);
  });

  it("gives every route at least two stops", () => {
    expect(BUS_ROUTES.filter((r) => r.stops.length < 2)).toEqual([]);
  });
});
