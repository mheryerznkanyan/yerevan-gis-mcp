import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ArcGisClient } from "../arcgis.js";
import { guard, jsonResult, type ToolResult } from "../mcp-util.js";

/** Known public apps on the portal (title + id + kind), from profiling. */
const KNOWN_APPS: Array<{ title: string; id: string; kind: string }> = [
  { title: "Air Pollution PM2.5 AQI platform", id: "d6435f44ea92460682d12c2317612b29", kind: "Web Experience" },
  { title: "Construction permits public platform", id: "5b664ee26f71429caa0745deb53f2155", kind: "Web Experience" },
  { title: "Master plan (Գլխավոր հատակագիծ)", id: "6b47fa041f0d49578bfde03d79705c22", kind: "Web Experience" },
  { title: "Investment projects platform", id: "872b657af3704f32b2838c9b894a4053", kind: "Web Experience" },
  { title: "Road network & transport organization", id: "13c109e913644a8d877db51465ace1f2", kind: "Web Experience" },
  { title: "Cultural & historical monuments", id: "fc8118116b344e7ebacbd1c82fa698ff", kind: "Web Experience" },
  { title: "Memorial plaques platform", id: "0414e699e22b4ae58f0743f51e29fc59", kind: "Web Experience" },
  { title: "Named geographic objects", id: "89ea22d5a464438095a8e8f849431684", kind: "Web Experience" },
  { title: "Engineering-geological map", id: "dad660b02c204a1cae2d54cefd7c1385", kind: "Web Experience" },
  { title: "Construction-site dust (PM) dashboard", id: "364e942224b544418ae7ef148fbc9bf1", kind: "Dashboard" },
  { title: "Waste bins dashboard", id: "7c6144d445d54687a3b86cf42f99989f", kind: "Dashboard" },
  { title: "Elevator replacement dashboard", id: "17ec1b4b6e8c41d0bbc1af79e66e49ea", kind: "Dashboard" },
  { title: "Bus-shelter lots dashboard", id: "a4e21cdbd7b84136b8224c6189155892", kind: "Dashboard" },
  { title: "Yerevan Geoportal (front door)", id: "0c7ad5152e7f413890b19e54dd187588", kind: "StoryMap" },
];

const APP_BASE = "https://gis.yerevan.am/portal/apps";
const ITEM_BASE = "https://gis.yerevan.am/portal/home/item.html?id=";

export function registerPortalTools(server: McpServer, client: ArcGisClient): void {
  server.registerTool(
    "list_public_apps",
    {
      description:
        "List the Yerevan municipality's public web apps and dashboards (air pollution, construction permits, master plan, investment projects, monuments, waste bins, elevators…). Returns titles, kinds and viewer URLs.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const apps = KNOWN_APPS.map((a) => ({
          ...a,
          item_url: `${ITEM_BASE}${a.id}`,
        }));
        return jsonResult({ count: apps.length, apps });
      }),
  );

  server.registerTool(
    "search_portal_items",
    {
      description:
        "Search the ArcGIS portal's item catalog (feature services, web maps, dashboards, apps) published by the municipality. Excludes Esri's default basemaps. Use this to discover datasets or apps beyond the curated catalog. Returns id, type, title and owner.",
      inputSchema: {
        query: z.string().optional().describe("Free text, e.g. 'metro', 'պուրակ'"),
        type: z
          .string()
          .optional()
          .describe('Item type filter, e.g. "Feature Service", "Web Map", "Dashboard", "Web Experience"'),
        limit: z.number().int().min(1).max(100).default(30),
      },
    },
    async ({ query, type, limit }): Promise<ToolResult> =>
      guard(async () => {
        const parts = ["-owner:esri_*"];
        if (query) parts.push(query);
        if (type) parts.push(`type:"${type}"`);
        const json = await client.portalSearch(parts.join(" "), { num: limit });
        const results = (json.results ?? []).map((it: any) => ({
          id: it.id,
          type: it.type,
          title: it.title,
          owner: it.owner,
          item_url: `${ITEM_BASE}${it.id}`,
        }));
        return jsonResult({ total: json.total ?? results.length, returned: results.length, items: results });
      }),
  );

  server.registerTool(
    "get_web_map_layers",
    {
      description:
        "Read the operational layers of a portal web map or app by item id (from search_portal_items or list_public_apps). Reveals which feature-service URLs an app is built on — a fast way to discover the data behind a public map.",
      inputSchema: {
        item_id: z.string().describe("Portal item id (32 hex chars)"),
      },
    },
    async ({ item_id }): Promise<ToolResult> =>
      guard(async () => {
        const data = await client.portalItemData(item_id);
        const opLayers = (data.operationalLayers ?? []).map((l: any) => ({
          title: l.title,
          layer_type: l.layerType,
          url: l.url ?? null,
          item_id: l.itemId ?? null,
        }));
        const basemapLayers = (data.baseMap?.baseMapLayers ?? []).map((l: any) => ({
          title: l.title ?? null,
          url: l.url ?? null,
        }));
        return jsonResult({
          item_id,
          operational_layers: opLayers,
          basemap_layers: basemapLayers,
          note: opLayers.length === 0 ? "This item has no operational layers (may be a Dashboard/Experience — try search_portal_items for its data services)." : undefined,
        });
      }),
  );
}
