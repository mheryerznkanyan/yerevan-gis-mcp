<!-- Header block for project -->
<hr>

<div align="center">

<h1 align="center">yerevan-gis-mcp</h1>

</div>

<pre align="center">An MCP server that lets an AI agent query Yerevan's live municipal GIS data — air quality, parcels, zoning, construction, transport — with no API key.</pre>

<!-- Header block for project -->

[![Test](https://github.com/mheryerznkanyan/yerevan-gis-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/mheryerznkanyan/yerevan-gis-mcp/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-orange)](https://modelcontextprotocol.io)
[![SLIM](https://img.shields.io/badge/Best%20Practices%20from-SLIM-blue)](https://nasa-ammos.github.io/slim/)

This project wraps the **Yerevan Municipality GIS portal** ([gis.yerevan.am](https://gis.yerevan.am/portal/home/index.html)) — an ArcGIS Enterprise 11.5 deployment with ~190 hosted layers and 300+ portal items — in a Model Context Protocol server, so a language model can answer real questions about the city from live data instead of guessing.

It exists because the portal is genuinely open: every layer this server touches is served **anonymously, with no token, no account and no rate limit**. That openness is buried behind an ArcGIS REST API with a bespoke unnamed projection, Armenian free-text categories, non-zero layer ids and numbers-encoded-as-strings. This server absorbs all of that so the model sees clean JSON, WGS84 coordinates and local timestamps.

It is intended for anyone building an AI assistant that needs to reason about Yerevan — urbanists, journalists, civic-tech developers, or a resident asking whether it is safe to go running today. Everything is **read-only**; the server never calls `applyEdits`.

[Yerevan GIS portal](https://gis.yerevan.am/portal/home/index.html) | [Testing report](TESTING.md) | [API notes](API_NOTES.md) | [Feature ideas](FEATURE_IDEAS.md) | [Issue tracker](https://github.com/mheryerznkanyan/yerevan-gis-mcp/issues)

![Demo](demo.gif)

## Features

* **27 tools** over live city data — 26 over the municipal portal / OpenStreetMap (verified end-to-end, see [TESTING.md](TESTING.md)), plus one optional live-transit scrape
* **Live vehicle positions** *(optional)* — real-time bus/trolleybus/minibus locations scraped from Yandex Maps via a headless browser; powerful but fragile and subject to Yandex's terms of use (see the note below)
* **No credentials of any kind** — no API key, token, account or config file; clone and run
* **Live air quality** from 222 sensors, plus a 7-day AQI forecast and hourly per-station history
* **181,341 cadastral parcels** and 12 districts, queryable by cadastral code or by lon/lat
* **Point-in-polygon lookups** — "what parcel / zone / district is at this coordinate?"
* **A generic ArcGIS toolbox** that reaches *any* of the portal's ~190 layers, not just the curated ones
* **The sharp edges handled for you** — WGS84 reprojection from an unnamed source projection, auto-pagination past the 2,000-row server cap, epoch-ms → UTC+4 timestamps, string-encoded numbers, Armenian field aliases
* **English district names accepted** and mapped to their Armenian equivalents
* **Sub-second responses** for most tools (1–4 ms for catalog lookups, 330–700 ms for single queries)

## Contents

* [Quick Start](#quick-start)
* [Tools](#tools)
* [Notes on the Data](#notes-on-the-data)
* [Changelog](#changelog)
* [FAQ](#frequently-asked-questions-faq)
* [Contributing](#contributing)
* [License](#license)
* [Support](#support)

## Quick Start

### Requirements

1. **Node.js 18 or newer** (developed and tested on Node 22)
2. **npm** (ships with Node)
3. **Ordinary internet access** to `gis.yerevan.am` — restricted CI or sandbox networks will block the live queries
4. **An MCP client** — Claude Code, Claude Desktop, Cursor, Zed, or anything else that speaks MCP over stdio
5. *(Optional, only for `get_live_transit`)* the `playwright` package and its Chromium — `npm i playwright && npx playwright install chromium`. Every other tool works without it; the tool returns a clear install hint if it's missing.

No API key, token or account is required.

### Setup Instructions

1. Clone the repository and enter it:

   ```bash
   git clone https://github.com/mheryerznkanyan/yerevan-gis-mcp.git
   cd yerevan-gis-mcp
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

   This also compiles TypeScript to `dist/` automatically via the `prepare` script, so there is no separate build step. Expect ~142 packages in about 10 seconds.

3. Confirm `dist/index.js` now exists:

   ```bash
   ls dist/index.js
   ```

### Run Instructions

1. Register the server with your MCP client. For Claude Code, from the repo root:

   ```bash
   claude mcp add yerevan-gis -- node "$PWD/dist/index.js"
   ```

   For a client that uses a JSON config file (Claude Desktop, Cursor, Zed), add — **the path must be absolute**:

   ```json
   {
     "mcpServers": {
       "yerevan-gis": {
         "command": "node",
         "args": ["/absolute/path/to/yerevan-gis-mcp/dist/index.js"]
       }
     }
   }
   ```

2. **Restart your MCP client.** Servers are loaded at startup, so a newly registered server will not appear in a session that is already running.

3. Confirm it connected — in Claude Code, `/mcp` should list `yerevan-gis` with 24 tools. Then ask it something: *"What's the air quality near Republic Square?"*

> **Note:** running `node dist/index.js` directly in a terminal will look like it hangs. That is correct behaviour — the server speaks JSON-RPC over stdio and is waiting for input from a client.

### Usage Examples

Ask your assistant questions in plain language; it picks the tool.

**Air quality** — the freshest data on the portal, updated hourly:

* *"What's the air quality near Republic Square right now?"* → nearest station, distance, AQI, PM2.5/PM10/NO₂
* *"How's Yerevan's air overall?"* → city average across all reporting stations, plus the worst offenders
* *"Is it getting worse this week?"* → 7-day predicted AQI
* *"Show me the last 24 hours at that sensor."* → hourly time series

**Cadastre, zoning and construction:**

* *"What parcel and zoning is at 40.1776, 44.5136?"* → cadastral code, district, area in m², land-use designation
* *"How many buildings are in Erebuni?"* → parcel / building / construction counts for the district
* *"List active construction sites in Kentron."* → address, developer, permit expiry, coordinates

**Places, transport and addressing:**

* *"Where are the nearest bus stops / metro stations / kindergartens?"*
* *"Which streets contain Բաղրամյան?"*
* *"What public dashboards does the municipality publish?"*

**Anything not curated** — the generic toolbox reaches all ~190 layers:

* *"What datasets exist about forests?"* → `search_layers`, then query whatever it returns
* *"Count parcels grouped by community."* → server-side aggregation

Two things it deliberately cannot do: **resolve a street address to coordinates** (the portal's geocoder requires a token, so you supply lon/lat or an Armenian street name), and **routing or travel time** (not in the data).

### Build Instructions

`npm install` already builds the project. After editing source, rebuild with:

```bash
npm run build      # tsc → dist/
npm run typecheck  # type-check without emitting
```

For iterating without a build step, run the TypeScript directly:

```bash
npm run dev        # tsx src/index.ts
```

### Test Instructions

1. **Unit tests** — fully offline, against faked HTTP responses:

   ```bash
   npm test
   ```

   Expected: `Test Files 3 passed (3)`, `Tests 23 passed (23)`, in well under a second.

2. **Live smoke test** — hits the real portal, needs normal internet egress:

   ```bash
   npm run smoke
   ```

   Expected: `11 passed, 0 failed.` It checks district and parcel counts, WGS84 reprojection, point-in-polygon zoning, grouped aggregation, distinct values, near-point search, Armenian street search, portal search, restricted-layer handling, and that all 34 catalogued layers are describe-able.

Both run automatically on every pull request via GitHub Actions (Node 20 and 22); the live smoke test runs
weekly instead, so an upstream portal outage never blocks a PR.

See [TESTING.md](TESTING.md) for the full testing architecture — each category, how to run it, and a dated
verification report with measured latencies and known rough edges.

## Tools

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
| `get_station_history` | Hourly PM/NO₂/AQI history for one sensor |
| `lookup_parcel` | Parcel by cadastral code (full/prefix) or by point |
| `get_zoning_at_point` | Land-use / zoning designation at a location |
| `list_construction_projects` | Construction sites/permits by district & status |
| `get_district_profile` | Parcel / building / construction counts for a district |
| `find_nearby_amenities` | Nearest bus stops, metro, sensors, bins, kindergartens, hotels… |
| `search_street` | Street search by Armenian name (stand-in geocoder) |
| `find_bus_routes` | Bus/trolleybus routes by number, name, or near a point |
| `get_bus_route` | One route's stops in travel order, with coordinates |
| `get_live_transit` | **Live** vehicle positions (bus/trolleybus/minibus), optionally by line — *scraped from Yandex Maps, optional, fragile; see note* |
| `list_public_apps` | The municipality's public dashboards & web apps |
| `search_portal_items` | Search the portal item catalog (non-Esri) |
| `list_investment_projects` | Municipal investment/development projects |
| `get_kindergarten_finance` | Kindergarten financing by year (AMD) |
| `search_heritage` | Monuments and memorial plaques by Armenian keyword |
| `get_web_map_layers` | Reveal the service URLs behind a public web map/app |

## Notes on the Data

The client and catalog already handle these; they are documented because they explain the design and will bite you if you query the portal directly.

* **Custom projection.** Source geometry uses a bespoke Armenia projection with *no wkid*. The client always sends `inSR=4326` and requests `outSR=4326`, so you get normal lon/lat.
* **Layer ids aren't 0.** Forests = 21, groundwater = 16, monuments = 70/71, named areas = 138; parcels are layer 2 of `Կադաստր_քարտեզ` (buildings = 3). The catalog encodes these; for uncatalogued services call `list_service_layers` first.
* **Armenian, free text, no coded domains.** Categories are literal Armenian strings, sometimes with trailing `\n` or spaces. Use `get_distinct_values` to find exact spellings before filtering.
* **Field names are lowercase, aliases are uppercase.** `describe_layer` shows `objectid «OBJECTID»`; SQL must use the lowercase name.
* **Numbers as strings.** Several air-quality metrics arrive as `"9.29"`, and *missing* is `""` rather than null — parsed defensively.
* **Epoch-ms dates, UTC.** Rendered in Yerevan local time (UTC+4) by the curated tools.
* **Pagination.** `maxRecordCount` is 1000–2000; `query_layer` auto-pages up to your `limit`.
* **Restricted vs missing.** A locked layer answers HTTP 499 "Token Required", surfaced as *restricted* — distinct from *not found*.
* **Transit routes come from OpenStreetMap, not the portal.** The portal's `Bus_stops_lots` layer has ~384 stops and no routes at all. `find_bus_routes` / `get_bus_route` read a snapshot baked into `src/data/` (1122 stops, 69 routes, ODbL) — no network call, but also not live. Regenerate with `node scripts/fetch-transit.mjs`. `find_nearby_amenities` still reads the portal layer, so its bus-stop answers are the narrower set.
* **Live transit is a Yandex scrape — different in kind, and fragile.** `get_live_transit` is the one tool that does *not* read the municipal portal. There is no public/licensed feed for real-time vehicle positions in Yerevan, so it drives a headless browser to Yandex Maps' transport layer and intercepts the JSON the page fetches (`getVehiclesInfoWithRegion`). Yandex sends no stored position — each vehicle is an animated trajectory of time-stamped segments, so the tool interpolates the current point by wall-clock. Consequences you should know: it needs the optional `playwright` browser; it adds ~2–4 s per call (results are cached ~20 s); Yandex soft-blocks the IP after a burst of rapid calls (you'll get a "rate-limited/changed" error, not a crash); it can break outright whenever Yandex reshapes their site; and automated access is **against Yandex's terms of use** — use it accordingly. Everything else in this server is licensed open municipal data; this one is not.
* **No geocoder.** The portal's geocode service needs a token; `search_street` queries the named-roads/toponym layers instead (Armenian input only).
* **`get_map_image` has little to render.** The portal publishes only 2 MapServers out of 196 services, and neither is a city basemap.
* **Freshness varies by sensor.** Read each station's `measured_at` rather than assuming every reading is current.

## Changelog

This project has not yet cut a tagged release. See the [commit history](https://github.com/mheryerznkanyan/yerevan-gis-mcp/commits/main) for changes, and the [releases page](https://github.com/mheryerznkanyan/yerevan-gis-mcp/releases) once versions are published.

## Frequently Asked Questions (FAQ)

1. **Do I need an API key or a gis.yerevan.am account?**
   - No. Every layer this server reads is served anonymously. There is nothing to configure.

2. **Can I ask it about a street address, like "40 Mashtots Avenue"?**
   - Not directly. The portal's geocoding service requires a token, so this server has no address→coordinate lookup. Supply a lon/lat, or search by Armenian street name with `search_street`.

3. **The server seems to hang when I run it — is it broken?**
   - No. MCP servers communicate over stdin/stdout. Silence means it is waiting for a client. Launch it through your MCP client rather than by hand.

4. **I registered it but my assistant doesn't see the tools.**
   - Restart the client. MCP servers are loaded at startup, so a server added mid-session will not appear until you restart. Also check that the path in your config is absolute.

5. **Can it modify city data?**
   - No. The server is read-only and never calls `applyEdits`; it only ever issues queries.

6. **Is the data live?**
   - Air quality is, updated hourly. Cadastral, zoning and construction layers are current-state snapshots published by the municipality, without a time dimension.

7. **Why are results in Armenian?**
   - Because the source data is. District names accept English input and are mapped for you, but categories, statuses and names come back as the municipality publishes them.

## Contributing

Contributions are welcome — especially additional curated tools, catalog entries for uncatalogued layers, and corrections to the Armenian field documentation.

1. Open a [GitHub issue](https://github.com/mheryerznkanyan/yerevan-gis-mcp/issues) describing the change you want to make.
2. [Fork](https://github.com/mheryerznkanyan/yerevan-gis-mcp/fork) this repository.
3. Make your changes in your fork. Please keep `npm test` and `npm run typecheck` green, and add a unit test for new parsing or formatting logic.
4. If you add or change a tool that hits the portal, extend `scripts/smoke.ts` so it is covered by `npm run smoke`.
5. Open a pull request against `main` and tag the maintainer as reviewer.

**Working on your first pull request?** See [How to Contribute to an Open Source Project on GitHub](https://kcd.im/pull-request).

## License

Released under the MIT License. See [LICENSE](LICENSE).

## Support

Maintained by [@mheryerznkanyan](https://github.com/mheryerznkanyan). For questions, bug reports or dataset requests, please open an issue on the [issue tracker](https://github.com/mheryerznkanyan/yerevan-gis-mcp/issues).
