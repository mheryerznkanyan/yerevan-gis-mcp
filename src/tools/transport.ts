import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ArcGisClient } from "../arcgis.js";
import { findLayer, type CatalogLayer } from "../catalog/layers.js";
import { clean, num, haversineMeters } from "../format.js";
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
};

export function registerTransportTools(server: McpServer, client: ArcGisClient): void {
  const roads = findLayer("named_roads")!;
  const toponyms = findLayer("toponyms")!;

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
