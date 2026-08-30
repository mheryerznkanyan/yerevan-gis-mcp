/**
 * Curated catalog of the useful layers on gis.yerevan.am, distilled from a live
 * profile of the portal (Aug 2026). The generic tools can reach ANY layer; this
 * catalog is what powers `search_layers` ranking and the curated domain tools,
 * and documents the quirks (non-zero layer ids, address fields, join keys).
 */

export type Domain =
  | "air_quality"
  | "environment"
  | "cadastre"
  | "zoning"
  | "construction"
  | "transport"
  | "amenities"
  | "admin"
  | "addressing";

export interface CatalogLayer {
  key: string; // stable slug used by tools
  title: string; // human title (English)
  servicePath: string; // e.g. "Hosted/Կադաստր_քարտեզ/FeatureServer" (Armenian ok)
  layerId: number; // NOT always 0 — see profiling
  geometry: "point" | "polyline" | "polygon" | "table" | "multipatch";
  domain: Domain;
  approxCount?: number;
  /** English gloss of what one row is. */
  description: string;
  /** Keywords (English + Armenian) for search_layers matching. */
  keywords: string[];
  /** Field the tools treat as the display name, if any. */
  displayField?: string;
  /** Free-text address field, if the layer has one. */
  addressField?: string;
  /** Native SR is 4326 already (skip reprojection surprises). */
  nativeWgs84?: boolean;
  notes?: string;
}

export const CATALOG: CatalogLayer[] = [
  // ---- Air quality / environment ----------------------------------------
  {
    key: "air_stations_live",
    title: "Air quality — live stations",
    servicePath: "Hosted/Device_Joined_NewAPI/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "air_quality",
    approxCount: 222,
    description:
      "Sensor stations joined to their latest hourly reading (PM2.5/PM10/NO2, AQI, temp, humidity). Best single source for 'current air quality'.",
    keywords: ["air", "aqi", "pm2.5", "pm10", "pollution", "sensor", "օդ", "աղտոտվածություն", "clarity"],
    displayField: "code",
  },
  {
    key: "air_readings_hourly",
    title: "Air quality — hourly readings (live time series)",
    servicePath: "Hosted/records_v2_4/FeatureServer",
    layerId: 0,
    geometry: "table",
    domain: "air_quality",
    approxCount: 294335,
    description:
      "The live hourly readings fact table. Join key sourceid = Devices.code. Dates in startofperiod_date / time_ (epoch ms).",
    keywords: ["air", "hourly", "readings", "history", "time series", "pm2.5", "no2"],
    notes: "Numeric metrics often typed as String; missing values are empty strings.",
  },
  {
    key: "air_readings_history",
    title: "Air quality — hourly readings (archive to Aug 2025)",
    servicePath: "Hosted/Records_hourly/FeatureServer",
    layerId: 0,
    geometry: "table",
    domain: "air_quality",
    approxCount: 596166,
    description: "Same schema as records_v2_4 but frozen; holds the pre-2025-08-19 history.",
    keywords: ["air", "history", "archive", "hourly"],
  },
  {
    key: "air_daily",
    title: "Air quality — daily aggregates",
    servicePath: "Hosted/Air_Pollution_2024_2025_Live/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "air_quality",
    approxCount: 105561,
    description: "Daily roll-up per station (10-char field names; dates in startofper/endofperio).",
    keywords: ["air", "daily", "trend", "pm2.5"],
  },
  {
    key: "air_forecast",
    title: "Air quality — AQI forecast",
    servicePath: "Hosted/Predicted_AQI/FeatureServer",
    layerId: 0,
    geometry: "table",
    domain: "air_quality",
    approxCount: 230,
    description: "City-wide predicted AQI by day (fields aqi, date_pbl_aqi). Filter date_pbl_aqi IS NOT NULL.",
    keywords: ["air", "forecast", "predicted", "aqi", "կանխատեսում"],
  },
  {
    key: "air_devices",
    title: "Air quality — sensor registry",
    servicePath: "Hosted/Devices/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "air_quality",
    approxCount: 54,
    description: "Canonical sensor stations: code (join key), address (in globalid field), lat/lon, photo.",
    keywords: ["air", "sensor", "device", "station", "registry"],
    displayField: "code",
    addressField: "globalid",
    notes: "The 'globalid' field holds the Armenian street address, not a GUID.",
  },
  {
    key: "waste_bins",
    title: "Waste / recycling bins",
    servicePath: "Hosted/թափոնամաններ_view/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "environment",
    approxCount: 280,
    description: "Public waste & recycling bin locations with operator, hours, phone, email.",
    keywords: ["waste", "bin", "recycling", "trash", "թափոն", "աղբ"],
    displayField: "adress",
    addressField: "adress",
  },
  {
    key: "green_new",
    title: "Green areas — newly created",
    servicePath: "Hosted/Նոր_կանաչ_տարածք_view/FeatureServer",
    layerId: 0,
    geometry: "polygon",
    domain: "environment",
    approxCount: 21,
    description: "Recently created green spaces with name, year, tree count, irrigation, area (ha).",
    keywords: ["green", "park", "trees", "կանաչ", "այգի"],
    displayField: "name",
  },
  {
    key: "parks",
    title: "Parks (պուրակ)",
    servicePath: "Hosted/Պուրակ/FeatureServer",
    layerId: 0,
    geometry: "polygon",
    domain: "environment",
    approxCount: 121,
    description: "Named public parks/squares by district.",
    keywords: ["park", "purak", "պուրակ", "green"],
    displayField: "anvanum",
  },
  {
    key: "forests",
    title: "Forests",
    servicePath: "Hosted/Անտառներ/FeatureServer",
    layerId: 21,
    geometry: "polygon",
    domain: "environment",
    approxCount: 62,
    description: "Forest polygons by district.",
    keywords: ["forest", "անտառ", "green"],
    notes: "Layer id is 21, not 0.",
  },
  {
    key: "groundwater",
    title: "Groundwater depth bands",
    servicePath: "Hosted/Ստորգետնյա_ջրեր/FeatureServer",
    layerId: 16,
    geometry: "polygon",
    domain: "environment",
    approxCount: 168,
    description: "Groundwater depth-band polygons (e.g. '0-2m depth').",
    keywords: ["groundwater", "water", "ստորգետնյա", "ջրեր"],
    notes: "Layer id is 16, not 0.",
  },

  // ---- Cadastre / zoning / construction ---------------------------------
  {
    key: "parcels",
    title: "Cadastral parcels (canonical)",
    servicePath: "Hosted/Կադաստր_քարտեզ/FeatureServer",
    layerId: 2,
    geometry: "polygon",
    domain: "cadastre",
    approxCount: 181341,
    description:
      "Every cadastral parcel. Code split into components rgn_cc/cmm_cc/blk_cc/prc_cc, area in prc_calcar (m²).",
    keywords: ["parcel", "cadastre", "land", "հողամաս", "կադաստր"],
    displayField: "rgn_cc",
    notes: "Layer 2 of Կադաստր_քարտեզ (layer 1 = blocks, layer 3 = buildings).",
  },
  {
    key: "parcels_by_code",
    title: "Cadastral parcels (single code)",
    servicePath: "Hosted/Կադաստրային_հողամաս/FeatureServer",
    layerId: 0,
    geometry: "polygon",
    domain: "cadastre",
    approxCount: 181395,
    description: "Same parcels with the full cadastral code as one field 'code' (e.g. 01-001-0023-0171).",
    keywords: ["parcel", "cadastre", "code", "հողամաս", "կադաստրային կոդ"],
    displayField: "code",
    notes: "objectid aligns 1:1 with Կադաստր_քարտեզ/2. Prefix search on 'code' with LIKE works.",
  },
  {
    key: "buildings",
    title: "Building footprints (cadastral)",
    servicePath: "Hosted/Կադաստր_քարտեզ/FeatureServer",
    layerId: 3,
    geometry: "polygon",
    domain: "cadastre",
    approxCount: 284484,
    description: "Every building footprint. Code components rgn_cc/cmm_cc/blk_cc/prc_cc/bld_cc, area in bld_calcar.",
    keywords: ["building", "footprint", "շենք", "կառույց"],
    notes: "Layer id 3 of Կադաստր_քարտեզ.",
  },
  {
    key: "masterplan",
    title: "Master plan — land use / zoning",
    servicePath: "Հողերի_նշանակությունը/FeatureServer",
    layerId: 0,
    geometry: "polygon",
    domain: "zoning",
    approxCount: 30171,
    description:
      "The land-use / zoning layer. target_purpose_type = land category, designated_use_type = functional use.",
    keywords: ["zoning", "land use", "masterplan", "նշանակություն", "գոտի", "designation"],
    notes: "Root-level service (NOT under Hosted/). Preferred over the per-category *_հողեր extracts.",
  },
  {
    key: "constructions",
    title: "Construction sites & permits",
    servicePath: "Hosted/Construction_public_view/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "construction",
    approxCount: 7834,
    description:
      "Construction projects with address, developer, permit, area, status. Cleanest service on the portal; native WGS84.",
    keywords: ["construction", "permit", "building", "developer", "շինարարություն", "թույլտվություն"],
    displayField: "area_name",
    addressField: "address",
    nativeWgs84: true,
    notes: "status field (alias 'Type'): 'Ընթացքում գտնվող' = in progress, 'Չսկսված' = not started. x/y already lon/lat.",
  },
  {
    key: "leases",
    title: "Land leases",
    servicePath: "Hosted/Վարձակալություններ/FeatureServer",
    layerId: 0,
    geometry: "polygon",
    domain: "cadastre",
    approxCount: 16106,
    description:
      "Leased parcels with cadastral code, address (field b), land category (e), functional use (f), object type (g), lease date (h).",
    keywords: ["lease", "rent", "վարձակալություն", "parcel"],
    addressField: "b",
    notes: "Layer titled 'Questions'; field names are placeholders (a-h). Address is field 'b' (uppercase Armenian).",
  },
  {
    key: "investment_projects",
    title: "Investment projects",
    servicePath: "Hosted/Ներդրումային_ծրագրեր/FeatureServer",
    layerId: 0,
    geometry: "multipatch",
    domain: "construction",
    approxCount: undefined,
    description:
      "Investment project catalog (3D display footprints). Only a 'name' attribute — no status/owner (those live in a token-locked layer). Also published as MapServer + SceneServer.",
    keywords: ["investment", "project", "ներդրում", "ծրագիր"],
    displayField: "name",
    notes: "MultiPatch (3D); attribute /query can be slow. Status/priority-sale data is a separate, token-restricted service.",
  },

  // ---- Transport / mobility ---------------------------------------------
  {
    key: "metro_stations",
    title: "Metro stations",
    servicePath: "Hosted/Մետրո_կայաններ/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "transport",
    approxCount: 34,
    description: "Metro stations (existing + planned). Name field 'մետրո_կայան', phase in 'փուլ'.",
    keywords: ["metro", "subway", "station", "մետրո", "կայան"],
    displayField: "մետրո_կայան",
  },
  {
    key: "bus_stops",
    title: "Bus stops",
    servicePath: "Hosted/Bus_stops_lots/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "transport",
    approxCount: 384,
    description: "Bus stops with street, address, district; carries plain latitude/longitude attributes (WGS84).",
    keywords: ["bus", "stop", "transit", "ավտոբուս", "կանգառ"],
    displayField: "street",
    addressField: "address",
    nativeWgs84: true,
  },
  {
    key: "road_classification",
    title: "Road classification",
    servicePath: "Hosted/Ճանապարհներ_edited/FeatureServer",
    layerId: 0,
    geometry: "polygon",
    domain: "transport",
    approxCount: 209,
    description:
      "Road/street classification polygons: class in 'layer', design speed/lanes/sidewalk widths in field1-4.",
    keywords: ["road", "street", "classification", "ճանապարհ", "փողոց", "դասակարգում"],
  },
  {
    key: "road_repairs_2024",
    title: "Road repairs (2024)",
    servicePath: "Hosted/Միջին_նորոգում_2024_view/FeatureServer",
    layerId: 0,
    geometry: "polygon",
    domain: "transport",
    approxCount: 70,
    description: "2024 mid-level road repair segments with district, area, type, price.",
    keywords: ["road", "repair", "renovation", "նորոգում"],
  },
  {
    key: "bridges",
    title: "Bridges & overpasses",
    servicePath: "Hosted/Կամուրջներ_և_էստակադաներ/FeatureServer",
    layerId: 0,
    geometry: "polyline",
    domain: "transport",
    approxCount: 9,
    description: "Bridges and overpasses (name in 'անվանում').",
    keywords: ["bridge", "overpass", "կամուրջ", "էստակադա"],
    displayField: "անվանում",
  },
  {
    key: "elevators",
    title: "Elevator replacements (2024)",
    servicePath: "Hosted/Elevators_2024_view/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "amenities",
    approxCount: 3060,
    description: "Elevator replacement programme points with district, address, status, price.",
    keywords: ["elevator", "lift", "վերելակ"],
    addressField: "address",
  },
  {
    key: "streets_squares",
    title: "Streets & squares (footprints)",
    servicePath: "Hosted/Փողոցներ_և_հրապարակներ/FeatureServer",
    layerId: 0,
    geometry: "polygon",
    domain: "transport",
    approxCount: 4983,
    description: "Street and square footprint polygons by designation and district.",
    keywords: ["street", "square", "փողոց", "հրապարակ"],
    notes: "No street-name field — do not use for geocoding.",
  },

  // ---- Amenities / heritage ---------------------------------------------
  {
    key: "kindergartens",
    title: "Kindergartens",
    servicePath: "Hosted/Մանկապարտեզներ/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "amenities",
    approxCount: 71,
    description: "Municipal kindergartens with name, address, community, renovation status/year.",
    keywords: ["kindergarten", "preschool", "մանկապարտեզ"],
    displayField: "kind_name",
    addressField: "address",
  },
  {
    key: "hotels",
    title: "Hotels",
    servicePath: "Hosted/Հյուրանոցներ/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "amenities",
    approxCount: 41,
    description: "Hotels with name (Latin), address, stars, rooms; x=lon y=lat (WGS84).",
    keywords: ["hotel", "հյուրանոց", "accommodation"],
    displayField: "հյուրանոցի__անվանումը",
    addressField: "հասցե",
    nativeWgs84: true,
  },
  {
    key: "monuments_national",
    title: "Monuments — national significance",
    servicePath: "Hosted/Հուշարձաններ_ԳՀ_2024/FeatureServer",
    layerId: 70,
    geometry: "polygon",
    domain: "amenities",
    approxCount: 247,
    description: "Cultural monuments of national significance.",
    keywords: ["monument", "heritage", "հուշարձան"],
    notes: "Layer id 70 (national), 71 = local significance. No layer 0.",
  },
  {
    key: "monuments_local",
    title: "Monuments — local significance",
    servicePath: "Hosted/Հուշարձաններ_ԳՀ_2024/FeatureServer",
    layerId: 71,
    geometry: "polygon",
    domain: "amenities",
    approxCount: 165,
    description: "Cultural monuments of local significance.",
    keywords: ["monument", "heritage", "հուշարձան", "local"],
  },
  {
    key: "culture_venues",
    title: "Culture venues (trilingual)",
    servicePath: "Hosted/Culture/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "amenities",
    approxCount: 16,
    description: "Cultural venues with HY/FR/EN name, type, address (small set).",
    keywords: ["culture", "venue", "մշակույթ"],
    displayField: "name",
  },

  // ---- Heritage / amenities / utilities (added) --------------------------
  {
    key: "memorial_plaques",
    title: "Memorial plaques",
    servicePath: "Hosted/Հուշատախտակներ_view/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "amenities",
    approxCount: 395,
    description:
      "Memorial plaques: who/what is honoured (name), street address, and the city-council decision that authorised each.",
    keywords: ["plaque", "memorial", "commemoration", "հուշատախտակ"],
    displayField: "name",
    addressField: "address",
  },
  {
    key: "monuments_all",
    title: "Monuments — full register",
    servicePath: "Hosted/Բոլոր_հուշարձանները_view/FeatureServer",
    layerId: 0,
    geometry: "polygon",
    domain: "amenities",
    approxCount: 383,
    description:
      "All cultural monuments: name, designation/category, state index number, address, historical period, description.",
    keywords: ["monument", "heritage", "cultural", "հուշարձան"],
    displayField: "name",
    addressField: "address",
  },
  {
    key: "medical_centers",
    title: "Medical centers",
    servicePath: "Hosted/Բժշկական_կենտրոններ/FeatureServer",
    layerId: 0,
    geometry: "point",
    domain: "amenities",
    approxCount: 3,
    description: "Medical centers with bilingual (Armenian/French) name and address. Small set.",
    keywords: ["medical", "clinic", "hospital", "health", "բժշկական"],
    displayField: "name_am",
    addressField: "add_am",
    nativeWgs84: true,
    notes: "x=lon, y=lat stored as attributes. Only 3 rows (Francophonie subset).",
  },
  {
    key: "cemeteries",
    title: "Cemeteries",
    servicePath: "Hosted/Գերեզմանատներ/FeatureServer",
    layerId: 12,
    geometry: "polygon",
    domain: "amenities",
    approxCount: 26,
    description: "Cemeteries with address, type and administrative district.",
    keywords: ["cemetery", "graveyard", "burial", "գերեզման"],
    displayField: "հասցե",
    addressField: "հասցե",
    notes: "Layer id 12 (not 0). OID field is 'fid', not 'objectid'.",
  },
  {
    key: "substations",
    title: "Electric substations",
    servicePath: "Hosted/Ենթակայաններ/FeatureServer",
    layerId: 0,
    geometry: "polygon",
    domain: "amenities",
    approxCount: 60,
    description: "Electric substations with name (anun) and voltage class (e.g. 110 kV, in paym_nshan).",
    keywords: ["substation", "electric", "power", "energy", "voltage", "ենթակայան"],
    displayField: "anun",
    notes: "The only energy/utility layer with real attributes — the power-line and pipe network layers are CAD geometry only.",
  },
  {
    key: "kindergarten_finance",
    title: "Kindergarten financing by year",
    servicePath: "Hosted/kindergarden_finance_2019_2025/FeatureServer",
    layerId: 0,
    geometry: "table",
    domain: "amenities",
    approxCount: 8,
    description: "Total municipal kindergarten financing per year, 2019-2025 (non-spatial table: year, finance).",
    keywords: ["kindergarten", "finance", "budget", "financing", "մանկապարտեզ", "ֆինանսավորում"],
    notes: "Non-spatial table — aggregate/read only, no geometry.",
  },
  {
    key: "monte_lots",
    title: "Monte redevelopment lots",
    servicePath: "Hosted/monte_lots/FeatureServer",
    layerId: 0,
    geometry: "polygon",
    domain: "construction",
    approxCount: 8,
    description: "Monte redevelopment project lot subdivision; lot number + area (m²) are embedded in the 'layer' text.",
    keywords: ["monte", "lot", "redevelopment", "investment", "ներդրում"],
    displayField: "layer",
  },

  // ---- Admin / addressing ------------------------------------------------
  {
    key: "districts",
    title: "Administrative districts",
    servicePath: "Hosted/Yerevan_Districts/FeatureServer",
    layerId: 0,
    geometry: "polygon",
    domain: "admin",
    approxCount: 12,
    description: "The 12 administrative districts, with settlement_name and community_code (01-001 … 01-012).",
    keywords: ["district", "administrative", "վարչական շրջան", "community"],
    displayField: "settlement_name",
  },
  {
    key: "named_roads",
    title: "Named roads (street geocoder source)",
    servicePath: "Yerevan_Named_Roads/FeatureServer",
    layerId: 0,
    geometry: "polyline",
    domain: "addressing",
    approxCount: 25749,
    description:
      "Road centerlines joined to the toponym register. street_name holds the full Armenian street name; ~7,362 named.",
    keywords: ["street", "road", "address", "geocode", "toponym", "փողոց", "ճանապարհ", "հասցե"],
    displayField: "street_name",
    notes: "Root-level. Filter street_name IS NOT NULL. Armenian only — no Latin. Best substitute for the tokened geocoder.",
  },
  {
    key: "toponyms",
    title: "Street name register (toponyms)",
    servicePath: "Cadastral_toponym_lines/FeatureServer",
    layerId: 0,
    geometry: "polyline",
    domain: "addressing",
    approxCount: 1531,
    description:
      "Official street-name register with full name, council decision, previous names, status.",
    keywords: ["toponym", "street name", "register", "renamed", "տեղանուն", "նախկին անվանում"],
    displayField: "toponym_full_name",
  },
  {
    key: "named_areas",
    title: "Named areas gazetteer",
    servicePath: "Yerevan_Named_Areas_Live/FeatureServer",
    layerId: 138,
    geometry: "polygon",
    domain: "addressing",
    approxCount: undefined,
    description: "Named intra-settlement geographic areas (neighbourhoods, quarters).",
    keywords: ["area", "neighbourhood", "quarter", "թաղամաս", "gazetteer"],
    displayField: "toponym_name",
    notes: "Layer id 138.",
  },
];

/** The 12 administrative districts: community_code -> Armenian name. */
export const DISTRICTS: Record<string, string> = {
  "01-001": "Աջափնյակ",
  "01-002": "Ավան",
  "01-003": "Արաբկիր",
  "01-004": "Դավթաշեն",
  "01-005": "Էրեբունի",
  "01-006": "Կենտրոն",
  "01-007": "Մալաթիա-Սեբաստիա",
  "01-008": "Նոր Նորք",
  "01-009": "Նորք-Մարաշ",
  "01-010": "Նուբարաշեն",
  "01-011": "Շենգավիթ",
  "01-012": "Քանաքեռ-Զեյթուն",
};

/** English aliases for the districts, for friendlier matching. */
export const DISTRICT_ALIASES: Record<string, string> = {
  ajapnyak: "01-001",
  avan: "01-002",
  arabkir: "01-003",
  davtashen: "01-004",
  erebuni: "01-005",
  kentron: "01-006",
  center: "01-006",
  centre: "01-006",
  "malatia-sebastia": "01-007",
  malatia: "01-007",
  "nor nork": "01-008",
  nornork: "01-008",
  "nork-marash": "01-009",
  nubarashen: "01-010",
  shengavit: "01-011",
  "kanaker-zeytun": "01-012",
  kanaker: "01-012",
};

export function findLayer(key: string): CatalogLayer | undefined {
  return CATALOG.find((l) => l.key === key);
}

/** Resolve a district by code, Armenian name, or English alias → community_code. */
export function resolveDistrict(input: string): { code: string; name: string } | null {
  const s = input.trim();
  if (DISTRICTS[s]) return { code: s, name: DISTRICTS[s]! };
  for (const [code, name] of Object.entries(DISTRICTS)) {
    if (name === s) return { code, name };
  }
  const alias = DISTRICT_ALIASES[s.toLowerCase()];
  if (alias) return { code: alias, name: DISTRICTS[alias]! };
  // partial Armenian match
  for (const [code, name] of Object.entries(DISTRICTS)) {
    if (name.includes(s) || s.includes(name)) return { code, name };
  }
  return null;
}
