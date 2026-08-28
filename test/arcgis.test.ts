import { describe, it, expect } from "vitest";
import { ArcGisClient, ArcGisError } from "../src/arcgis.js";

/** Build a fake fetch that returns queued JSON bodies and records the calls. */
function fakeFetch(queue: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const impl = (async (url: string, init?: any) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? String(init.body) : null,
    });
    const next = queue.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("serviceUrl", () => {
  it("percent-encodes Armenian service-path segments independently", () => {
    const c = new ArcGisClient({ fetchImpl: (() => {}) as any });
    const url = c.serviceUrl("Hosted/Կադաստր_քարտեզ/FeatureServer");
    expect(url).toContain("/Hosted/");
    expect(url).toContain("/FeatureServer");
    expect(url).toContain("%D4%BF"); // encoded first Armenian letter
    expect(url).not.toContain("Կ"); // raw Armenian must not survive
  });
});

describe("queryLayer pagination", () => {
  it("follows exceededTransferLimit and stops when clear", async () => {
    const { impl, calls } = fakeFetch([
      { body: { fields: [{ name: "objectid", type: "esriFieldTypeOID" }], features: [{ attributes: { objectid: 1 } }, { attributes: { objectid: 2 } }], exceededTransferLimit: true } },
      { body: { features: [{ attributes: { objectid: 3 } }], exceededTransferLimit: false } },
    ]);
    const c = new ArcGisClient({ fetchImpl: impl });
    const { rows, truncated } = await c.queryLayer("Hosted/X/FeatureServer", 0, { where: "1=1", resultRecordCount: 2 }, 1000);
    expect(rows.map((r) => r.attributes.objectid)).toEqual([1, 2, 3]);
    expect(truncated).toBe(false);
    // Both requests are POSTs to the /query endpoint.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toMatch(/\/0\/query$/);
    // Second page advanced the offset by the first page's length.
    expect(calls[1]!.body).toContain("resultOffset=2");
  });

  it("respects maxFeatures and reports truncation", async () => {
    const { impl } = fakeFetch([
      { body: { features: [{ attributes: { objectid: 1 } }, { attributes: { objectid: 2 } }], exceededTransferLimit: true } },
    ]);
    const c = new ArcGisClient({ fetchImpl: impl });
    const { rows, truncated } = await c.queryLayer("Hosted/X/FeatureServer", 0, { resultRecordCount: 2 }, 2);
    expect(rows).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});

describe("count", () => {
  it("returns the count and sends returnCountOnly", async () => {
    const { impl, calls } = fakeFetch([{ body: { count: 181341 } }]);
    const c = new ArcGisClient({ fetchImpl: impl });
    const n = await c.count("Hosted/Կադաստր_քարտեզ/FeatureServer", 2, { where: "1=1" });
    expect(n).toBe(181341);
    expect(calls[0]!.body).toContain("returnCountOnly=true");
  });
});

describe("error mapping", () => {
  it("maps a 499 token-required envelope to a 'restricted' ArcGisError", async () => {
    const { impl } = fakeFetch([{ body: { error: { code: 499, message: "Token Required" } } }]);
    const c = new ArcGisClient({ fetchImpl: impl });
    await expect(c.describeLayer("Hosted/Locked/FeatureServer", 0)).rejects.toMatchObject({
      name: "ArcGisError",
      kind: "restricted",
    });
  });

  it("maps a not-found envelope to kind 'not_found'", async () => {
    const { impl } = fakeFetch([{ body: { error: { code: 404, message: "Layer not found" } } }]);
    const c = new ArcGisClient({ fetchImpl: impl });
    await expect(c.describeLayer("Hosted/X/FeatureServer", 99)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("wraps network failures with a helpful message", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const c = new ArcGisClient({ fetchImpl: impl });
    const err = await c.count("Hosted/X/FeatureServer", 0).catch((e) => e);
    expect(err).toBeInstanceOf(ArcGisError);
    expect((err as ArcGisError).kind).toBe("network");
  });
});

describe("statistics", () => {
  it("posts an outStatistics blob and returns attribute rows", async () => {
    const { impl, calls } = fakeFetch([
      { body: { features: [{ attributes: { value: 12, type: "Մշակույթ" } }] } },
    ]);
    const c = new ArcGisClient({ fetchImpl: impl });
    const rows = await c.statistics(
      "Hosted/Culture/FeatureServer",
      0,
      [{ statisticType: "count", onStatisticField: "id", outStatisticFieldName: "value" }],
      { groupByFields: "type" },
    );
    expect(rows[0]).toMatchObject({ value: 12 });
    expect(calls[0]!.body).toContain("outStatistics=");
    expect(calls[0]!.body).toContain("groupByFieldsForStatistics=type");
  });
});
