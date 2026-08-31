import { describe, it, expect } from "vitest";
import { parseVehicle, positionAt, zoomForRadius } from "../src/tools/yandex-transit.js";

/**
 * The fragile part isn't the scrape (that's exercised live), it's the trajectory
 * interpolation: Yandex gives no stored position, so a bug here silently reports
 * buses in the wrong place. These are pure, deterministic checks.
 */
describe("yandex trajectory interpolation", () => {
  // one straight segment heading due east, 100s long, starting at t=1000
  const east = {
    coords: [
      [44.5, 40.2],
      [44.6, 40.2],
    ] as [number, number][],
    time: 1000,
    dur: 100,
  };

  it("sits at the segment start at t=start", () => {
    const p = positionAt([east], 1000)!;
    expect(p.lon).toBeCloseTo(44.5, 6);
    expect(p.lat).toBeCloseTo(40.2, 6);
  });

  it("is halfway along at the temporal midpoint", () => {
    const p = positionAt([east], 1050)!;
    expect(p.lon).toBeCloseTo(44.55, 4); // ~half of the arc-length
    expect(p.heading).toBeGreaterThan(80); // ~due east
    expect(p.heading).toBeLessThan(100);
  });

  it("clamps to the last point once the trajectory is exhausted (stale capture)", () => {
    const p = positionAt([east], 999999)!;
    expect(p.lon).toBeCloseTo(44.6, 6);
  });

  it("returns null when there are no segments", () => {
    expect(positionAt([], 1000)).toBeNull();
  });

  // The fleet sweep matches sample zoom to cell size (region reach halves per zoom
  // from ~7.5 km at z=13); a wrong mapping would over- or under-sample the whole city.
  it("zoomForRadius covers the cell without over-zooming, clamped to [13,17]", () => {
    expect(zoomForRadius(7000)).toBe(13); // ~whole-city cell → widest region
    expect(zoomForRadius(1200)).toBe(16); // ~1 km cell → z16 (measured under the 75 cap downtown)
    expect(zoomForRadius(50)).toBe(17); // tiny cell → floor
    expect(zoomForRadius(1e9)).toBe(13); // absurdly large → floor at 13
    // monotonic: smaller cell never picks a lower zoom
    for (const [big, small] of [[5000, 2000], [2000, 800], [800, 300]] as const) {
      expect(zoomForRadius(small)).toBeGreaterThanOrEqual(zoomForRadius(big));
    }
  });

  it("parseVehicle pulls line/type from VehicleMetaData and a live position", () => {
    const fc = {
      properties: { VehicleMetaData: { Transport: { name: "25", type: "bus", id: "x", threadId: "t" } } },
      features: [
        { geometry: { type: "LineString", coordinates: east.coords }, properties: { TrajectorySegmentMetaData: { time: 1000, duration: 100 } } },
      ],
    };
    const v = parseVehicle(fc, 1050);
    expect(v.line).toBe("25");
    expect(v.type).toBe("bus");
    expect(v.lon).toBeCloseTo(44.55, 4);
    expect(v.heading).not.toBeNull();
  });
});
