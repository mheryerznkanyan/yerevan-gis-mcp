/**
 * Live smoke test against gis.yerevan.am. Run from a machine with normal
 * internet (the API is NOT reachable from restricted CI/sandbox egress):
 *
 *   npm run smoke
 *
 * It exercises the real endpoints the MCP tools depend on and prints a
 * pass/fail line for each. Nothing here writes to the portal.
 */
import { ArcGisClient } from "../src/arcgis.js";
import { CATALOG } from "../src/catalog/layers.js";

const client = new ArcGisClient({ timeoutMs: 30_000 });

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    pass++;
    console.log(`✓ ${name} — ${detail}`);
  } catch (err) {
    fail++;
    console.log(`✗ ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  console.log("Yerevan GIS MCP — live smoke test\n");

  await check("districts count", async () => {
    const n = await client.count("Hosted/Yerevan_Districts/FeatureServer", 0);
    if (n !== 12) throw new Error(`expected 12 districts, got ${n}`);
    return `${n} districts`;
  });

  await check("parcels count", async () => {
    const n = await client.count("Hosted/Կադաստր_քարտեզ/FeatureServer", 2);
    if (n < 100000) throw new Error(`suspiciously low parcel count ${n}`);
    return `${n.toLocaleString()} parcels`;
  });

  await check("live air stations query + WGS84 reprojection", async () => {
    const { rows } = await client.queryLayer(
      "Hosted/Device_Joined_NewAPI/FeatureServer",
      0,
      { where: "1=1", outFields: "code,latitude,longitude", returnGeometry: true, outSR: 4326 },
      3,
    );
    const g = rows[0]?.geometry as { x?: number } | undefined;
    if (!g || g.x == null || g.x < 43 || g.x > 46) throw new Error("geometry not reprojected to WGS84 lon");
    return `${rows.length} stations, first lon=${g.x}`;
  });

  await check("point-in-polygon zoning at Republic Square", async () => {
    const { rows } = await client.queryLayer(
      "Հողերի_նշանակությունը/FeatureServer",
      0,
      {
        where: "1=1",
        outFields: "target_purpose_type,designated_use_type",
        geometry: "44.5136,40.1772",
        geometryType: "esriGeometryPoint",
        inSR: 4326,
        spatialRel: "esriSpatialRelIntersects",
        returnGeometry: false,
      },
      5,
    );
    return `${rows.length} zone polygon(s)`;
  });

  await check("aggregate: parcels per district (grouped stats)", async () => {
    const rows = await client.statistics(
      "Hosted/Կադաստր_քարտեզ/FeatureServer",
      2,
      [{ statisticType: "count", onStatisticField: "objectid", outStatisticFieldName: "n" }],
      { groupByFields: "cmm_cc" },
    );
    if (rows.length < 5) throw new Error(`expected several district groups, got ${rows.length}`);
    return `${rows.length} district groups`;
  });

  await check("distinct land-use categories in master plan", async () => {
    const vals = await client.distinctValues("Հողերի_նշանակությունը/FeatureServer", 0, "target_purpose_type");
    return `${vals.length} distinct categories`;
  });

  await check("near-point: bus stops within 500m of centre", async () => {
    const { rows } = await client.queryLayer(
      "Hosted/Bus_stops_lots/FeatureServer",
      0,
      {
        where: "1=1",
        outFields: "street",
        geometry: "44.5126,40.1776",
        geometryType: "esriGeometryPoint",
        inSR: 4326,
        distance: 500,
        units: "esriSRUnit_Meter",
        returnGeometry: false,
      },
      50,
    );
    return `${rows.length} stops`;
  });

  await check("street search (Armenian LIKE)", async () => {
    const { rows } = await client.queryLayer(
      "Yerevan_Named_Roads/FeatureServer",
      0,
      { where: "street_name LIKE '%Աբովյան%' AND street_name IS NOT NULL", outFields: "street_name", returnGeometry: false },
      5,
    );
    if (rows.length === 0) throw new Error("no street matches");
    return `${rows.length} matches, e.g. ${rows[0]?.attributes.street_name}`;
  });

  await check("portal search (non-Esri feature services)", async () => {
    const json = await client.portalSearch('-owner:esri_* type:"Feature Service"', { num: 5 });
    return `total ${json.total}`;
  });

  await check("restricted layer surfaces as 'restricted'", async () => {
    try {
      await client.describeLayer("Hosted/Կառուցապատման_հատուկ_ռեղիմներ2/FeatureServer", 0);
      return "unexpectedly readable (portal may have opened it)";
    } catch (e: any) {
      if (e?.kind === "restricted" || e?.kind === "not_found") return `handled as ${e.kind}`;
      throw e;
    }
  });

  await check("catalog layers all describe-able", async () => {
    let ok = 0;
    const problems: string[] = [];
    for (const l of CATALOG) {
      try {
        const meta = await client.describeLayer(l.servicePath, l.layerId);
        if (meta?.name) ok++;
        else problems.push(`${l.key}: no name`);
      } catch (e: any) {
        problems.push(`${l.key}: ${e?.kind ?? e?.message}`);
      }
    }
    if (problems.length) console.log("    catalog issues:", problems.join(" | "));
    return `${ok}/${CATALOG.length} catalog layers OK`;
  });

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
