# yerevan-gis-mcp

An MCP server over the **Yerevan Municipality GIS portal** ([gis.yerevan.am](https://gis.yerevan.am/portal/home/index.html)) — an ArcGIS Enterprise 11.5 deployment whose ~190 hosted layers and 300+ portal items are served **anonymously, with no token**. This lets an AI agent answer questions about the city — air quality, cadastral parcels, zoning, construction, transport, amenities — by querying the live data.

Everything is **read-only**. (See [Security note](#security-note) — the portal itself exposes a few layers with anonymous write; this server never touches them.)

## Two layers of tools

**Generic ArcGIS toolbox** — reach any of the portal's layers, catalogued or not:

| Tool | Purpose |
|---|---|
| `search_layers` | Discover datasets by keyword/domain → returns a `layer_key` |
| `describe_layer` | Fields (with Armenian aliases), geometry, count, capabilities |
| `list_service_layers` | Enumerate layers inside a raw service (ids aren't always 0) |
| `query_layer` | The workhorse: SQL `where`, auto-paginated, WGS84 geometry |
| `count_features` | Count matches without pulling rows |
| `get_distinct_values` | List a field's distinct (Armenian, free-text) values |
| `query_near_point` | Features within a radius of a lon/lat |
| `aggregate` | Server-side count/min/max/avg/sum, optionally grouped |
| `get_map_image` | Render a PNG of a bbox from a MapServer |

**Curated domain tools** — one call answers a common question:

| Tool | Answers |
|---|---|
| `get_air_quality` | Current AQI — nearest station to a point, or a city overview |
| `get_air_quality_forecast` | Predicted city AQI for the coming days |
| `get_station_history` | Hourly PM/NO2/AQI history for one sensor |
| `lookup_parcel` | Parcel by cadastral code (full/prefix) or by point |
| `get_zoning_at_point` | Land-use / zoning designation at a location |
| `list_construction_projects` | Construction sites/permits by district & status |
| `get_district_profile` | Parcel / building / construction counts for a district |
| `find_nearby_amenities` | Nearest bus stops, metro, sensors, bins, kindergartens, hotels… |
| `search_street` | Street search by Armenian name (stand-in geocoder) |
| `list_public_apps` | The municipality's public dashboards & web apps |
| `search_portal_items` | Search the portal item catalog (non-Esri) |
| `get_web_map_layers` | Reveal the service URLs behind a public web map/app |

## Setup

```sh
npm install
npm run build
```

Register with Claude Code / Claude Desktop:

```sh
claude mcp add yerevan-gis -- node /absolute/path/to/yerevan-gis-mcp/dist/index.js
```

Or in an MCP client config:

```json
{
  "mcpServers": {
    "yerevan-gis": { "command": "node", "args": ["/absolute/path/to/yerevan-gis-mcp/dist/index.js"] }
  }
}
```

## Verify against the live API

Unit tests run offline (against faked responses):

```sh
npm test
```

The **live** smoke test hits the real portal and needs normal internet egress (it fails from restricted CI/sandbox networks):

```sh
npm run smoke
```

It checks district/parcel counts, WGS84 reprojection, point-in-polygon zoning, grouped aggregation, distinct values, near-point search, Armenian street search, portal search, restricted-layer handling, and that every catalogued layer is describe-able.

## Example questions it can answer

- "What's the air quality near Republic Square right now?" → `get_air_quality(lon, lat)`
- "Show me the AQI forecast for this week." → `get_air_quality_forecast`
- "What parcel and zoning is at 40.18, 44.51?" → `lookup_parcel` + `get_zoning_at_point`
- "How many buildings are in Erebuni?" → `get_district_profile("Erebuni")`
- "List active construction sites in Kentron." → `list_construction_projects(district, status)`
- "Nearest bus stops to my hotel." → `find_nearby_amenities("bus_stop", lon, lat)`
- "Which streets contain 'Բաղրամյան'?" → `search_street`
- "What data powers the air-pollution dashboard?" → `list_public_apps` → `get_web_map_layers`

## Notes on the data (the sharp edges)

The client and catalog already handle these, but they explain the design:

- **Custom projection.** Source geometry is a bespoke Armenia projection with *no wkid*. The client always sends `inSR=4326` and requests `outSR=4326`, so you get normal lon/lat.
- **Layer ids aren't 0.** Forests = 21, groundwater = 16, monuments = 70/71, named areas = 138, parcels = layer 2 (buildings = 3) of `Կադաստր_քարտեզ`. The catalog encodes these; for uncatalogued services use `list_service_layers` first.
- **Armenian, free text, no coded domains.** Categories are literal Armenian strings (sometimes with trailing `\n`/spaces). Use `get_distinct_values` to find exact spellings before filtering.
- **Numbers as strings.** Several air-quality metrics come back as `"9.29"` and *missing* as `""` not null — parsed defensively.
- **Epoch-ms dates, UTC.** Rendered in Yerevan local (UTC+4) by the curated tools.
- **Pagination.** `maxRecordCount` is 1000–2000; `query_layer` auto-pages up to your `limit`.
- **Restricted vs missing.** A locked layer answers HTTP 499 "Token Required" — surfaced as *restricted*, distinct from *not found*.
- **No geocoder.** The portal's geocode service needs a token; `search_street` queries the named-roads/toponym layers instead (Armenian input only).

## Security note

While profiling the portal we found three layers advertising **anonymous** `Create/Update/Delete` capability: `records_v2_4` (live air readings), `Predicted_AQI`, and `Հողամաս_search` (≈185k parcel records). Anyone on the internet could edit those. This server is strictly read-only and never calls `applyEdits`, but the exposure is worth reporting to the portal operators.

## License

MIT
