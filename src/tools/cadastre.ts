import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ArcGisClient } from "../arcgis.js";
import { findLayer, resolveDistrict, DISTRICTS } from "../catalog/layers.js";
import { clean, num, round, epochToYerevan } from "../format.js";
import { guard, jsonResult, errorResult, type ToolResult } from "../mcp-util.js";

export function registerCadastreTools(server: McpServer, client: ArcGisClient): void {
  const parcelsByCode = findLayer("parcels_by_code")!;
  const parcels = findLayer("parcels")!;
  const buildings = findLayer("buildings")!;
  const masterplan = findLayer("masterplan")!;
  const constructions = findLayer("constructions")!;

  server.registerTool(
    "lookup_parcel",
    {
      description:
        "Look up cadastral parcel(s). Provide a full or partial cadastral code (e.g. '01-001-0023-0171' for one parcel, or '01-006-' for a whole block/district prefix), OR a lon/lat to find the parcel at that point. Returns the cadastral code, region/district, subtype and area (m²).",
      inputSchema: {
        code: z.string().optional().describe("Full or prefix cadastral code, e.g. '01-006-0012-0034' or '01-006'"),
        lon: z.number().optional().describe("Longitude (WGS84) for point lookup"),
        lat: z.number().optional().describe("Latitude (WGS84) for point lookup"),
        limit: z.number().int().min(1).max(1000).default(50),
      },
    },
    async ({ code, lon, lat, limit }): Promise<ToolResult> =>
      guard(async () => {
        if (!code && (lon == null || lat == null)) {
          return errorResult("Provide either a cadastral code, or both lon and lat.");
        }
        const opts: Parameters<ArcGisClient["queryLayer"]>[2] = {
          outFields: "code,rgn_cc,subtype,SHAPE__Area",
          outSR: 4326,
          returnGeometry: false,
        };
        if (code) {
          const c = code.replace(/'/g, "''");
          opts.where = code.length >= 18 ? `code='${c}'` : `code LIKE '${c}%'`;
        } else {
          opts.where = "1=1";
          opts.geometry = `${lon},${lat}`;
          opts.geometryType = "esriGeometryPoint";
          opts.inSR = 4326;
          opts.spatialRel = "esriSpatialRelIntersects";
        }
        const { rows, truncated } = await client.queryLayer(
          parcelsByCode.servicePath,
          parcelsByCode.layerId,
          opts,
          limit,
        );
        const out = rows.map((r) => {
          const a = r.attributes;
          const codeStr = clean(a["code"]);
          const districtCode = codeStr?.slice(0, 6) ?? null;
          return {
            cadastral_code: codeStr,
            district: districtCode ? DISTRICTS[districtCode] ?? null : null,
            district_code: districtCode,
            subtype: clean(a["subtype"]),
            area_sqm: round(num(a["SHAPE__Area"])),
          };
        });
        return jsonResult({ matched: rows.length, truncated, parcels: out });
      }),
  );

  server.registerTool(
    "get_zoning_at_point",
    {
      description:
        "What is the land-use / zoning designation at a location? Point-in-polygon against the city master plan. Returns the land category (target purpose) and functional use. Also useful to answer 'is this area residential / industrial / green / protected'.",
      inputSchema: {
        lon: z.number().describe("Longitude (WGS84)"),
        lat: z.number().describe("Latitude (WGS84)"),
      },
    },
    async ({ lon, lat }): Promise<ToolResult> =>
      guard(async () => {
        const { rows } = await client.queryLayer(
          masterplan.servicePath,
          masterplan.layerId,
          {
            where: "1=1",
            outFields: "target_purpose_type,designated_use_type,use_type,name",
            geometry: `${lon},${lat}`,
            geometryType: "esriGeometryPoint",
            inSR: 4326,
            outSR: 4326,
            spatialRel: "esriSpatialRelIntersects",
            returnGeometry: false,
          },
          10,
        );
        const zones = rows.map((r) => ({
          land_category: clean(r.attributes["target_purpose_type"]),
          functional_use: clean(r.attributes["designated_use_type"]),
          use_type: clean(r.attributes["use_type"]),
          name: clean(r.attributes["name"]),
        }));
        return jsonResult({
          query: { lon, lat },
          zones,
          note: zones.length === 0 ? "No master-plan polygon covers this point." : undefined,
        });
      }),
  );

  server.registerTool(
    "list_construction_projects",
    {
      description:
        "List construction sites / permits, optionally filtered by district and status. Returns address, developer, description, permit expiry, area and coordinates. Status values: 'Ընթացքում գտնվող' (in progress), 'Չսկսված' (not started).",
      inputSchema: {
        district: z.string().optional().describe("District name/code, e.g. 'Kentron', 'Կենտրոն' or '01-006'"),
        status: z.string().optional().describe("Exact status value, or 'in_progress'/'not_started'"),
        limit: z.number().int().min(1).max(1000).default(50),
      },
    },
    async ({ district, status, limit }): Promise<ToolResult> =>
      guard(async () => {
        const clauses: string[] = [];
        if (district) {
          const d = resolveDistrict(district);
          const name = d?.name ?? district;
          clauses.push(`area_name='${name.replace(/'/g, "''")}'`);
        }
        if (status) {
          let s = status;
          if (status === "in_progress") s = "Ընթացքում գտնվող";
          else if (status === "not_started") s = "Չսկսված";
          clauses.push(`status='${s.replace(/'/g, "''")}'`);
        }
        const where = clauses.length ? clauses.join(" AND ") : "1=1";
        const { rows, truncated } = await client.queryLayer(
          constructions.servicePath,
          constructions.layerId,
          { where, outFields: "*", outSR: 4326, returnGeometry: false },
          limit,
        );
        const out = rows.map((r) => {
          const a = r.attributes;
          return {
            district: clean(a["area_name"]),
            address: clean(a["address"]),
            developer: clean(a["developer_owner"]),
            description: clean(a["description"]),
            status: clean(a["status"]),
            area_sqm: round(num(a["construction_area_msq"])),
            permit_expiry: clean(a["expiration_of_permit"]),
            lon: num(a["x"]),
            lat: num(a["y"]),
          };
        });
        return jsonResult({ where, matched: rows.length, truncated, projects: out });
      }),
  );

  server.registerTool(
    "get_district_profile",
    {
      description:
        "A quick statistical profile of one administrative district: parcel count, building count and active construction projects. Uses the cadastral code prefix for the district (01-001 … 01-012).",
      inputSchema: {
        district: z.string().describe("District name/code, e.g. 'Erebuni', 'Էրեբունի' or '01-005'"),
      },
    },
    async ({ district }): Promise<ToolResult> =>
      guard(async () => {
        const d = resolveDistrict(district);
        if (!d) {
          return errorResult(
            `Unknown district "${district}". Valid: ${Object.entries(DISTRICTS)
              .map(([c, n]) => `${n} (${c})`)
              .join(", ")}.`,
          );
        }
        const cmm = d.code.split("-")[1]!; // e.g. "005"
        const [parcelCount, buildingCount, constrCount] = await Promise.all([
          client.count(parcels.servicePath, parcels.layerId, { where: `rgn_cc='01' AND cmm_cc='${cmm}'` }),
          client.count(buildings.servicePath, buildings.layerId, { where: `rgn_cc='01' AND cmm_cc='${cmm}'` }),
          client.count(constructions.servicePath, constructions.layerId, {
            where: `area_name='${d.name.replace(/'/g, "''")}'`,
          }),
        ]);
        return jsonResult({
          district: d.name,
          district_code: d.code,
          parcels: parcelCount,
          buildings: buildingCount,
          construction_projects: constrCount,
        });
      }),
  );
}
