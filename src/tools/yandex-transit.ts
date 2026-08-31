import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guard, jsonResult, errorResult, type ToolResult } from "../mcp-util.js";
import { haversineMeters, num } from "../format.js";

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

/** Load the transport page in a headless browser and capture the vehicles JSON. */
export async function captureVehicles(ll: string): Promise<Vehicle[]> {
  let chromium: any; // dynamic optional dep — no compile-time types
  try {
    // @ts-ignore optional peer dep, resolved at runtime only
    ({ chromium } = await import("playwright"));
  } catch {
    throw new PlaywrightMissing();
  }

  const url = `https://yandex.com/maps/10262/yerevan/transport/?ll=${encodeURIComponent(ll)}&z=13`;
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const resp = await page.waitForResponse(
      (r: any) => /getVehiclesInfoWithRegion/.test(r.url()),
      { timeout: 35_000 },
    );
    const body = await resp.text();
    const vehicles = JSON.parse(body)?.data?.vehicles;
    if (!Array.isArray(vehicles)) throw new Error("unexpected Yandex response shape");
    const nowSec = Date.now() / 1000;
    return vehicles.map((v: any) => parseVehicle(v, nowSec)).filter((v) => v.lon != null && v.lat != null);
  } finally {
    await browser.close();
  }
}

class PlaywrightMissing extends Error {
  constructor() {
    super("playwright not installed");
  }
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
        "terms of use. Results are cached ~20s. Requires the optional 'playwright' package + browser " +
        "(`npx playwright install chromium`).",
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
            if (err instanceof PlaywrightMissing) {
              return errorResult(
                "Live transit needs the optional 'playwright' package and a browser. Install with:\n" +
                  "  npm i playwright && npx playwright install chromium",
              );
            }
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
}
