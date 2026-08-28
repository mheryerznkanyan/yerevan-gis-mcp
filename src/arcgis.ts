/**
 * Low-level client for the Yerevan Municipality ArcGIS Enterprise 11.5 REST API
 * (https://gis.yerevan.am). Everything here is anonymous — the portal exposes
 * its FeatureServers with no token — so this client never sends credentials.
 *
 * Design notes baked in from profiling the live API:
 *  - Source data is in a custom Armenia projection (ARM_PCS, no wkid). We ALWAYS
 *    request/return WGS84 (outSR=4326) and send input geometry as inSR=4326.
 *  - maxRecordCount is 1000-2000 per layer, so every "get all" call paginates
 *    with resultOffset / resultRecordCount until exceededTransferLimit clears.
 *  - Armenian service names must be percent-encoded, and some encode to 235+
 *    chars; combined with a JSON `geometry`/`outStatistics` payload the URL can
 *    blow past proxy/query limits, so those requests go out as POST form bodies.
 *  - A locked layer answers 499 "Token Required"; a missing one answers 404.
 *    We surface those as distinct, readable errors.
 */

export const SERVER_BASE = "https://gis.yerevan.am/server/rest/services";
export const PORTAL_BASE = "https://gis.yerevan.am/portal/sharing/rest";

export class ArcGisError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly kind:
      | "restricted"
      | "not_found"
      | "server"
      | "network"
      | "bad_request" = "server",
  ) {
    super(message);
    this.name = "ArcGisError";
  }
}

export interface Field {
  name: string;
  type: string;
  alias?: string;
  length?: number;
  domain?: unknown;
}

export interface QueryOptions {
  where?: string;
  outFields?: string; // default "*"
  returnGeometry?: boolean; // default false
  outSR?: number; // default 4326
  orderByFields?: string;
  resultOffset?: number;
  resultRecordCount?: number;
  /** Spatial filter (all optional, but geometry+geometryType go together). */
  geometry?: string; // "x,y" for a point, "xmin,ymin,xmax,ymax" for an envelope
  geometryType?: "esriGeometryPoint" | "esriGeometryEnvelope" | "esriGeometryPolygon";
  inSR?: number; // default 4326
  spatialRel?: string; // default esriSpatialRelIntersects
  distance?: number; // buffer, honoured with a point geometry
  units?: string; // default esriSRUnit_Meter
  returnDistinctValues?: boolean;
  f?: "json" | "geojson";
}

export interface FeatureQueryResult {
  fields?: Field[];
  features: Array<{ attributes: Record<string, unknown>; geometry?: unknown }>;
  exceededTransferLimit?: boolean;
  spatialReference?: unknown;
  geometryType?: string;
}

interface RequestOptions {
  timeoutMs?: number;
  method?: "GET" | "POST";
}

export interface ArcGisClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export class ArcGisClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(opts: ArcGisClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        "No fetch implementation available. Use Node 18+ or pass fetchImpl.",
      );
    }
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent ?? "yerevan-gis-mcp/1.0";
  }

  /** Percent-encode one path segment (handles Armenian service names). */
  static encodeSegment(seg: string): string {
    return encodeURIComponent(seg);
  }

  /**
   * Build a fully-qualified service URL from a service path that may contain
   * Armenian characters, e.g. "Hosted/Կադաստր_քարտեզ/FeatureServer".
   * Each "/"-separated segment is encoded independently.
   */
  serviceUrl(servicePath: string): string {
    const clean = servicePath.replace(/^\/+|\/+$/g, "");
    const encoded = clean.split("/").map((s) => ArcGisClient.encodeSegment(s)).join("/");
    return `${SERVER_BASE}/${encoded}`;
  }

  private async request(
    url: string,
    body?: URLSearchParams,
    opts: RequestOptions = {},
  ): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: body ? "POST" : "GET",
        headers: body
          ? {
              "content-type": "application/x-www-form-urlencoded",
              "user-agent": this.userAgent,
              accept: "application/json",
            }
          : { "user-agent": this.userAgent, accept: "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ArcGisError(
        `Network error reaching ${url}: ${msg}. Note: gis.yerevan.am is only reachable from a network with normal internet egress.`,
        undefined,
        "network",
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new ArcGisError(
        `HTTP ${res.status} from ${url}`,
        res.status,
        res.status === 404 ? "not_found" : "server",
      );
    }

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ArcGisError(
        `Non-JSON response from ${url} (got ${text.slice(0, 120)}…). The endpoint may be an HTML page rather than a REST service.`,
        undefined,
        "server",
      );
    }

    // ArcGIS returns HTTP 200 with an { error } envelope for logical errors.
    if (json && typeof json === "object" && json.error) {
      const code: number | undefined = json.error.code;
      const message: string = json.error.message ?? "ArcGIS error";
      const details: string[] = Array.isArray(json.error.details) ? json.error.details : [];
      if (code === 499 || code === 498 || /token required/i.test(message)) {
        throw new ArcGisError(
          `Layer is restricted (token required): ${message}`,
          code,
          "restricted",
        );
      }
      if (code === 404 || /not found/i.test(message)) {
        throw new ArcGisError(`${message}${details.length ? " — " + details.join("; ") : ""}`, code, "not_found");
      }
      throw new ArcGisError(
        `${message}${details.length ? " — " + details.join("; ") : ""}`,
        code,
        "bad_request",
      );
    }

    return json;
  }

  /** GET a REST resource by full URL with f=json. */
  async getResource(url: string, params: Record<string, string> = {}): Promise<any> {
    const u = new URL(url);
    u.searchParams.set("f", "json");
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return this.request(u.toString());
  }

  /** Describe a FeatureServer (list of layers + tables). */
  async describeService(servicePath: string): Promise<any> {
    // Normalise: allow callers to pass a path with or without a trailing
    // "/FeatureServer".
    let path = servicePath.replace(/\/+$/, "");
    if (!/\/(Feature|Map|Image|Scene)Server$/i.test(path)) {
      path = `${path}/FeatureServer`;
    }
    return this.getResource(this.serviceUrl(path));
  }

  /** Describe a single layer/table by id. */
  async describeLayer(servicePath: string, layerId: number): Promise<any> {
    let path = servicePath.replace(/\/+$/, "");
    path = path.replace(/\/\d+$/, ""); // strip any trailing /<id>
    if (!/\/(Feature|Map|Image|Scene)Server$/i.test(path)) {
      path = `${path}/FeatureServer`;
    }
    return this.getResource(`${this.serviceUrl(path)}/${layerId}`);
  }

  private buildQueryParams(o: QueryOptions): URLSearchParams {
    const p = new URLSearchParams();
    p.set("where", o.where ?? "1=1");
    p.set("outFields", o.outFields ?? "*");
    p.set("returnGeometry", String(o.returnGeometry ?? false));
    if (o.returnDistinctValues) {
      p.set("returnDistinctValues", "true");
      // Distinct requires returnGeometry=false, or the server 400s.
      p.set("returnGeometry", "false");
    }
    p.set("outSR", String(o.outSR ?? 4326));
    if (o.orderByFields) p.set("orderByFields", o.orderByFields);
    if (o.resultOffset != null) p.set("resultOffset", String(o.resultOffset));
    if (o.resultRecordCount != null) p.set("resultRecordCount", String(o.resultRecordCount));
    if (o.geometry) {
      p.set("geometry", o.geometry);
      p.set("geometryType", o.geometryType ?? "esriGeometryPoint");
      p.set("inSR", String(o.inSR ?? 4326));
      p.set("spatialRel", o.spatialRel ?? "esriSpatialRelIntersects");
      if (o.distance != null) {
        p.set("distance", String(o.distance));
        p.set("units", o.units ?? "esriSRUnit_Meter");
      }
    }
    p.set("f", o.f ?? "json");
    return p;
  }

  /**
   * Run a single /query call (one page). Sent as POST so long Armenian service
   * URLs plus geometry payloads never hit a URL-length limit.
   */
  async queryLayerPage(
    servicePath: string,
    layerId: number,
    o: QueryOptions = {},
  ): Promise<FeatureQueryResult> {
    let path = servicePath.replace(/\/+$/, "").replace(/\/\d+$/, "");
    if (!/\/(Feature|Map|Image|Scene)Server$/i.test(path)) path = `${path}/FeatureServer`;
    const url = `${this.serviceUrl(path)}/${layerId}/query`;
    const body = this.buildQueryParams(o);
    const json = await this.request(url, body);
    if (o.f === "geojson") {
      // GeoJSON responses have a different shape; hand back a thin wrapper.
      return {
        features: (json.features ?? []).map((ft: any) => ({
          attributes: ft.properties ?? {},
          geometry: ft.geometry,
        })),
        exceededTransferLimit: json.properties?.exceededTransferLimit,
      };
    }
    return {
      fields: json.fields,
      features: json.features ?? [],
      exceededTransferLimit: json.exceededTransferLimit,
      spatialReference: json.spatialReference,
      geometryType: json.geometryType,
    };
  }

  /**
   * Query a layer, transparently paginating up to `maxFeatures`.
   * Returns plain attribute rows (and geometry when requested).
   */
  async queryLayer(
    servicePath: string,
    layerId: number,
    o: QueryOptions = {},
    maxFeatures = 2000,
  ): Promise<{
    fields?: Field[];
    rows: Array<{ attributes: Record<string, unknown>; geometry?: unknown }>;
    truncated: boolean;
  }> {
    const rows: Array<{ attributes: Record<string, unknown>; geometry?: unknown }> = [];
    let fields: Field[] | undefined;
    let offset = o.resultOffset ?? 0;
    const pageSize = o.resultRecordCount ?? 1000;
    let truncated = false;

    // Distinct + statistics style queries aren't paginated here; caller passes
    // a single page for those.
    while (rows.length < maxFeatures) {
      const remaining = maxFeatures - rows.length;
      const page = await this.queryLayerPage(servicePath, layerId, {
        ...o,
        resultOffset: offset,
        resultRecordCount: Math.min(pageSize, remaining),
      });
      if (!fields && page.fields) fields = page.fields;
      rows.push(...page.features);
      if (!page.exceededTransferLimit || page.features.length === 0) break;
      offset += page.features.length;
      if (rows.length >= maxFeatures) {
        truncated = true;
        break;
      }
    }
    return { fields, rows, truncated };
  }

  /** Count features matching a where clause (and optional spatial filter). */
  async count(servicePath: string, layerId: number, o: QueryOptions = {}): Promise<number> {
    let path = servicePath.replace(/\/+$/, "").replace(/\/\d+$/, "");
    if (!/\/(Feature|Map|Image|Scene)Server$/i.test(path)) path = `${path}/FeatureServer`;
    const url = `${this.serviceUrl(path)}/${layerId}/query`;
    const body = this.buildQueryParams({ ...o, returnGeometry: false });
    body.set("returnCountOnly", "true");
    const json = await this.request(url, body);
    return json.count ?? 0;
  }

  /** Distinct values of one field. */
  async distinctValues(
    servicePath: string,
    layerId: number,
    field: string,
    where = "1=1",
  ): Promise<unknown[]> {
    const { rows } = await this.queryLayer(
      servicePath,
      layerId,
      {
        where,
        outFields: field,
        returnDistinctValues: true,
        returnGeometry: false,
        orderByFields: field,
      },
      2000,
    );
    return rows.map((r) => r.attributes[field]);
  }

  /**
   * Statistics query (count/min/max/avg/sum), optionally grouped. Sent as POST
   * because outStatistics is a JSON blob.
   */
  async statistics(
    servicePath: string,
    layerId: number,
    outStatistics: Array<{
      statisticType: "count" | "min" | "max" | "avg" | "sum" | "stddev" | "var";
      onStatisticField: string;
      outStatisticFieldName: string;
    }>,
    opts: { where?: string; groupByFields?: string; orderByFields?: string } = {},
  ): Promise<Array<Record<string, unknown>>> {
    let path = servicePath.replace(/\/+$/, "").replace(/\/\d+$/, "");
    if (!/\/(Feature|Map|Image|Scene)Server$/i.test(path)) path = `${path}/FeatureServer`;
    const url = `${this.serviceUrl(path)}/${layerId}/query`;
    const body = new URLSearchParams();
    body.set("where", opts.where ?? "1=1");
    body.set("outStatistics", JSON.stringify(outStatistics));
    if (opts.groupByFields) body.set("groupByFieldsForStatistics", opts.groupByFields);
    if (opts.orderByFields) body.set("orderByFields", opts.orderByFields);
    body.set("returnGeometry", "false");
    body.set("f", "json");
    const json = await this.request(url, body);
    return (json.features ?? []).map((ft: any) => ft.attributes);
  }

  // ---- Portal (sharing/rest) helpers ---------------------------------------

  /** Search portal items. Returns the raw portal search envelope. */
  async portalSearch(
    q: string,
    opts: { num?: number; start?: number; sortField?: string; sortOrder?: string } = {},
  ): Promise<any> {
    const u = new URL(`${PORTAL_BASE}/search`);
    u.searchParams.set("q", q);
    u.searchParams.set("num", String(opts.num ?? 50));
    if (opts.start != null) u.searchParams.set("start", String(opts.start));
    if (opts.sortField) u.searchParams.set("sortField", opts.sortField);
    if (opts.sortOrder) u.searchParams.set("sortOrder", opts.sortOrder);
    u.searchParams.set("f", "json");
    return this.request(u.toString());
  }

  /** Read one portal item's description. */
  async portalItem(itemId: string): Promise<any> {
    return this.request(`${PORTAL_BASE}/content/items/${encodeURIComponent(itemId)}?f=json`);
  }

  /** Read a web map / app item's operational data (layers, widgets…). */
  async portalItemData(itemId: string): Promise<any> {
    return this.request(`${PORTAL_BASE}/content/items/${encodeURIComponent(itemId)}/data?f=json`);
  }
}
