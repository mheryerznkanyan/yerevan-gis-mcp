#!/usr/bin/env node
/**
 * Regenerates src/data/bus-stops.ts and src/data/bus-routes.ts from OpenStreetMap.
 *
 * The two files join on OSM node id, so they must be regenerated together —
 * that is the only reason this script exists rather than a pasted query.
 *
 *   node scripts/fetch-transit.mjs
 *
 * Data: OpenStreetMap contributors, ODbL 1.0.
 */
import { writeFileSync } from "node:fs";

const ENDPOINT = "https://overpass-api.de/api/interpreter";
const AREA = 'area["name:en"="Yerevan"]["admin_level"="4"]->.a;';

/** Overpass allows 2 slots per IP and 429s past that; wait and retry. */
const overpass = async (query, attempt = 1) => {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    // Overpass answers 406 to the default Node fetch agent; it wants a real UA.
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "yerevan-gis-mcp/1.0 (+https://github.com/mheryerznkanyan/yerevan-gis-mcp)",
    },
    body: new URLSearchParams({ data: `[out:json][timeout:120];${query}` }),
  });
  const body = await res.text();
  // A rate-limited query can come back as 429 or as a 200 carrying an error page.
  if (res.status === 429 || (res.ok && body.startsWith("<"))) {
    if (attempt > 5) throw new Error(`Overpass still rate-limiting after ${attempt} tries`);
    const wait = 30 * attempt;
    console.error(`rate-limited, retrying in ${wait}s (attempt ${attempt})`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return overpass(query, attempt + 1);
  }
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${body}`);
  return JSON.parse(body).elements;
};

const STOPS_Q = `${AREA}(node(area.a)["highway"="bus_stop"];node(area.a)["public_transport"="platform"]["bus"="yes"];);out body;`;
const ROUTES_Q = `${AREA}relation(area.a)["type"="route"]["route"~"^(bus|trolleybus|minibus|share_taxi|tram)$"];out body;`;

// Serial, not parallel: Overpass rate-limits concurrent slots per IP.
const stopNodes = await overpass(STOPS_Q);
const relations = await overpass(ROUTES_Q);

// A route's ordered stops are its "platform*" members. Suburban termini fall
// outside the city boundary, so pull any referenced node the area query missed.
const platformsOf = (rel) =>
  rel.members.filter((m) => m.type === "node" && m.role.startsWith("platform")).map((m) => m.ref);

// Suburban termini (Jrvezh, Ptghni) fall outside the city boundary, so route
// members must be resolved separately from the area query.
const candidates = relations.filter((r) => platformsOf(r).length >= 2);
const known = new Set(stopNodes.map((n) => n.id));
const missing = [...new Set(candidates.flatMap(platformsOf).filter((id) => !known.has(id)))];
const extra = missing.length ? await overpass(`node(id:${missing.join(",")});out body;`) : [];

// Intercity coach relations (Goris, Sevan, Gyumri) also survive the member-count
// check, and would drag stops hundreds of km away into the set. Geography is the
// real discriminator: a city route keeps every stop within greater Yerevan.
const BBOX = { minLat: 40.0, maxLat: 40.35, minLon: 44.3, maxLon: 44.75 };
const coords = new Map([...stopNodes, ...extra].map((n) => [n.id, n]));
const inCity = (id) => {
  const n = coords.get(id);
  return (
    n &&
    n.lat >= BBOX.minLat && n.lat <= BBOX.maxLat &&
    n.lon >= BBOX.minLon && n.lon <= BBOX.maxLon
  );
};
const cityRoutes = candidates.filter((r) => platformsOf(r).every(inCity));
const served = new Set(cityRoutes.flatMap(platformsOf));

const toStop = (n) => {
  const t = n.tags ?? {};
  return {
    id: n.id,
    name: t["name:hy"] || t.name || null,
    lat: +n.lat.toFixed(6),
    lon: +n.lon.toFixed(6),
    ...(t["name:en"] && { name_en: t["name:en"] }),
    ...(t["name:ru"] && { name_ru: t["name:ru"] }),
    ...(t.trolleybus === "yes" && { trolleybus: true }),
    ...(t.shelter === "yes" && { shelter: true }),
  };
};

// Keep the city's own stops plus any out-of-boundary stop a kept route serves;
// drop the rest of the fetched-by-id nodes, which belong to dropped routes.
const stops = [...stopNodes, ...extra.filter((n) => served.has(n.id))]
  .map(toStop)
  .sort((a, b) => (a.name ?? "￿").localeCompare(b.name ?? "￿", "hy") || a.id - b.id);

const routes = cityRoutes
  .map((r) => {
    const t = r.tags;
    return {
      id: r.id,
      ref: t.ref ?? null,
      mode: t.route === "trolleybus" ? "trolleybus" : "bus",
      ...(t.name && { name: t.name }),
      ...(t["name:hy"] && { name_hy: t["name:hy"] }),
      ...(t["name:ru"] && { name_ru: t["name:ru"] }),
      ...(t.from && { from: t.from }),
      ...(t.to && { to: t.to }),
      ...(t.colour && { colour: t.colour }),
      stops: platformsOf(r),
    };
  })
  .sort((a, b) => String(a.ref).localeCompare(String(b.ref), "en", { numeric: true }));

const row = (o) =>
  "  { " +
  Object.entries(o)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : JSON.stringify(v)}`)
    .join(", ") +
  " },";

const header = (what, extraLines) => `/**
 * Yerevan ${what}, baked in at build time — no network call, no ArcGIS
 * round-trip.
 *
 * Source: OpenStreetMap contributors, ODbL 1.0
 *   https://opendatacommons.org/licenses/odbl/
 * Generated: ${new Date().toISOString().slice(0, 10)} by scripts/fetch-transit.mjs
${extraLines}
 * ponytail: a static snapshot, not a live feed. Re-run the script when the
 * network changes; wire up a live fetch only if that stops being often enough.
 */`;

writeFileSync(
  "src/data/bus-stops.ts",
  `${header(
    "bus and trolleybus stops",
    ` *\n * ${stops.length} stops (${stops.filter((s) => s.name).length} named). The portal's own\n * Bus_stops_lots layer carries only ~384, which is why these are not read from it.\n *`,
  )}

export interface BusStop {
  /** OpenStreetMap node id. Stable across regenerations; joins to BusRoute.stops. */
  id: number;
  /** Armenian name, or null where OSM has located a stop but not named it. */
  name: string | null;
  lat: number;
  lon: number;
  name_en?: string;
  name_ru?: string;
  trolleybus?: boolean;
  shelter?: boolean;
}

export const BUS_STOPS: readonly BusStop[] = [
${stops.map(row).join("\n")}
];
`,
);

writeFileSync(
  "src/data/bus-routes.ts",
  `${header(
    "bus and trolleybus routes",
    ` *\n * ${routes.length} routes. Intercity coach relations are excluded: OSM maps their\n * roadway but at most one of their stops.\n *`,
  )}

export interface BusRoute {
  /** OpenStreetMap relation id. */
  id: number;
  /** Route number as signed on the vehicle, e.g. "77", "1". */
  ref: string | null;
  mode: "bus" | "trolleybus";
  name?: string;
  name_hy?: string;
  name_ru?: string;
  from?: string;
  to?: string;
  colour?: string;
  /** Ordered BusStop ids along the route. One direction per relation. */
  stops: number[];
}

export const BUS_ROUTES: readonly BusRoute[] = [
${routes.map(row).join("\n")}
];
`,
);

console.log(`${stops.length} stops, ${routes.length} routes`);
