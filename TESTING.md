# Testing report — yerevan-gis-mcp

Verified end-to-end on **2026-08-28** (macOS 15, Node v22.18.0, npm 10.9.3) against the
live portal at `gis.yerevan.am`. Everything below was actually executed, not inferred.

## How to run it

```sh
npm install     # 142 packages, ~8s; the `prepare` script builds dist/ automatically
npm run build   # tsc → dist/     (clean, no errors) — only needed after edits
npm run typecheck
npm test        # vitest, offline — 23 tests in 3 files, all pass, ~0.3s
npm run smoke   # LIVE — hits gis.yerevan.am, needs normal internet egress
```

`npm run dev` runs the TypeScript directly via tsx (no build step).

Register with an MCP client:

```sh
claude mcp add yerevan-gis -- node /absolute/path/to/yerevan-gis-mcp/dist/index.js
```

The server speaks **stdio** only. `dist/index.js` has a shebang and connects a
`StdioServerTransport` immediately — launching it in a terminal looks like it hangs; that
is correct, it is waiting for JSON-RPC on stdin.

### Driving it by hand

The fastest way to exercise tools without an MCP client is a throwaway script using the
SDK client that is already a dependency. Run it **from the project root** so Node resolves
`@modelcontextprotocol/sdk` from `node_modules`:

```js
// probe.mjs — node probe.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const c = new Client({ name: "probe", version: "1" }, { capabilities: {} });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

console.log((await c.listTools()).tools.map(t => t.name));
const r = await c.callTool({ name: "get_air_quality", arguments: { lon: 44.5136, lat: 40.1776 } });
console.log(r.content[0].text);
await c.close();
```

## Results

### Build & unit tests

| Step | Result |
|---|---|
| `npm install` | clean (npm reports 5 audit advisories in the dev tree — vitest/tsx transitives, not shipped) |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm test` | **23/23 pass** (`format` 9, `arcgis` 8, `catalog` 6) |

### Live smoke test — `npm run smoke`

**11 passed, 0 failed.** Real numbers returned on the day of the run:

- 12 districts, **181,341** parcels
- 3 live air stations reprojected to WGS84 (`lon=44.4777…` — the custom projection round-trip works)
- point-in-polygon zoning at Republic Square → 1 polygon
- grouped aggregation → 12 district groups; 7 distinct master-plan land-use categories
- 2 bus stops within 500 m of centre; Armenian street LIKE search → 5 hits (`Խ. Աբովյան փողոց`)
- portal search → 197 items; restricted layer handled; **34/34 catalogued layers describe-able**

### MCP protocol surface

`tools/list` returns **24 tools**, all with usable schemas:

```
search_layers  describe_layer  list_service_layers  query_layer  count_features
get_distinct_values  query_near_point  aggregate  get_map_image
get_air_quality  get_air_quality_forecast  get_station_history
lookup_parcel  get_zoning_at_point  list_construction_projects  get_district_profile
find_nearby_amenities  search_street  list_public_apps  search_portal_items
get_web_map_layers
list_investment_projects  get_kindergarten_finance  search_heritage
```

Every one was called against live data. (The last three were added to the repo on 2026-08-30, after the
main pass; each was smoke-checked individually — 16 investment projects, 8 years of kindergarten
financing, and a heritage keyword search returning a 17th-century church — but they are not yet
covered by `npm run smoke`.) Latency: catalog-only tools (`search_layers`,
`list_public_apps`) answer in **1–4 ms**; single-query tools land at **330–700 ms**;
multi-query tools are the slow ones — `get_air_quality` **1.8–2.6 s**, `get_district_profile`
**1.4 s** (three counts). Nothing timed out.

Spot-check outputs that confirm the hard parts work:

- `get_air_quality(44.5136, 40.1776)` → nearest station `A6NMRVXL`, 302 m away, AQI 58
  "Moderate", timestamp rendered `2026-08-28 19:00:00 (UTC+4)` — epoch-ms → local
  conversion is correct, and `"11.34"`-as-string parses to a number.
- `get_air_quality()` with no point → city overview, **222/222 stations reporting**, avg AQI 53.44.
- `lookup_parcel(lon, lat)` → `01-006-0203-0002`, Կենտրոն, 4582.85 m².
- `get_district_profile("Erebuni")` → Էրեբունի / `01-005` / 32,261 parcels / 47,178 buildings /
  807 construction projects. **English district names are accepted and mapped to Armenian.**
- `describe_layer("parcels")` → resolves to layer **2** of `Կադաստր_քարտեզ`, `capabilities: "Query"`,
  `max_record_count: 2000` — the non-zero layer id story in the README is real and handled.
- `query_layer("parcels", limit: 2500)` → returned exactly 2500 rows across pages.
  **Auto-pagination past the 2000-row `maxRecordCount` works.**
- `list_service_layers` on the cadastre service → Block=1, Parcel=2, Building=3.
- `get_station_history("A6NMRVXL", hours: 6)` → 6 hourly points.

Error paths are handled cleanly, not thrown:

| Input | Response |
|---|---|
| unknown `layer_key` | `Unknown layer_key "…". Use search_layers…` |
| bad `where` field | `Field name 'THIS_IS_NOT_A_FIELD' does not exist.` |
| wrong-case field (`OBJECTID`) | `Field name 'OBJECTID' does not exist. Did you mean 'objectid'?` |
| nonexistent service | `Not found: Service not found.` + the "layers aren't 0" hint |
| bad argument types | rejected by zod at the protocol layer (`-32602`) before any HTTP call |

## Sharp edges found

Things a caller will trip over. None are fatal; two are worth fixing.

1. **`search_layers` returns the whole catalog when nothing matches.** `query: "zzzznothing"`
   returns `count: 34` — every catalogued layer — because
   [src/tools/generic.ts:71](src/tools/generic.ts#L71) falls back to the unfiltered list on
   zero hits. The fallback is deliberate, but the response carries no signal that the query
   matched nothing, so an agent reads 34 irrelevant layers as 34 matches. Worth adding a
   `matched: false` / `note` field.

2. **`get_map_image` is nearly dead in practice.** The tool works — it rendered a real 200-OK
   PNG from `Hosted/Ներդրումային_ծրագրեր/MapServer`, and auto-appends the `/MapServer`
   suffix — but the portal publishes only **2 MapServers out of 196 services**
   (191 FeatureServer, 2 MapServer, 3 SceneServer), and neither is a city basemap. There is
   no MapServer for the cadastre, districts, or air data, so there is nothing general to
   render. Pointing it at a FeatureServer yields ArcGIS's own unhelpful `Invalid URL`.
   It also returns a **URL, not an image content block** — the client has to fetch the PNG itself.

3. **Field names are lowercase; aliases are uppercase.** `describe_layer` prints
   `objectid «OBJECTID»`. SQL `where`/`field` arguments must use the left-hand (lowercase)
   name. ArcGIS's "Did you mean" hint makes this recoverable, at the cost of a round trip.

4. **`aggregate(group_by: "rgn_cc")` returns a single group.** Not a bug — `rgn_cc` is the
   *region* code and all of Yerevan is `01`. Group parcels by `cmm_cc` (community) instead.

5. **Enum values are exact.** `find_nearby_amenities` takes `metro_station`, not `metro`
   (`bus_stop | metro_station | air_sensor | waste_bin | kindergarten | hotel | construction |
   elevator`). `get_map_image`'s `bbox` is a **comma-separated string**, not an array.
   The README's shorthand `find_nearby_amenities("bus_stop", lon, lat)` is positional prose —
   the real parameter is `kind`.

6. **`get_web_map_layers` returns nothing for Web Experience items.** On the flagship air
   dashboard (`d6435f44ea92460682d12c2317612b29`) both layer lists are empty. The tool detects
   this and says so — Experiences/Dashboards aren't Web Maps — but the README example
   "`list_public_apps` → `get_web_map_layers`" won't work for most of the 14 listed apps.

7. **Duplicate timestamps in `get_station_history`.** Two consecutive `18:00:00` rows came back
   in a 6-point series. Upstream duplication in the readings table; the tool passes it through.

8. **Stale data varies by station.** One station reported `2026-08-01` next to another at
   `2026-08-28`. The portal's own data, but callers should read `measured_at` rather than
   assume "current".

## Security note — status changed since the README was written

Re-checked live:

- `Hosted/Predicted_AQI` — **still advertises `Query,Create,Update,Delete,Editing,Uploads`
  anonymously.** The exposure the README describes is current.
- `Hosted/Հողամաս_search` — **now returns HTTP 499 "Token Required"** and no longer appears in
  the public service list. The ~185k-parcel write exposure named in the README appears to have
  been closed, or the service was renamed. The parcel services now public
  (`Կադաստրային_հողամաս`, `Հողամասի_սահմաններ__Parcel`) are both `capabilities: Query` — read-only.

Still **unconfirmed** whether `Predicted_AQI` actually accepts an anonymous write; proving it
would mean writing to live municipal data, which was not done. The server never calls
`applyEdits`. Update the README's security note to reflect the `Հողամաս_search` change.
