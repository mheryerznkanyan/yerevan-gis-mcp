import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ArcGisClient } from "../arcgis.js";
import { findLayer } from "../catalog/layers.js";
import { aqiCategory, epochToYerevan, haversineMeters, num, round, clean } from "../format.js";
import { guard, jsonResult, type ToolResult } from "../mcp-util.js";

// Field names on Device_Joined_NewAPI / records_v2_4 (truncated to 31 chars).
const F = {
  code: "code",
  sourceid: "sourceid",
  lat: "latitude",
  lon: "longitude",
  time: "time_",
  startDate: "startofperiod_date",
  pm25: "pm2_5concmass1hourmean_value",
  pm25aqi: "pm2_5concmassnowcastusepaaqi_va", // US EPA AQI from PM2.5 nowcast
  pm10: "pm10concmass1hourmean_value",
  no2: "no2conc1hourmean_value",
  tempInternal: "temperatureinternal1hourmean_va",
  humInternal: "relhumidinternal1hourmean_value",
  battery: "batterypercentage",
  status: "overallstatus",
  address: "globalid", // on Device_Joined_NewAPI globalid carries the address string
};

interface StationReading {
  station: string | null;
  address: string | null;
  lon: number | null;
  lat: number | null;
  measured_at: string | null;
  aqi: number | null;
  aqi_category: string | null;
  pm2_5: number | null;
  pm10: number | null;
  no2: number | null;
  temperature_c: number | null;
  humidity_pct: number | null;
  distance_m?: number | null;
}

function toReading(a: Record<string, unknown>): StationReading {
  const aqi = num(a[F.pm25aqi]);
  return {
    station: clean(a[F.code]) ?? clean(a[F.sourceid]),
    address: clean(a[F.address]),
    lon: num(a[F.lon]),
    lat: num(a[F.lat]),
    measured_at: epochToYerevan(a[F.startDate] ?? a[F.time]),
    aqi,
    aqi_category: aqiCategory(aqi),
    pm2_5: round(num(a[F.pm25])),
    pm10: round(num(a[F.pm10])),
    no2: round(num(a[F.no2])),
    temperature_c: round(num(a[F.tempInternal]), 1),
    humidity_pct: round(num(a[F.humInternal]), 1),
  };
}

export function registerAirQualityTools(server: McpServer, client: ArcGisClient): void {
  const live = findLayer("air_stations_live")!;
  const forecast = findLayer("air_forecast")!;
  const hourly = findLayer("air_readings_hourly")!;

  server.registerTool(
    "get_air_quality",
    {
      description:
        "Current air quality in Yerevan from the live sensor network (PM2.5, PM10, NO2, US EPA AQI, temperature, humidity). " +
        "Call with a lon/lat to get the nearest station and its reading; call with no location to get a city overview (average AQI + the worst stations right now). " +
        "AQI categories: 0-50 Good, 51-100 Moderate, 101-150 Unhealthy for Sensitive Groups, 151-200 Unhealthy, 201-300 Very Unhealthy, 301+ Hazardous.",
      inputSchema: {
        lon: z.number().optional().describe("Longitude (WGS84) to find the nearest station"),
        lat: z.number().optional().describe("Latitude (WGS84) to find the nearest station"),
      },
    },
    async ({ lon, lat }): Promise<ToolResult> =>
      guard(async () => {
        const { rows } = await client.queryLayer(
          live.servicePath,
          live.layerId,
          { where: "1=1", outFields: "*", returnGeometry: false },
          1000,
        );
        const readings = rows
          .map((r) => toReading(r.attributes))
          .filter((r) => r.lat != null && r.lon != null);

        if (lon != null && lat != null) {
          for (const r of readings) {
            r.distance_m = Math.round(haversineMeters(lon, lat, r.lon!, r.lat!));
          }
          readings.sort((a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity));
          const nearest = readings.slice(0, 3);
          return jsonResult({
            query: { lon, lat },
            nearest_stations: nearest,
            note: "Reading times are Yerevan local (UTC+4).",
          });
        }

        const withAqi = readings.filter((r) => r.aqi != null);
        const avg = withAqi.length
          ? round(withAqi.reduce((s, r) => s + (r.aqi ?? 0), 0) / withAqi.length)
          : null;
        const worst = withAqi.slice().sort((a, b) => (b.aqi ?? 0) - (a.aqi ?? 0)).slice(0, 5);
        const best = withAqi.slice().sort((a, b) => (a.aqi ?? 0) - (b.aqi ?? 0)).slice(0, 3);
        return jsonResult({
          city_overview: {
            stations_reporting: withAqi.length,
            total_stations: readings.length,
            average_aqi: avg,
            average_category: aqiCategory(avg),
          },
          worst_stations: worst,
          cleanest_stations: best,
          note: "Reading times are Yerevan local (UTC+4). AQI is US EPA PM2.5 nowcast.",
        });
      }),
  );

  server.registerTool(
    "get_air_quality_forecast",
    {
      description:
        "Yerevan's predicted city-wide AQI for the coming days (from the portal's Predicted_AQI model). Returns date + predicted AQI + category.",
      inputSchema: {
        days: z.number().int().min(1).max(14).default(7).describe("How many upcoming days to return"),
      },
    },
    async ({ days }): Promise<ToolResult> =>
      guard(async () => {
        const { rows } = await client.queryLayer(
          forecast.servicePath,
          forecast.layerId,
          {
            where: "date_pbl_aqi IS NOT NULL AND aqi IS NOT NULL",
            outFields: "aqi,date_pbl_aqi",
            orderByFields: "date_pbl_aqi ASC",
            returnGeometry: false,
          },
          500,
        );
        const now = Date.now();
        const items = rows
          .map((r) => {
            const aqi = round(num(r.attributes["aqi"]));
            const ms = num(r.attributes["date_pbl_aqi"]);
            return {
              date: epochToYerevan(ms)?.split(" ")[0] ?? null,
              _ms: ms,
              aqi,
              category: aqiCategory(aqi),
            };
          })
          .filter((x) => x._ms != null && x._ms! >= now - 24 * 3600 * 1000)
          .slice(0, days)
          .map(({ _ms, ...rest }) => rest);
        return jsonResult({ forecast: items });
      }),
  );

  server.registerTool(
    "get_station_history",
    {
      description:
        "Historical hourly readings for one air-quality station over the last N hours (PM2.5, PM10, NO2, AQI). Use get_air_quality first to find a station code. Times are Yerevan local (UTC+4).",
      inputSchema: {
        station_code: z.string().describe("Sensor code, e.g. 'AVPH3LF4' (from get_air_quality)"),
        hours: z.number().int().min(1).max(720).default(48).describe("How many recent hours to return"),
      },
    },
    async ({ station_code, hours }): Promise<ToolResult> =>
      guard(async () => {
        const { rows } = await client.queryLayer(
          hourly.servicePath,
          hourly.layerId,
          {
            where: `sourceid='${station_code.replace(/'/g, "''")}' AND startofperiod_date IS NOT NULL`,
            outFields:
              "sourceid,startofperiod_date,pm2_5concmass1hourmean_value,pm2_5concmassnowcastusepaaqi_va,pm10concmass1hourmean_value,no2conc1hourmean_value,temperatureinternal1hourmean_va,relhumidinternal1hourmean_value",
            orderByFields: "startofperiod_date DESC",
            returnGeometry: false,
          },
          hours,
        );
        const series = rows.map((r) => {
          const a = r.attributes;
          const aqi = num(a[F.pm25aqi]);
          return {
            time: epochToYerevan(a[F.startDate]),
            aqi,
            aqi_category: aqiCategory(aqi),
            pm2_5: round(num(a[F.pm25])),
            pm10: round(num(a[F.pm10])),
            no2: round(num(a[F.no2])),
            temperature_c: round(num(a[F.tempInternal]), 1),
            humidity_pct: round(num(a[F.humInternal]), 1),
          };
        });
        return jsonResult({ station_code, points: series.length, series });
      }),
  );
}
