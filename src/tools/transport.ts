import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ArcGisClient } from "../arcgis.js";
import { findLayer, type CatalogLayer } from "../catalog/layers.js";
import { clean, num, haversineMeters } from "../format.js";
import { BUS_STOPS, type BusStop } from "../data/bus-stops.js";
import { BUS_ROUTES, type BusRoute } from "../data/bus-routes.js";
import { guard, jsonResult, type ToolResult } from "../mcp-util.js";

/** Point layers we can do a "nearby" search against, with their name/address fields. */
const NEARBY_KINDS: Record<string, { key: string; nameFields: string[]; addressField?: string }> = {
  bus_stop: { key: "bus_stops", nameFields: ["street"], addressField: "address" },
  metro_station: { key: "metro_stations", nameFields: ["մետրո_կայան"] },
  air_sensor: { key: "air_devices", nameFields: ["code"], addressField: "globalid" },
  waste_bin: { key: "waste_bins", nameFields: ["adress"], addressField: "adress" },
  kindergarten: { key: "kindergartens", nameFields: ["kind_name"], addressField: "address" },
  hotel: { key: "hotels", nameFields: ["հյուրանոցի__անվանումը"], addressField: "հասցե" },
  construction: { key: "constructions", nameFields: ["description"], addressField: "address" },
  elevator: { key: "elevators", nameFields: ["address"], addressField: "address" },
  plaque: { key: "memorial_plaques", nameFields: ["name"], addressField: "address" },
  monument: { key: "monuments_all", nameFields: ["name"], addressField: "address" },
  cemetery: { key: "cemeteries", nameFields: ["հասցե"], addressField: "հասցե" },
  substation: { key: "substations", nameFields: ["anun"] },
  medical_center: { key: "medical_centers", nameFields: ["name_am", "name_fr"], addressField: "add_am" },
};

/** Routes and stops are baked in (see src/data), so these lookups need no network. */
const STOP_BY_ID = new Map<number, BusStop>(BUS_STOPS.map((s) => [s.id, s]));

/** Every name a stop or route goes by, lowercased, for substring matching. */
const names = (o: { name?: string | null; name_en?: string; name_ru?: string; name_hy?: string }) =>
  [o.name, o.name_en, o.name_ru, o.name_hy].filter(Boolean).join(" ").toLowerCase();

const routeSummary = (r: BusRoute) => ({
  id: r.id,
  ref: r.ref,
  mode: r.mode,
  from: r.from ?? null,
  to: r.to ?? null,
  stop_count: r.stops.length,
});

export function registerTransportTools(server: McpServer, client: ArcGisClient): void {
  const roads = findLayer("named_roads")!;
  const toponyms = findLayer("toponyms")!;

  server.registerTool(
    "find_bus_routes",
    {
      description:
        `Find Yerevan bus and trolleybus routes (${BUS_ROUTES.length} routes over ${BUS_STOPS.length} stops, ` +
        "from OpenStreetMap, baked in — no network call). Filter by route number, by name text " +
        "(Armenian, English or Russian), or by which routes pass near a lon/lat point. " +
        "Each direction of a route is a separate entry. Use get_bus_route for the ordered stop list.",
      inputSchema: {
        ref: z.string().optional().describe("Route number as signed on the vehicle, e.g. '77', '1'"),
        query: z.string().optional().describe("Text to match against route name, origin or destination"),
        lon: z.number().optional().describe("Longitude (WGS84); with lat, finds routes stopping nearby"),
        lat: z.number().optional().describe("Latitude (WGS84); with lon, finds routes stopping nearby"),
        radius_m: z.number().min(50).max(5000).default(500),
        mode: z.enum(["bus", "trolleybus"]).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      },
    },
    async ({ ref, query, lon, lat, radius_m, mode, limit }): Promise<ToolResult> =>
      guard(async () => {
        let routes = BUS_ROUTES.filter((r) => !mode || r.mode === mode);
        if (ref) routes = routes.filter((r) => r.ref === ref.trim());
        if (query) {
          const q = query.trim().toLowerCase();
          routes = routes.filter((r) => names(r).includes(q) || (r.from ?? "").toLowerCase().includes(q) || (r.to ?? "").toLowerCase().includes(q));
        }

        // Near a point: report which of the route's stops matched, and how far.
        if (lon != null && lat != null) {
          const near = new Map<number, { stop: BusStop; distance_m: number }>();
          for (const s of BUS_STOPS) {
            const d = haversineMeters(lon, lat, s.lon, s.lat);
            if (d <= radius_m) near.set(s.id, { stop: s, distance_m: Math.round(d) });
          }
          const items = routes
            .map((r) => {
              const hits = r.stops.map((id) => near.get(id)).filter((h) => h != null);
              if (!hits.length) return null;
              const best = hits.reduce((a, b) => (b.distance_m < a.distance_m ? b : a));
              return {
                ...routeSummary(r),
                nearest_stop: { id: best.stop.id, name: best.stop.name, name_en: best.stop.name_en ?? null },
                distance_m: best.distance_m,
              };
            })
            .filter((x) => x != null)
            .sort((a, b) => a.distance_m - b.distance_m)
            .slice(0, limit);
          return jsonResult({ center: { lon, lat }, radius_m, count: items.length, routes: items });
        }

        const items = routes.slice(0, limit).map(routeSummary);
        return jsonResult({ count: items.length, total_matched: routes.length, routes: items });
      }),
  );

  server.registerTool(
    "get_bus_route",
    {
      description:
        "Get one Yerevan bus/trolleybus route with its stops in travel order, each with coordinates. " +
        "Takes the route id from find_bus_routes, or a route number (which may match several directions).",
      inputSchema: {
        id: z.number().optional().describe("OpenStreetMap relation id from find_bus_routes"),
        ref: z.string().optional().describe("Route number, e.g. '77' — returns every direction"),
      },
    },
    async ({ id, ref }): Promise<ToolResult> =>
      guard(async () => {
        const matches = id != null
          ? BUS_ROUTES.filter((r) => r.id === id)
          : ref
            ? BUS_ROUTES.filter((r) => r.ref === ref.trim())
            : [];
        if (!matches.length) {
          return jsonResult({
            error: id != null ? `No route with id ${id}` : ref ? `No route numbered '${ref}'` : "Pass id or ref",
            hint: "Use find_bus_routes to list available routes.",
          });
        }
        return jsonResult({
          count: matches.length,
          routes: matches.map((r) => ({
            ...routeSummary(r),
            name: r.name ?? null,
            colour: r.colour ?? null,
            stops: r.stops.map((sid, i) => {
              const s = STOP_BY_ID.get(sid)!;
              return {
                seq: i + 1,
                id: s.id,
                name: s.name,
                name_en: s.name_en ?? null,
                lon: s.lon,
                lat: s.lat,
              };
            }),
          })),
        });
      }),
  );

  server.registerTool(
    "find_nearby_amenities",
    {
      description:
        "Find the nearest amenities of a given kind to a lon/lat point, sorted by distance. Kinds: " +
        Object.keys(NEARBY_KINDS).join(", ") +
        ". Good for 'nearest bus stop', 'closest air sensor', 'kindergartens within 1km'.",
      inputSchema: {
        kind: z.enum(Object.keys(NEARBY_KINDS) as [string, ...string[]]),
        lon: z.number().describe("Longitude (WGS84)"),
        lat: z.number().describe("Latitude (WGS84)"),
        radius_m: z.number().min(50).max(10000).default(1000),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ kind, lon, lat, radius_m, limit }): Promise<ToolResult> =>
      guard(async () => {
        const spec = NEARBY_KINDS[kind]!;
        const layer = findLayer(spec.key) as CatalogLayer;
        const { rows } = await client.queryLayer(
          layer.servicePath,
          layer.layerId,
          {
            where: "1=1",
            outFields: "*",
            geometry: `${lon},${lat}`,
            geometryType: "esriGeometryPoint",
            inSR: 4326,
            outSR: 4326,
            spatialRel: "esriSpatialRelIntersects",
            distance: radius_m,
            units: "esriSRUnit_Meter",
            returnGeometry: true,
          },
          500,
        );
        const items = rows
          .map((r) => {
            const a = r.attributes;
            const g = r.geometry as { x?: number; y?: number } | undefined;
            // Prefer explicit lat/lon attributes where present, else geometry.
            const plon = num(a["longitude"]) ?? num(a["x"]) ?? g?.x ?? null;
            const plat = num(a["latitude"]) ?? num(a["y"]) ?? g?.y ?? null;
            const name =
              spec.nameFields.map((f) => clean(a[f])).find((v) => v) ?? null;
            const distance =
              plon != null && plat != null ? Math.round(haversineMeters(lon, lat, plon, plat)) : null;
            return {
              name,
              address: spec.addressField ? clean(a[spec.addressField]) : null,
              lon: plon,
              lat: plat,
              distance_m: distance,
            };
          })
          .filter((x) => x.distance_m == null || x.distance_m <= radius_m)
          .sort((a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity))
          .slice(0, limit);
        return jsonResult({ kind, center: { lon, lat }, radius_m, count: items.length, items });
      }),
  );

  server.registerTool(
    "search_street",
    {
      description:
        "Search Yerevan streets by (Armenian) name — the portal's stand-in geocoder, since the real geocoder needs a token. Returns matching street names, their toponym id and status, from the official register. " +
        "Names are Armenian only (no Latin/English). Also finds renamed streets via previous names.",
      inputSchema: {
        name: z.string().describe("Street name fragment in Armenian, e.g. 'Աբովյան', 'Բաղրամյան'"),
        limit: z.number().int().min(1).max(50).default(15),
      },
    },
    async ({ name, limit }): Promise<ToolResult> =>
      guard(async () => {
        const esc = name.replace(/'/g, "''");
        // Primary: the road centerline layer (has geometry we could extend to later).
        const { rows } = await client.queryLayer(
          roads.servicePath,
          roads.layerId,
          {
            where: `street_name LIKE '%${esc}%' AND street_name IS NOT NULL`,
            outFields: "street_name,street_id,toponym_type,toponym_status",
            returnGeometry: false,
            orderByFields: "street_name ASC",
          },
          500,
        );
        // Dedupe by street_id (many geometry rows per street).
        const seen = new Map<string, { street_name: string | null; street_id: unknown; type: string | null; status: string | null }>();
        for (const r of rows) {
          const a = r.attributes;
          const id = String(a["street_id"] ?? a["street_name"]);
          if (!seen.has(id)) {
            seen.set(id, {
              street_name: clean(a["street_name"]),
              street_id: a["street_id"] ?? null,
              type: clean(a["toponym_type"]),
              status: clean(a["toponym_status"]),
            });
          }
        }
        let results = Array.from(seen.values()).slice(0, limit);

        // Fallback: the official register (also carries previous_names).
        if (results.length === 0) {
          const { rows: tr } = await client.queryLayer(
            toponyms.servicePath,
            toponyms.layerId,
            {
              where: `toponym_full_name LIKE '%${esc}%' OR previous_names LIKE '%${esc}%'`,
              outFields: "toponym_full_name,street_id,toponym_type,toponym_status,previous_names",
              returnGeometry: false,
            },
            limit,
          );
          results = tr.map((r) => ({
            street_name: clean(r.attributes["toponym_full_name"]),
            street_id: r.attributes["street_id"] ?? null,
            type: clean(r.attributes["toponym_type"]),
            status: clean(r.attributes["toponym_status"]),
          }));
        }
        return jsonResult({ query: name, count: results.length, streets: results });
      }),
  );
}
