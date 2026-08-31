import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArcGisClient } from "./arcgis.js";
import { registerGenericTools } from "./tools/generic.js";
import { registerAirQualityTools } from "./tools/airquality.js";
import { registerCadastreTools } from "./tools/cadastre.js";
import { registerTransportTools } from "./tools/transport.js";
import { registerAmenityTools } from "./tools/amenities.js";
import { registerPortalTools } from "./tools/portal.js";
import { registerYandexTransitTools } from "./tools/yandex-transit.js";

export interface BuildServerOptions {
  client?: ArcGisClient;
}

/**
 * Build the Yerevan GIS MCP server. Two layers of tools share one ArcGisClient:
 *  - a generic ArcGIS toolbox (search_layers, describe_layer, query_layer,
 *    query_near_point, count_features, get_distinct_values, aggregate,
 *    get_map_image, list_service_layers) that can reach ANY of the portal's
 *    ~190 open layers;
 *  - curated domain tools over the best datasets (air quality, cadastre/zoning/
 *    construction, transport/addressing, and the portal's public apps).
 *
 * Everything is READ-ONLY. The portal exposes a few layers with anonymous write
 * capability; this server never calls applyEdits.
 */
export function buildServer(opts: BuildServerOptions = {}): McpServer {
  const client = opts.client ?? new ArcGisClient();

  const server = new McpServer({
    name: "yerevan-gis-mcp",
    version: "1.0.0",
  });

  registerGenericTools(server, client);
  registerAirQualityTools(server, client);
  registerCadastreTools(server, client);
  registerTransportTools(server, client);
  registerAmenityTools(server, client);
  registerPortalTools(server, client);
  registerYandexTransitTools(server);

  return server;
}
