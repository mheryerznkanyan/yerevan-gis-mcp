# gis.yerevan.am — API reference notes

Profiled live, Aug 2026. ArcGIS Enterprise **11.5**, portal name "Yerevan Municipality". Anonymous, no token needed for anything below. Base URLs:

- Server: `https://gis.yerevan.am/server/rest/services`
- Portal: `https://gis.yerevan.am/portal/sharing/rest`

Append `?f=json` (or `pjson`). FeatureServer `/query` also supports `f=geojson` and `f=pbf`.

## Scale

- ~190 hosted feature services, 3 folders (`Hosted`, `Routing`, `Utilities`); `Utilities`/`Routing` GP services need a token.
- 181,341 parcels · 284,484 buildings · 30,171 masterplan zones · 294k live air readings (+596k archived) · 7,834 construction sites · 312 non-Esri portal items (197 feature services, 38 web maps, 12 web experiences, 9 storymaps, 4 dashboards).

## Key layers (service path → layer id)

| Domain | Service | Layer | Rows | Notes |
|---|---|---|---|---|
| Air (live) | `Hosted/Device_Joined_NewAPI/FeatureServer` | 0 | 222 | stations ⋈ latest hourly reading |
| Air (hourly) | `Hosted/records_v2_4/FeatureServer` | 0 | 294k | join `sourceid`=`Devices.code`; **anon write!** |
| Air (archive) | `Hosted/Records_hourly/FeatureServer` | 0 | 596k | pre-2025-08 history, same schema |
| Air (daily) | `Hosted/Air_Pollution_2024_2025_Live/FeatureServer` | 0 | 105k | 10-char field names |
| Air (forecast) | `Hosted/Predicted_AQI/FeatureServer` | 0 | 230 | `aqi`,`date_pbl_aqi`; **anon write!** |
| Air (devices) | `Hosted/Devices/FeatureServer` | 0 | 54 | `globalid`=address, not GUID |
| Parcels | `Hosted/Կադաստր_քարտեզ/FeatureServer` | **2** | 181k | components rgn/cmm/blk/prc_cc; layer 1=blocks, 3=buildings |
| Parcels (code) | `Hosted/Կադաստրային_հողամաս/FeatureServer` | 0 | 181k | `code`='01-001-0023-0171'; LIKE prefix works |
| Buildings | `Hosted/Կադաստր_քարտեզ/FeatureServer` | **3** | 284k | |
| Zoning | `Հողերի_նշանակությունը/FeatureServer` | 0 | 30k | root-level; `target_purpose_type`,`designated_use_type` |
| Construction | `Hosted/Construction_public_view/FeatureServer` | 0 | 7,834 | cleanest service; native WGS84; x/y=lon/lat |
| Leases | `Hosted/Վարձակալություններ/FeatureServer` | 0 | 16k | placeholder field names a–h; address=`b` |
| Districts | `Hosted/Yerevan_Districts/FeatureServer` | 0 | 12 | `community_code` 01-001…01-012 |
| Streets | `Yerevan_Named_Roads/FeatureServer` | 0 | 25.7k | root-level; `street_name`, ~7,362 named; geocoder substitute |
| Toponyms | `Cadastral_toponym_lines/FeatureServer` | 0 | 1,531 | official register + `previous_names` |
| Forests | `Hosted/Անտառներ/FeatureServer` | **21** | 62 | |
| Groundwater | `Hosted/Ստորգետնյա_ջրեր/FeatureServer` | **16** | 168 | |
| Monuments | `Hosted/Հուշարձաններ_ԳՀ_2024/FeatureServer` | **70**/**71** | 247/165 | national / local; no layer 0 |
| Named areas | `Yerevan_Named_Areas_Live/FeatureServer` | **138** | — | |
| Bus stops | `Hosted/Bus_stops_lots/FeatureServer` | 0 | 384 | lat/lon attributes present |
| Metro | `Hosted/Մետրո_կայաններ/FeatureServer` | 0 | 34 | 14 named + planned |
| Kindergartens | `Hosted/Մանկապարտեզներ/FeatureServer` | 0 | 71 | |
| Hotels | `Hosted/Հյուրանոցներ/FeatureServer` | 0 | 41 | x=lon y=lat |
| Waste bins | `Hosted/թափոնամաններ_view/FeatureServer` | 0 | 280 | operator, hours, phone, email |

The 12 districts: `01-001` Աջափնյակ, `01-002` Ավան, `01-003` Արաբկիր, `01-004` Դավթաշեն, `01-005` Էրեբունի, `01-006` Կենտրոն, `01-007` Մալաթիա-Սեբաստիա, `01-008` Նոր Նորք, `01-009` Նորք-Մարաշ, `01-010` Նուբարաշեն, `01-011` Շենգավիթ, `01-012` Քանաքեռ-Զեյթուն.

## Verified query semantics (all work anonymously)

| Capability | Works? | Notes |
|---|---|---|
| `outSR=4326` | ✅ | source is ARM_PCS (no wkid); server reprojects. Without it you get raw metres. |
| `f=geojson` / `f=pbf` | ✅ | |
| point + `distance`+`units` buffer | ✅ | use short `geometry=x,y`; `spatialRel` defaults to Intersects |
| envelope filter | ✅ | `geometry=xmin,ymin,xmax,ymax&geometryType=esriGeometryEnvelope` |
| `returnCountOnly` | ✅ | |
| `returnDistinctValues` | ✅ | **requires `returnGeometry=false`** or HTTP 400 |
| `orderByFields` + `resultOffset`/`resultRecordCount` | ✅ | `maxRecordCount` 1000–2000 |
| `outStatistics` + `groupByFieldsForStatistics` | ✅ | supportsStatistics, percentile, having, count-distinct all true |
| `returnExtentOnly` | ✅ | city bbox ≈ 44.361,40.065 → 44.626,40.242 |
| MapServer `export` (png) | ✅ | returns `href`; `f=image` for raw bytes |
| MapServer `identify` | ✅ | attributes keyed by **alias**, not field name |
| polygon centroid / envelope from server | ❌ | `supportsReturningGeometryCentroid:false` — compute client-side |

## Gotchas (encoded in the MCP)

1. **Layer ids skip 0** (see table). Read the service root / `list_service_layers` first.
2. **Custom SR, no wkid** — always `inSR=4326`/`outSR=4326`.
3. **No coded-value domains anywhere** — categories are free-text Armenian; discover with `returnDistinctValues`. Trim trailing `\n`/space padding.
4. **Numbers as strings** in air data (`"9.29"`); missing = `""` not null.
5. **Dates = epoch ms UTC**; Yerevan = UTC+4. In `records_v2_4` the usable dates are `startofperiod_date`/`time_` (the String `startofperiod` is always null); in `Air_Pollution_2024_2025_Live` it's the reverse (`time_` null, use `startofper`/`endofperio`). `Construction_public_view.expiration_of_permit` is a **string** `dd-mm-yyyy` (not range-queryable).
6. **`ORDER BY … DESC` puts NULLs first** (Postgres-backed) — add `WHERE <field> IS NOT NULL` when finding max.
7. **Armenian spelling traps** in service names, e.g. special-regimes service is `Կառուցապատման_հատուկ_ռեղիմներ2` with **ղ** (and it's token-locked → HTTP 499). Percent-encode every segment.
8. **Restricted (499) ≠ missing (404)** — the client surfaces them separately.

## Security exposure

Anonymous **Create/Update/Delete** advertised on: `records_v2_4`, `Predicted_AQI`, `Հողամաս_search` (≈185k parcels). Report to the operators.

## Public apps (item ids)

Air pollution PM2.5 `d6435f44ea92460682d12c2317612b29` · Construction permits `5b664ee26f71429caa0745deb53f2155` · Master plan `6b47fa041f0d49578bfde03d79705c22` · Investment projects `872b657af3704f32b2838c9b894a4053` · Road network `13c109e913644a8d877db51465ace1f2` · Monuments `fc8118116b344e7ebacbd1c82fa698ff` · Waste-bins dashboard `7c6144d445d54687a3b86cf42f99989f` · Elevators dashboard `17ec1b4b6e8c41d0bbc1af79e66e49ea` · Geoportal front door `0c7ad5152e7f413890b19e54dd187588`. Viewer: `https://gis.yerevan.am/portal/home/item.html?id=<id>`.
