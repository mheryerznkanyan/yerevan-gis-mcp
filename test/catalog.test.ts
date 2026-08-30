import { describe, it, expect } from "vitest";
import { CATALOG, findLayer, resolveDistrict, DISTRICTS } from "../src/catalog/layers.js";

describe("catalog integrity", () => {
  it("has unique keys", () => {
    const keys = CATALOG.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("every layer has a service path and a non-negative layer id", () => {
    for (const l of CATALOG) {
      expect(l.servicePath.length).toBeGreaterThan(0);
      expect(l.layerId).toBeGreaterThanOrEqual(0);
      expect(l.keywords.length).toBeGreaterThan(0);
    }
  });
  it("preserves the non-zero layer ids discovered in profiling", () => {
    expect(findLayer("forests")!.layerId).toBe(21);
    expect(findLayer("groundwater")!.layerId).toBe(16);
    expect(findLayer("monuments_national")!.layerId).toBe(70);
    expect(findLayer("monuments_local")!.layerId).toBe(71);
    expect(findLayer("named_areas")!.layerId).toBe(138);
    expect(findLayer("cemeteries")!.layerId).toBe(12);
    expect(findLayer("parcels")!.layerId).toBe(2);
    expect(findLayer("buildings")!.layerId).toBe(3);
  });
});

describe("resolveDistrict", () => {
  it("resolves by code, Armenian name and English alias", () => {
    expect(resolveDistrict("01-006")!.name).toBe("Կենտրոն");
    expect(resolveDistrict("Կենտրոն")!.code).toBe("01-006");
    expect(resolveDistrict("kentron")!.code).toBe("01-006");
    expect(resolveDistrict("center")!.code).toBe("01-006");
    expect(resolveDistrict("Erebuni")!.code).toBe("01-005");
  });
  it("returns null for nonsense", () => {
    expect(resolveDistrict("Atlantis")).toBeNull();
  });
  it("covers all 12 districts", () => {
    expect(Object.keys(DISTRICTS).length).toBe(12);
  });
});
