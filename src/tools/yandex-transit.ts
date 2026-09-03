import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guard, jsonResult, errorResult, type ToolResult } from "../mcp-util.js";
import { haversineMeters, num } from "../format.js";
import { launchChromium, BrowserUnavailable } from "../browser.js";

/**
 * LIVE vehicle positions, scraped from Yandex Maps' Yerevan transport layer.
 *
 * There is no public/licensed feed for this, so we drive a headless browser to
 * the transport page and intercept the JSON the page itself fetches
 * (`getVehiclesInfoWithRegion`). That request is signed (`s=`, `csrfToken=`) by
 * Yandex's own JS, so we let the page make it rather than reproducing it.
 *
 * Yandex does not send a stored position — each vehicle is an animated
 * trajectory: LineString segments each stamped with a start `time` (unix secs)
 * and `duration`. The bus icon is interpolated along it by wall-clock, so we do
 * the same to get "where is it now".
 *
 * This is deliberately fragile: it breaks if Yandex reshapes the endpoint or the
 * page, and it is against Yandex ToS for automated use. Use accordingly.
 *
 * ponytail: relaunch a browser per call + 20s result cache. Good enough for
 *   occasional queries. If call rate climbs, pool one long-lived context and
 *   poll it, instead of cold-starting Chromium each time.
 */

const YEREVAN_LL = "44.509760,40.174801"; // lon,lat — city centre, matches the portal's default view
const CACHE_MS = 20_000;

type Vehicle = {
  line: string | null;
  type: string | null; // bus | trolleybus | minibus | ...
  lon: number | null;
  lat: number | null;
  heading: number | null; // degrees, if Yandex provides it
  vehicle_id: string | null;
  thread_id: string | null;
};

let cache: { key: string; ts: number; vehicles: Vehicle[] } | null = null;

type LonLat = [number, number];
type Segment = { coords: LonLat[]; time: number; dur: number };
type Fix = { lon: number; lat: number; heading: number | null };

/** Trajectory segments of one vehicle, time-ordered. */
function segmentsOf(fc: any): Segment[] {
  const feats: any[] = Array.isArray(fc?.features) ? fc.features : [];
  return feats
    .filter((f) => f?.geometry?.type === "LineString" && Array.isArray(f.geometry.coordinates))
    .map((f) => ({
      coords: f.geometry.coordinates as LonLat[],
      time: num(f.properties?.TrajectorySegmentMetaData?.time) ?? 0,
      dur: num(f.properties?.TrajectorySegmentMetaData?.duration) ?? 0,
    }))
    .filter((s) => s.coords.length >= 2)
    .sort((a, b) => a.time - b.time);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Compass bearing a→b in degrees (0=N, 90=E). */
function bearing([lo1, la1]: LonLat, [lo2, la2]: LonLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(la1),
    φ2 = toRad(la2),
    dλ = toRad(lo2 - lo1);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Point a fraction f∈[0,1] of the arc-length along a polyline, with local heading. */
function pointAlong(coords: LonLat[], f: number): Fix {
  const lens = coords.slice(1).map((c, i) => haversineMeters(coords[i]![0], coords[i]![1], c[0], c[1]));
  const total = lens.reduce((s, d) => s + d, 0);
  if (total === 0) return { lon: coords[0]![0], lat: coords[0]![1], heading: null };
  let target = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i]! || i === lens.length - 1) {
      const t = lens[i]! > 0 ? target / lens[i]! : 0;
      const a = coords[i]!,
        b = coords[i + 1]!;
      return { lon: lerp(a[0], b[0], t), lat: lerp(a[1], b[1], t), heading: bearing(a, b) };
    }
    target -= lens[i]!;
  }
  const last = coords[coords.length - 1]!;
  return { lon: last[0], lat: last[1], heading: null };
}

/** Interpolate the vehicle's position at `nowSec` along its trajectory. */
export function positionAt(segs: Segment[], nowSec: number): Fix | null {
  if (!segs.length) return null;
  if (nowSec <= segs[0]!.time) return pointAlong(segs[0]!.coords, 0);
  for (const s of segs) {
    if (nowSec >= s.time && nowSec < s.time + s.dur) {
      return pointAlong(s.coords, s.dur > 0 ? (nowSec - s.time) / s.dur : 0);
    }
  }
  return pointAlong(segs[segs.length - 1]!.coords, 1); // trajectory exhausted (stale) → last point
}

/** Parse one vehicle FeatureCollection into a flat record at time `nowSec`. */
export function parseVehicle(fc: any, nowSec: number): Vehicle {
  const t = fc?.properties?.VehicleMetaData?.Transport ?? {};
  const fix = positionAt(segmentsOf(fc), nowSec);
  return {
    line: t.name ?? t.seoname ?? null,
    type: t.type ?? (Array.isArray(t.Types) ? t.Types[0] : null) ?? null,
    lon: fix?.lon ?? null,
    lat: fix?.lat ?? null,
    heading: fix?.heading != null ? Math.round(fix.heading) : null,
    vehicle_id: t.id ?? null,
    thread_id: t.threadId ?? null,
  };
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Yandex caps each getVehiclesInfoWithRegion response at the 75 vehicles nearest to `ll`. */
const PER_CALL_CAP = 75;

// Yandex returns all vehicles within a zoom-dependent radius, capped at 75.
// Measured empirically: reach ≈ 7.5 km at z=13 and halves per zoom step.
const REACH_Z13_M = 7470;
/** Lowest zoom (largest region, fewest samples) whose region still covers a cell of `radiusM`. */
export const zoomForRadius = (radiusM: number) =>
  Math.max(13, Math.min(17, Math.round(13 + Math.log2(REACH_Z13_M / Math.max(radiusM, 1)))));

/** Navigate an open page to the transport view at `ll`/`z` and return the raw vehicle FeatureCollections. */
async function grabAt(page: any, ll: string, z = 13): Promise<any[]> {
  const url = `https://yandex.com/maps/10262/yerevan/transport/?ll=${encodeURIComponent(ll)}&z=${z}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const resp = await page.waitForResponse(
    (r: any) => /getVehiclesInfoWithRegion/.test(r.url()),
    { timeout: 35_000 },
  );
  const vehicles = JSON.parse(await resp.text())?.data?.vehicles;
  if (!Array.isArray(vehicles)) throw new Error("unexpected Yandex response shape");
  return vehicles;
}

async function withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 }, userAgent: UA });
    return await fn(await ctx.newPage());
  } finally {
    await browser.close();
  }
}

/** One region's worth of vehicles (the 75 nearest to its centre). */
export async function captureVehicles(ll: string): Promise<Vehicle[]> {
  return withPage(async (page) => {
    const nowSec = Date.now() / 1000;
    return grabAt(page, ll).then((raw) =>
      raw.map((v: any) => parseVehicle(v, nowSec)).filter((v) => v.lon != null && v.lat != null),
    );
  });
}

type Bbox = { minLon: number; minLat: number; maxLon: number; maxLat: number };

// Yerevan's rough envelope — the default sweep area.
const YEREVAN_BBOX: Bbox = { minLon: 44.42, minLat: 40.11, maxLon: 44.62, maxLat: 40.26 };

/**
 * ALL active vehicles, not just the per-call 75. Adaptive quadtree: sample a
 * region's centre; if it comes back at the cap the region is dense, so split it
 * into four and recurse; if under the cap we've seen everything near that centre.
 * This spends calls where the buses are (downtown) and skips empty edges.
 *
 * Each cell is sampled at the zoom whose region just covers it (reachAtZoom).
 * If that sample comes back under the 75 cap, it returned *every* vehicle in the
 * cell's region → the cell is complete. If it's still at the cap, the cell is
 * denser than one sample can hold, so split into four and recurse (the children
 * are smaller → sampled at a tighter zoom → eventually drop under the cap).
 *
 * ponytail: bounded by maxTiles + a z=17 floor so a runaway can't hammer Yandex.
 *   If a cell is still capped at the zoom floor when the budget runs out, the
 *   union is a floor — reported as `complete: false`. Raise maxTiles to go denser.
 */
export async function captureFleet(
  bbox: Bbox = YEREVAN_BBOX,
  opts: { maxTiles?: number; delayMs?: number } = {},
): Promise<{ vehicles: Vehicle[]; tiles: number; complete: boolean }> {
  const maxTiles = opts.maxTiles ?? 100; // a full Yerevan sweep converges at ~77 tiles
  const delayMs = opts.delayMs ?? 350;

  return withPage(async (page) => {
    const seen = new Map<string, Vehicle>();
    const queue: Bbox[] = [bbox];
    let tiles = 0;
    let underCovered = 0; // dense cells still capped at the z=17 floor

    while (queue.length && tiles < maxTiles) {
      const r = queue.shift()!;
      const cLon = (r.minLon + r.maxLon) / 2;
      const cLat = (r.minLat + r.maxLat) / 2;
      const cellRadiusM = haversineMeters(cLon, cLat, r.maxLon, r.maxLat);
      const z = zoomForRadius(cellRadiusM);
      tiles++;
      let raw: any[];
      try {
        raw = await grabAt(page, `${cLon},${cLat}`, z);
      } catch {
        continue; // skip a rate-limited / timed-out tile, keep whatever else we get
      }
      const nowSec = Date.now() / 1000;
      for (const v of raw) {
        const parsed = parseVehicle(v, nowSec);
        if (parsed.lon != null && parsed.lat != null && parsed.vehicle_id) {
          seen.set(parsed.vehicle_id, parsed); // last write wins → freshest position
        }
      }

      // Under the cap at a zoom that covers the cell → we saw everything here.
      // Still capped → too dense; split (unless we're already at the zoom floor).
      if (raw.length >= PER_CALL_CAP) {
        if (z < 17) {
          queue.push(
            { minLon: r.minLon, minLat: r.minLat, maxLon: cLon, maxLat: cLat },
            { minLon: cLon, minLat: r.minLat, maxLon: r.maxLon, maxLat: cLat },
            { minLon: r.minLon, minLat: cLat, maxLon: cLon, maxLat: r.maxLat },
            { minLon: cLon, minLat: cLat, maxLon: r.maxLon, maxLat: r.maxLat },
          );
        } else {
          underCovered++;
        }
      }
      if (queue.length && tiles < maxTiles && delayMs) await page.waitForTimeout(delayMs);
    }

    const complete = queue.length === 0 && underCovered === 0;
    return { vehicles: [...seen.values()], tiles, complete };
  });
}

export function registerYandexTransitTools(server: McpServer): void {
  server.registerTool(
    "get_live_transit",
    {
      description:
        "LIVE positions of Yerevan buses/trolleybuses, scraped from Yandex Maps' transport layer " +
        "(no public feed exists). Returns each moving vehicle with its line number, type, current " +
        "lon/lat and heading. Optionally filter by line number. NOTE: this drives a headless browser " +
        "and is inherently fragile — it can break if Yandex changes their site, and is subject to their " +
        "terms of use. Results are cached ~20s. The browser it needs is installed automatically.",
      inputSchema: {
        line: z
          .string()
          .optional()
          .describe("Filter to one line/route number as signed on the vehicle, e.g. '25', '1'"),
        ll: z
          .string()
          .optional()
          .describe(`Map centre as 'lon,lat' to bias the region. Default Yerevan centre (${YEREVAN_LL}).`),
      },
    },
    async ({ line, ll }): Promise<ToolResult> =>
      guard(async () => {
        const key = ll ?? YEREVAN_LL;
        let vehicles: Vehicle[];
        if (cache && cache.key === key && Date.now() - cache.ts < CACHE_MS) {
          vehicles = cache.vehicles;
        } else {
          try {
            vehicles = await captureVehicles(key);
          } catch (err) {
            if (err instanceof BrowserUnavailable) return errorResult(err.message);
            return errorResult(
              `Could not capture Yandex live transit (this scrape is fragile and may be rate-limited or changed): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          cache = { key, ts: Date.now(), vehicles };
        }

        const filtered = line ? vehicles.filter((v) => v.line === line) : vehicles;
        return jsonResult({
          source: "yandex-maps-scrape",
          fetched_at: new Date(cache!.ts).toISOString(),
          count: filtered.length,
          vehicles: filtered,
        });
      }),
  );

  server.registerTool(
    "get_active_fleet",
    {
      description:
        "The WHOLE active fleet of Yerevan public transport right now — a city-wide count of every " +
        "moving vehicle, not just the 75 Yandex returns per request. Works by sweeping the city in an " +
        "adaptive grid and de-duplicating by vehicle, so it takes a while (~30–90 s, dozens of browser " +
        "loads) and can be partly rate-limited by Yandex. Returns totals plus a breakdown by type and by " +
        "line; set include_vehicles=true for the full per-vehicle list. Same fragile Yandex scrape as " +
        "get_live_transit; the browser it needs is installed automatically.",
      inputSchema: {
        include_vehicles: z
          .boolean()
          .optional()
          .describe("Also return every vehicle's line/type/lon/lat/heading (large). Default: summary only."),
        max_tiles: z
          .number()
          .int()
          .min(4)
          .max(120)
          .optional()
          .describe("Sweep budget — more tiles = more complete but slower and more rate-limit risk. Default 48."),
      },
    },
    async ({ include_vehicles, max_tiles }): Promise<ToolResult> =>
      guard(async () => {
        let result: Awaited<ReturnType<typeof captureFleet>>;
        try {
          result = await captureFleet(undefined, max_tiles ? { maxTiles: max_tiles } : {});
        } catch (err) {
          if (err instanceof BrowserUnavailable) return errorResult(err.message);
          return errorResult(
            `Could not sweep the Yandex fleet (fragile scrape, may be rate-limited or changed): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        const tally = (key: (v: Vehicle) => string | null) => {
          const m = new Map<string, number>();
          for (const v of result.vehicles) {
            const k = key(v);
            if (k) m.set(k, (m.get(k) ?? 0) + 1);
          }
          return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
        };

        return jsonResult({
          source: "yandex-maps-scrape",
          fetched_at: new Date().toISOString(),
          active_vehicles: result.vehicles.length,
          complete: result.complete, // false → the count is a floor (sweep hit its budget)
          tiles_sampled: result.tiles,
          by_type: tally((v) => v.type),
          by_line: tally((v) => v.line),
          ...(include_vehicles ? { vehicles: result.vehicles } : {}),
        });
      }),
  );
}
