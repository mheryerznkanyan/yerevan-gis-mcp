import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ArcGisClient } from "../arcgis.js";
import { CATALOG, findLayer, type CatalogLayer } from "../catalog/layers.js";
import { describeFields } from "../format.js";
import { guard, jsonResult, textResult, type ToolResult } from "../mcp-util.js";

/** Resolve a tool's target layer from either a catalog key or explicit path+id. */
function resolveTarget(args: {
  layer_key?: string;
  service_path?: string;
  layer_id?: number;
}): { servicePath: string; layerId: number; catalog?: CatalogLayer } {
  if (args.layer_key) {
    const c = findLayer(args.layer_key);
    if (!c) {
      throw new Error(
        `Unknown layer_key "${args.layer_key}". Use search_layers to find one, or pass service_path + layer_id.`,
      );
    }
    return { servicePath: c.servicePath, layerId: c.layerId, catalog: c };
  }
  if (args.service_path != null && args.layer_id != null) {
    return { servicePath: args.service_path, layerId: args.layer_id };
  }
  throw new Error("Provide either layer_key, or both service_path and layer_id.");
}

function scoreLayer(l: CatalogLayer, terms: string[]): number {
  const hay = [l.key, l.title, l.description, ...l.keywords, l.domain]
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (!t) continue;
    if (hay.includes(t)) score += 2;
    if (l.title.toLowerCase().includes(t)) score += 3;
    if (l.keywords.some((k) => k.toLowerCase() === t)) score += 3;
  }
  return score;
}

export function registerGenericTools(server: McpServer, client: ArcGisClient): void {
  server.registerTool(
    "search_layers",
    {
      description:
        "Find datasets on the Yerevan city GIS portal by keyword. Returns curated layers with their layer_key, what each row is, geometry, approximate feature count and domain. " +
        "Use this first to discover what data exists, then pass a returned layer_key to describe_layer / query_layer / query_near_point. " +
        "Domains: air_quality, environment, cadastre, zoning, construction, transport, amenities, admin, addressing. English or Armenian keywords both work.",
      inputSchema: {
        query: z.string().describe("Keywords, e.g. 'air quality', 'parcels', 'bus stops', 'հուշարձան'").optional(),
        domain: z
          .string()
          .optional()
          .describe("Optional domain filter, e.g. 'air_quality' or 'cadastre'"),
      },
    },
    async ({ query, domain }): Promise<ToolResult> =>
      guard(async () => {
        const terms = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        let items = CATALOG.slice();
        if (domain) items = items.filter((l) => l.domain === domain);
        let ranked: CatalogLayer[];
        if (terms.length) {
          ranked = items
            .map((l) => ({ l, s: scoreLayer(l, terms) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .map((x) => x.l);
          if (ranked.length === 0) ranked = items; // fall back to the domain/all list
        } else {
          ranked = items;
        }
        const out = ranked.map((l) => ({
          layer_key: l.key,
          title: l.title,
          domain: l.domain,
          geometry: l.geometry,
          approx_count: l.approxCount ?? null,
          description: l.description,
          service_path: l.servicePath,
          layer_id: l.layerId,
          notes: l.notes,
        }));
        return jsonResult({ count: out.length, layers: out });
      }),
  );

  server.registerTool(
    "describe_layer",
    {
      description:
        "Inspect one layer's schema: its fields (name, type, Armenian alias), geometry type, feature count and capabilities. " +
        "Pass a curated layer_key from search_layers, OR any service_path + layer_id to reach a layer that isn't in the catalog. " +
        "Remember many Yerevan layers are NOT layer 0.",
      inputSchema: {
        layer_key: z.string().optional().describe("Curated key from search_layers"),
        service_path: z
          .string()
          .optional()
          .describe("Raw service path, e.g. 'Hosted/Կադաստր_քարտեզ/FeatureServer' (Armenian allowed)"),
        layer_id: z.number().int().optional().describe("Layer/table id within the service"),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { servicePath, layerId, catalog } = resolveTarget(args);
        const meta = await client.describeLayer(servicePath, layerId);
        let count: number | null = null;
        try {
          count = await client.count(servicePath, layerId);
        } catch {
          count = null;
        }
        const summary = {
          service_path: servicePath,
          layer_id: layerId,
          name: meta.name,
          type: meta.type,
          geometry_type: meta.geometryType ?? null,
          feature_count: count,
          object_id_field: meta.objectIdField ?? null,
          display_field: meta.displayField ?? null,
          capabilities: meta.capabilities ?? null,
          max_record_count: meta.maxRecordCount ?? null,
          supported_query_formats: meta.supportedQueryFormats ?? null,
          catalog_notes: catalog?.notes ?? null,
          address_field: catalog?.addressField ?? null,
        };
        const fieldText = describeFields(meta.fields ?? []);
        return textResult(
          JSON.stringify(summary, null, 2) + "\n\nFields:\n" + fieldText,
        );
      }),
  );

  server.registerTool(
    "query_layer",
    {
      description:
        "Run an attribute query against any layer and get rows back as JSON. This is the workhorse: set where='1=1' to dump a whole table (paginated automatically), or a SQL where clause to filter. " +
        "Geometry is off by default; set return_geometry=true to get WGS84 lat/lon. " +
        "Armenian category values are free text (no coded domains) — use get_distinct_values to discover exact spellings. Numeric air-quality metrics are sometimes stored as strings.",
      inputSchema: {
        layer_key: z.string().optional().describe("Curated key from search_layers"),
        service_path: z.string().optional(),
        layer_id: z.number().int().optional(),
        where: z
          .string()
          .default("1=1")
          .describe("SQL where clause, e.g. \"cmm_cc='005'\" or \"code LIKE '01-001%'\". Default 1=1 (all rows)."),
        out_fields: z.string().default("*").describe("Comma-separated field names, or * for all"),
        order_by: z.string().optional().describe("e.g. 'objectid DESC'"),
        limit: z.number().int().min(1).max(5000).default(50).describe("Max rows to return (auto-paginated)"),
        offset: z.number().int().min(0).default(0),
        return_geometry: z.boolean().default(false),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { servicePath, layerId } = resolveTarget(args);
        const { fields, rows, truncated } = await client.queryLayer(
          servicePath,
          layerId,
          {
            where: args.where,
            outFields: args.out_fields,
            orderByFields: args.order_by,
            returnGeometry: args.return_geometry,
            resultOffset: args.offset,
            outSR: 4326,
          },
          args.limit,
        );
        return jsonResult({
          service_path: servicePath,
          layer_id: layerId,
          returned: rows.length,
          truncated,
          field_names: fields?.map((f) => f.name),
          rows: rows.map((r) => (args.return_geometry ? r : r.attributes)),
        });
      }),
  );

  server.registerTool(
    "count_features",
    {
      description:
        "Count features matching a where clause, without pulling the rows. Cheap way to answer 'how many X' or to size a query before fetching. Works on any layer.",
      inputSchema: {
        layer_key: z.string().optional(),
        service_path: z.string().optional(),
        layer_id: z.number().int().optional(),
        where: z.string().default("1=1"),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { servicePath, layerId } = resolveTarget(args);
        const count = await client.count(servicePath, layerId, { where: args.where });
        return jsonResult({ service_path: servicePath, layer_id: layerId, where: args.where, count });
      }),
  );

  server.registerTool(
    "get_distinct_values",
    {
      description:
        "List the distinct values of one field — the way to discover the exact (Armenian, free-text) categories a layer uses before filtering on them, e.g. the land-use types in the master plan or the districts in a POI layer.",
      inputSchema: {
        layer_key: z.string().optional(),
        service_path: z.string().optional(),
        layer_id: z.number().int().optional(),
        field: z.string().describe("Field name to list distinct values of"),
        where: z.string().default("1=1"),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { servicePath, layerId } = resolveTarget(args);
        const values = await client.distinctValues(servicePath, layerId, args.field, args.where);
        return jsonResult({ field: args.field, distinct_count: values.length, values });
      }),
  );

  server.registerTool(
    "query_near_point",
    {
      description:
        "Find features of a layer within a radius of a lon/lat point — 'what is near me'. Great for nearest bus stops, air sensors, construction sites, or the parcel/zoning at a location (use radius 0 with a polygon layer for an exact point-in-polygon hit). Returns rows sorted by nothing in particular; compute distance client-side if needed.",
      inputSchema: {
        layer_key: z.string().optional(),
        service_path: z.string().optional(),
        layer_id: z.number().int().optional(),
        lon: z.number().describe("Longitude (WGS84), e.g. 44.5126"),
        lat: z.number().describe("Latitude (WGS84), e.g. 40.1776"),
        radius_m: z.number().min(0).default(500).describe("Search radius in metres (0 = exact intersect)"),
        where: z.string().default("1=1"),
        out_fields: z.string().default("*"),
        limit: z.number().int().min(1).max(1000).default(50),
        return_geometry: z.boolean().default(false),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { servicePath, layerId } = resolveTarget(args);
        const opts = {
          where: args.where,
          outFields: args.out_fields,
          geometry: `${args.lon},${args.lat}`,
          geometryType: "esriGeometryPoint" as const,
          inSR: 4326,
          outSR: 4326,
          spatialRel: "esriSpatialRelIntersects",
          returnGeometry: args.return_geometry,
          ...(args.radius_m > 0 ? { distance: args.radius_m, units: "esriSRUnit_Meter" } : {}),
        };
        const { fields, rows, truncated } = await client.queryLayer(servicePath, layerId, opts, args.limit);
        return jsonResult({
          service_path: servicePath,
          layer_id: layerId,
          center: { lon: args.lon, lat: args.lat },
          radius_m: args.radius_m,
          returned: rows.length,
          truncated,
          field_names: fields?.map((f) => f.name),
          rows: rows.map((r) => (args.return_geometry ? r : r.attributes)),
        });
      }),
  );

  server.registerTool(
    "aggregate",
    {
      description:
        "Server-side aggregation (count/min/max/avg/sum), optionally grouped by a field — e.g. count parcels per district, average sensor AQI, max reading date. Cheaper and more precise than pulling rows and summing client-side.",
      inputSchema: {
        layer_key: z.string().optional(),
        service_path: z.string().optional(),
        layer_id: z.number().int().optional(),
        stat_type: z.enum(["count", "min", "max", "avg", "sum", "stddev", "var"]),
        field: z.string().describe("Field to aggregate (any field for count)"),
        group_by: z.string().optional().describe("Optional field to group by"),
        where: z.string().default("1=1"),
        order_by: z.string().optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { servicePath, layerId } = resolveTarget(args);
        const rows = await client.statistics(
          servicePath,
          layerId,
          [
            {
              statisticType: args.stat_type,
              onStatisticField: args.field,
              outStatisticFieldName: "value",
            },
          ],
          { where: args.where, groupByFields: args.group_by, orderByFields: args.order_by },
        );
        return jsonResult({ stat: args.stat_type, field: args.field, group_by: args.group_by ?? null, results: rows });
      }),
  );

  server.registerTool(
    "get_map_image",
    {
      description:
        "Render a PNG map image of an area from a MapServer service and return the image URL (href). Use for a quick visual of a bounding box. Provide a WGS84 bbox as xmin,ymin,xmax,ymax. Not all services publish a MapServer; FeatureServers do not.",
      inputSchema: {
        service_path: z
          .string()
          .describe("A MapServer service path, e.g. 'Yerevan_Named_Roads/MapServer'"),
        bbox: z.string().describe("WGS84 bbox 'xmin,ymin,xmax,ymax', e.g. '44.49,40.16,44.54,40.20'"),
        width: z.number().int().min(64).max(2048).default(800),
        height: z.number().int().min(64).max(2048).default(600),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        let path = args.service_path.replace(/\/+$/, "");
        if (!/MapServer$/i.test(path)) path = `${path}/MapServer`;
        const url = `${client.serviceUrl(path)}/export`;
        const json = await client.getResource(url, {
          bbox: args.bbox,
          bboxSR: "4326",
          imageSR: "4326",
          size: `${args.width},${args.height}`,
          format: "png",
          transparent: "false",
        });
        return jsonResult({
          image_url: json.href ?? null,
          width: json.width,
          height: json.height,
          extent: json.extent,
          scale: json.scale,
        });
      }),
  );

  server.registerTool(
    "list_service_layers",
    {
      description:
        "List the layers and tables inside a raw ArcGIS service, for exploring services that aren't in the curated catalog. Returns each layer's id, name and geometry so you can pick the right layer_id (Yerevan services often skip layer 0).",
      inputSchema: {
        service_path: z
          .string()
          .describe("Service path, e.g. 'Hosted/Կադաստր_քարտեզ/FeatureServer' (Armenian allowed; /FeatureServer optional)"),
      },
    },
    async ({ service_path }): Promise<ToolResult> =>
      guard(async () => {
        const meta = await client.describeService(service_path);
        const layers = (meta.layers ?? []).map((l: any) => ({
          id: l.id,
          name: l.name,
          geometry: l.geometryType ?? null,
          type: "layer",
        }));
        const tables = (meta.tables ?? []).map((t: any) => ({ id: t.id, name: t.name, type: "table" }));
        return jsonResult({
          service_path,
          current_version: meta.currentVersion ?? null,
          capabilities: meta.capabilities ?? null,
          layers,
          tables,
        });
      }),
  );
}
