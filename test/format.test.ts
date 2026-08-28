import { describe, it, expect } from "vitest";
import { num, clean, aqiCategory, round, haversineMeters, epochToIso } from "../src/format.js";

describe("num", () => {
  it("parses numeric strings and passes numbers", () => {
    expect(num("9.29")).toBe(9.29);
    expect(num(12)).toBe(12);
  });
  it("treats empty string and null as missing", () => {
    expect(num("")).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
  });
  it("rejects non-numeric", () => {
    expect(num("calibration-missing")).toBeNull();
  });
});

describe("clean", () => {
  it("trims trailing newline/space padding", () => {
    expect(clean("կարեն սարգսյան\n")).toBe("կարեն սարգսյան");
    expect(clean("1455.             ")).toBe("1455.");
  });
  it("maps blank to null", () => {
    expect(clean("   ")).toBeNull();
    expect(clean(null)).toBeNull();
  });
});

describe("aqiCategory", () => {
  it("maps AQI ranges to US EPA categories", () => {
    expect(aqiCategory(20)).toBe("Good");
    expect(aqiCategory(75)).toBe("Moderate");
    expect(aqiCategory(120)).toBe("Unhealthy for Sensitive Groups");
    expect(aqiCategory(180)).toBe("Unhealthy");
    expect(aqiCategory(250)).toBe("Very Unhealthy");
    expect(aqiCategory(400)).toBe("Hazardous");
    expect(aqiCategory(null)).toBeNull();
  });
});

describe("round", () => {
  it("rounds and passes null", () => {
    expect(round(1.23456, 2)).toBe(1.23);
    expect(round(null)).toBeNull();
  });
});

describe("haversineMeters", () => {
  it("computes a plausible distance across central Yerevan", () => {
    // Republic Square -> Opera, ~1.1 km
    const d = haversineMeters(44.5136, 40.1772, 44.5152, 40.1874);
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(1300);
  });
});

describe("epochToIso", () => {
  it("converts epoch ms and handles blanks", () => {
    expect(epochToIso(1787900400000)).toBe("2026-08-28T07:00:00.000Z");
    expect(epochToIso("")).toBeNull();
  });
});
