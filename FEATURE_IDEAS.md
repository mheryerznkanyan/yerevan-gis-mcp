# Feature ideas on top of yerevan-gis-mcp

What this MCP unlocks, roughly ordered by effort. Each idea notes the layers/tools it leans on. The portal is anonymous and read-only, so all of this is buildable without any permission from the municipality — though the higher-value civic ones would be worth building *with* them.

## Tier 1 — thin agent skills (hours, no new code)

These are just good prompts / agent workflows over the existing 21 tools.

1. **"Air quality right now" assistant.** Ask by neighbourhood or by dropped pin → nearest station reading + category + a plain-language health note ("Moderate — fine for most, sensitive groups take it easy"). `get_air_quality`, `get_air_quality_forecast`.
2. **Should-I-buy-this-flat check.** Paste an address or coordinates → zoning at the point, the parcel code, nearby construction sites (is a tower going up next door?), nearest metro/bus, and current air quality. `get_zoning_at_point` + `lookup_parcel` + `find_nearby_amenities` + `list_construction_projects` + `get_air_quality`.
3. **District fact sheet.** One district → parcels, buildings, active construction, kindergartens, green space, air-sensor coverage. `get_district_profile` + a few `count_features`/`find_nearby_amenities`.
4. **Renamed-street resolver.** "What is Կիրովի street called now?" → the toponym register carries `previous_names`. `search_street`.
5. **What powers this map?** Point the agent at any public city dashboard → the feature services behind it, so you can query the raw data. `list_public_apps` → `get_web_map_layers`.

## Tier 2 — small products (days)

6. **Air-quality history + trends dashboard.** The hourly table goes back years (`records_v2_4` live + `Records_hourly` archive ≈ 890k rows). Build weekly/seasonal PM2.5 charts per station, "cleanest hour of the day", weekday-vs-weekend, station rankings. Data is already there; just needs `get_station_history` + charting.
7. **AQI alerting / daily brief.** A scheduled task that each morning pulls `get_air_quality` + `get_air_quality_forecast` and pushes "Yerevan air today: Moderate, worst around Shengavit, improving tomorrow." Natural fit for a Claude scheduled task.
8. **Construction-permit watch.** Watch `Construction_public_view` for new/expiring permits in a chosen district or near a coordinate; diff on a schedule and notify. `list_construction_projects` + `count_features`.
9. **Parcel explorer.** Type a cadastral code (or click a point) → parcel geometry, area, zoning, any lease on it (`Վարձակալություններ`), buildings on it, and construction activity. Ties the cadastre + masterplan + lease + construction layers together.
10. **"15-minute city" score for an address.** Count amenities reachable within N metres — bus/metro, kindergartens, parks, medical, culture — and produce a walkability score. `find_nearby_amenities` across kinds + `query_near_point` on green layers.

## Tier 3 — richer builds (a week+)

11. **Interactive city map UI.** A Leaflet/MapLibre front end where the agent answers a question and the answer is *drawn* — the parcel highlighted, the sensors coloured by AQI, the construction sites pinned. All layers can return GeoJSON in WGS84; the MCP already reprojects. Would want to add a `query_layer` mode that returns raw GeoJSON for the browser.
12. **Air-quality + health/routing overlay.** Combine the live sensor field into a continuous AQI surface (IDW interpolation over the 222 points) and suggest the least-polluted walking route between two points. Interpolation is client-side; the portal also has a tokened routing service if it were opened.
13. **Green-space equity analysis.** Per district: green area per capita (green layers give area; census gives population), tree counts (`Նոր_կանաչ_տարածք_view.trees`), and gaps where density is high but green is low. A civic-analytics report.
14. **Change detection over time.** Snapshot parcel/building/construction counts on a schedule and surface where the city is densifying — new buildings appearing, land-use changing. Uses `aggregate` grouped by district over repeated runs.
15. **Bilingual civic Q&A bot for residents.** Public-facing "ask Yerevan" — "when's my bin collected / where's the nearest kindergarten / what's being built on my street" — grounded entirely in city open data via this MCP. The waste-bin layer even carries operator hours, phone and email.

## Tier 4 — needs cooperation or extra data

16. **House-number geocoding.** The biggest gap: no address-range layer is exposed, so "44 Abovyan St" can't be pinned precisely today (only street-level via `search_street`, or POI addresses). Worth asking the municipality to open the geocoder, or building an address index from the parcel/lease address fields.
17. **Digital-twin / 3D viewer.** The portal has SceneServers (`Երևան_3D_OSM`, investment-project 3D). A 3D web scene of proposed vs existing buildings for planning consultations.
18. **Public-participation planning tool.** Show the master plan + a proposed change and collect resident feedback by parcel. (Would need a write backend of your own — not the portal's.)

## Data-quality / civic contributions

- **Flag the empty metric families** (O3, black carbon, wind, pressure, ambient temp/humidity are schema-only) so consumers don't trust them.
- **Contribute an English/transliteration layer** for street and district names — everything is Armenian-only today, which limits tourist- and expat-facing uses.

---

*All ideas rest on the same open ArcGIS REST API; nothing here requires credentials. The interesting product question is less "can we get the data" (we can) and more "which of these does Yerevan actually want" — several of these would be strongest built with the municipality rather than merely on top of them.*
