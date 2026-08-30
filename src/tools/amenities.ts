import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ArcGisClient } from "../arcgis.js";
import { findLayer } from "../catalog/layers.js";
import { clean, num } from "../format.js";
import { guard, jsonResult, type ToolResult } from "../mcp-util.js";

export function registerAmenityTools(server: McpServer, client: ArcGisClient): void {
  const investment = findLayer("investment_projects")!;
  const monteLots = findLayer("monte_lots")!;
  const kgFinance = findLayer("kindergarten_finance")!;
  const plaques = findLayer("memorial_plaques")!;
  const monuments = findLayer("monuments_all")!;

  server.registerTool(
    "list_investment_projects",
    {
      description:
        "List the municipality's investment / redevelopment projects by name (Promenad, Monte, etc.), plus the Monte project's lot subdivision where available. " +
        "Note: the portal only exposes project names and 3D footprints anonymously — status, owner and priority-for-sale data live in a separate, access-restricted layer, so those aren't available here.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        let projects: Array<{ name: string | null }> = [];
        try {
          const { rows } = await client.queryLayer(
            investment.servicePath,
            investment.layerId,
            { where: "1=1", outFields: "name", returnGeometry: false },
            200,
          );
          projects = rows.map((r) => ({ name: clean(r.attributes["name"]) }));
        } catch {
          projects = [];
        }
        let monteLotList: Array<{ lot: string | null; area_sqm: number | null }> = [];
        try {
          const { rows } = await client.queryLayer(
            monteLots.servicePath,
            monteLots.layerId,
            { where: "1=1", outFields: "layer,SHAPE__Area", returnGeometry: false },
            50,
          );
          monteLotList = rows.map((r) => ({
            lot: clean(r.attributes["layer"]),
            area_sqm: num(r.attributes["SHAPE__Area"]),
          }));
        } catch {
          monteLotList = [];
        }
        return jsonResult({
          project_count: projects.length,
          projects,
          monte_lots: monteLotList,
          note:
            "Status/owner/priority-of-sale is not published anonymously (token-restricted layer). For richer investment context see the StoryMaps and the Investment Projects web app via list_public_apps.",
        });
      }),
  );

  server.registerTool(
    "get_kindergarten_finance",
    {
      description:
        "Municipal kindergarten financing totals per year (2019-2025). Returns each year and its total financing amount (AMD).",
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { rows } = await client.queryLayer(
          kgFinance.servicePath,
          kgFinance.layerId,
          { where: "1=1", outFields: "year,finance", orderByFields: "year ASC", returnGeometry: false },
          50,
        );
        const series = rows
          .map((r) => ({ year: num(r.attributes["year"]), finance_amd: num(r.attributes["finance"]) }))
          .filter((x) => x.year != null);
        return jsonResult({ years: series.length, financing: series });
      }),
  );

  server.registerTool(
    "search_heritage",
    {
      description:
        "Search cultural heritage — memorial plaques and monuments — by name/address text (Armenian). Plaques return who is honoured + address + the authorising council decision; monuments return name, category, address and historical period.",
      inputSchema: {
        query: z.string().describe("Text to match in the name or address (Armenian), e.g. 'Ավագյան', 'Պուշկին'"),
        kind: z.enum(["plaque", "monument", "both"]).default("both"),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ query, kind, limit }): Promise<ToolResult> =>
      guard(async () => {
        const esc = query.replace(/'/g, "''");
        const out: Record<string, unknown> = { query };
        if (kind === "plaque" || kind === "both") {
          const { rows } = await client.queryLayer(
            plaques.servicePath,
            plaques.layerId,
            {
              where: `name LIKE '%${esc}%' OR address LIKE '%${esc}%'`,
              outFields: "name,address,decision,notes",
              returnGeometry: false,
            },
            limit,
          );
          out.plaques = rows.map((r) => ({
            name: clean(r.attributes["name"]),
            address: clean(r.attributes["address"]),
            council_decision: clean(r.attributes["decision"]),
            notes: clean(r.attributes["notes"]),
          }));
        }
        if (kind === "monument" || kind === "both") {
          const { rows } = await client.queryLayer(
            monuments.servicePath,
            monuments.layerId,
            {
              where: `name LIKE '%${esc}%' OR address LIKE '%${esc}%'`,
              outFields: "name,type,number,address,period_time,description",
              returnGeometry: false,
            },
            limit,
          );
          out.monuments = rows.map((r) => ({
            name: clean(r.attributes["name"]),
            category: clean(r.attributes["type"]),
            state_index: clean(r.attributes["number"]),
            address: clean(r.attributes["address"]),
            period: clean(r.attributes["period_time"]),
            description: clean(r.attributes["description"]),
          }));
        }
        return jsonResult(out);
      }),
  );
}
