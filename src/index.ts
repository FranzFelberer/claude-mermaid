#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  handleMermaidPreview,
  handleMermaidSave,
  handleListMermaidCharts,
  handleGetMermaidChart,
  handleUpdateMermaidChart,
} from "./handlers.js";
import { mcpLogger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(await readFile(join(__dirname, "../package.json"), "utf-8"));
const VERSION = packageJson.version;

if (process.argv.includes("-v") || process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

const isServeMode = process.argv.includes("--serve");

if (isServeMode) {
  const noBrowser = process.argv.includes("--no-browser");
  const { startServeMode } = await import("./serve.js");
  await startServeMode({ openBrowser: !noBrowser });
}

const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "mermaid_preview",
    description:
      "Render a Mermaid diagram and open it in browser with live reload. " +
      "Takes Mermaid diagram code as input and generates a live preview. " +
      "Supports themes (default, forest, dark, neutral), custom backgrounds, dimensions, and quality scaling. " +
      "The diagram will auto-refresh when updated. Use mermaid_save to save to disk. " +
      "IMPORTANT: Automatically use this tool whenever you create a Mermaid diagram for the user. " +
      "NOTE: Sequence diagrams do not support style directives - avoid using 'style' statements in sequenceDiagram. " +
      "LINE BREAKS: Use <br/> for line breaks in node labels, NOT \\n (mermaid-cli does not interpret literal \\n as line breaks).",
    inputSchema: {
      type: "object",
      properties: {
        diagram: {
          type: "string",
          description: "The Mermaid diagram code to render",
        },
        preview_id: {
          type: "string",
          description:
            "ID for this preview session. Use different IDs for multiple diagrams (e.g., 'architecture', 'flow', 'sequence').",
        },
        format: {
          type: "string",
          enum: ["png", "svg", "pdf"],
          description: "Output format (default: svg)",
          default: "svg",
        },
        theme: {
          type: "string",
          enum: ["default", "forest", "dark", "neutral"],
          description: "Theme of the chart (default: default)",
          default: "default",
        },
        background: {
          type: "string",
          description:
            "Background color for pngs/svgs. Example: transparent, red, '#F0F0F0' (default: white)",
          default: "white",
        },
        width: {
          type: "number",
          description: "Diagram width in pixels (default: 800)",
          default: 800,
        },
        height: {
          type: "number",
          description: "Diagram height in pixels (default: 600)",
          default: 600,
        },
        scale: {
          type: "number",
          description: "Scale factor for higher quality output (default: 2)",
          default: 2,
        },
      },
      required: ["diagram", "preview_id"],
    },
  },
  {
    name: "mermaid_save",
    description:
      "Save the current live Mermaid diagram to a file path. " +
      "This copies the already-rendered diagram from the live preview to the specified location. " +
      "Use this after tuning your diagram with mermaid_preview.",
    inputSchema: {
      type: "object",
      properties: {
        save_path: {
          type: "string",
          description: "Path to save the diagram file (e.g., './docs/diagram.svg')",
        },
        preview_id: {
          type: "string",
          description:
            "ID of the preview to save. Must match the preview_id used in mermaid_preview.",
        },
        format: {
          type: "string",
          enum: ["png", "svg", "pdf"],
          description:
            "Output format (default: svg). Must match the format used in mermaid_preview.",
          default: "svg",
        },
      },
      required: ["save_path", "preview_id"],
    },
  },
  {
    name: "list_mermaid_charts",
    description:
      "List all saved Mermaid diagrams. " +
      "Returns diagram IDs, formats, modification times, and file sizes. " +
      "Use this to see what diagrams are available before using get_mermaid_chart or update_mermaid_chart.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_mermaid_chart",
    description:
      "Get details of a specific saved Mermaid diagram. " +
      "Returns the Mermaid source code, rendering options (theme, background, dimensions, scale), " +
      "format, modification time, and file size. " +
      "The returned source normalizes line breaks in node labels to <br/> for unambiguous round-tripping.",
    inputSchema: {
      type: "object",
      properties: {
        preview_id: {
          type: "string",
          description:
            "ID of the diagram to retrieve. Use list_mermaid_charts to find available IDs.",
        },
      },
      required: ["preview_id"],
    },
  },
  {
    name: "update_mermaid_chart",
    description:
      "Update an existing Mermaid diagram's source code and/or rendering options. " +
      "Only provided parameters are changed; omitted parameters keep their current values. " +
      "The diagram must already exist (use mermaid_preview to create new diagrams). " +
      "Re-renders the diagram and triggers live reload if a browser tab is connected. " +
      "Does NOT open a new browser tab. " +
      "LINE BREAKS: Use <br/> for line breaks in node labels, NOT \\n (mermaid-cli does not interpret literal \\n as line breaks).",
    inputSchema: {
      type: "object",
      properties: {
        preview_id: {
          type: "string",
          description: "ID of the existing diagram to update. Must already exist.",
        },
        diagram: {
          type: "string",
          description: "New Mermaid diagram source code. If omitted, the existing source is kept.",
        },
        theme: {
          type: "string",
          enum: ["default", "forest", "dark", "neutral"],
          description: "Theme of the chart. If omitted, the existing theme is kept.",
        },
        background: {
          type: "string",
          description: "Background color. If omitted, the existing background is kept.",
        },
        width: {
          type: "number",
          description: "Diagram width in pixels. If omitted, the existing width is kept.",
        },
        height: {
          type: "number",
          description: "Diagram height in pixels. If omitted, the existing height is kept.",
        },
        scale: {
          type: "number",
          description: "Scale factor. If omitted, the existing scale is kept.",
        },
      },
      required: ["preview_id"],
    },
  },
];

const server = new Server(
  {
    name: "claude-mermaid",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  mcpLogger.debug("ListTools request received");
  return { tools: TOOL_DEFINITIONS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments;

  mcpLogger.info(`CallTool request: ${toolName}`);

  try {
    let result;
    switch (toolName) {
      case "mermaid_preview":
        result = await handleMermaidPreview(args);
        mcpLogger.info(`CallTool completed: ${toolName}`);
        return result;
      case "mermaid_save":
        result = await handleMermaidSave(args);
        mcpLogger.info(`CallTool completed: ${toolName}`);
        return result;
      case "list_mermaid_charts":
        result = await handleListMermaidCharts();
        mcpLogger.info(`CallTool completed: ${toolName}`);
        return result;
      case "get_mermaid_chart":
        result = await handleGetMermaidChart(args);
        mcpLogger.info(`CallTool completed: ${toolName}`);
        return result;
      case "update_mermaid_chart":
        result = await handleUpdateMermaidChart(args);
        mcpLogger.info(`CallTool completed: ${toolName}`);
        return result;
      default:
        mcpLogger.error(`Unknown tool: ${toolName}`);
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    mcpLogger.error(`Tool ${toolName} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
});

async function main() {
  mcpLogger.info("MCP Server starting", { version: VERSION });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpLogger.info("MCP Server connected via stdio");
  console.error("Claude Mermaid MCP Server running on stdio");
}

if (!isServeMode) {
  main().catch((error) => {
    mcpLogger.error("Fatal error during startup", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
