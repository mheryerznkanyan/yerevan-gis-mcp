#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

const server = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
