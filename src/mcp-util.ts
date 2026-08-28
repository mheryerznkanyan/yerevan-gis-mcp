import { ArcGisError } from "./arcgis.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Turn any thrown error into a readable, model-friendly tool error. */
export function toToolError(err: unknown): ToolResult {
  if (err instanceof ArcGisError) {
    switch (err.kind) {
      case "restricted":
        return errorResult(
          `This layer is access-restricted on the portal (token required). It cannot be read anonymously. ${err.message}`,
        );
      case "not_found":
        return errorResult(
          `Not found: ${err.message}. Check the service path and layer id — many Yerevan layers are NOT layer 0 (e.g. forests=21, groundwater=16, monuments=70/71).`,
        );
      case "network":
        return errorResult(err.message);
      default:
        return errorResult(`ArcGIS request failed: ${err.message}`);
    }
  }
  return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
}

/** Wrap an async tool handler so it never throws out of the MCP server. */
export function guard(
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  return fn().catch(toToolError);
}
