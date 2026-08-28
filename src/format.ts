/** Small pure helpers for coping with the quirks of the Yerevan GIS data. */

/** The portal stores dates as epoch milliseconds UTC. Yerevan is UTC+4. */
export function epochToIso(v: unknown): string | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString();
}

/** Same, but rendered in Asia/Yerevan local wall-clock (UTC+4, no DST). */
export function epochToYerevan(v: unknown): string | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n + 4 * 3600 * 1000);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " (UTC+4)");
}

/**
 * Many numeric metrics come back typed as String ("9.29") and missing values
 * as "" rather than null. Parse to a number or null.
 */
export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** Trim strings and collapse the trailing "\n"/space padding seen in the data. */
export function clean(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/** US EPA AQI category from an AQI value. */
export function aqiCategory(aqi: number | null): string | null {
  if (aqi == null) return null;
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

/** Round a number to n decimals, passing null through. */
export function round(v: number | null, n = 2): number | null {
  if (v == null) return null;
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

/** Haversine distance in metres between two [lon,lat] points. */
export function haversineMeters(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Render a field list compactly as "name (alias): type". */
export function describeFields(
  fields: Array<{ name: string; type: string; alias?: string }> = [],
): string {
  return fields
    .map((f) => {
      const t = f.type.replace(/^esriFieldType/, "");
      const alias = f.alias && f.alias !== f.name ? ` «${f.alias}»` : "";
      return `${f.name}${alias}: ${t}`;
    })
    .join("\n");
}
