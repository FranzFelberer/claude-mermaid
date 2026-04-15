import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, copyFile, access } from "fs/promises";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { ensureLiveServer, addLiveDiagram, hasActiveConnections } from "./live-server.js";
import {
  getDiagramFilePath,
  getPreviewDir,
  saveDiagramSource,
  loadDiagramSource,
  loadDiagramOptions,
  validateBackground,
  validateSavePath,
  getOpenCommand,
} from "./file-utils.js";
import { listDiagrams, getDiagramInfo, diagramExists } from "./diagram-service.js";
import { mcpLogger } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface RenderOptions {
  diagram: string;
  previewId: string;
  format: string;
  theme: string;
  background: string;
  width: number;
  height: number;
  scale: number;
}

export async function renderDiagram(options: RenderOptions, liveFilePath: string): Promise<void> {
  const { diagram, previewId, format, theme, background, width, height, scale } = options;

  mcpLogger.info(`Rendering diagram: ${previewId}`, { format, theme, width, height });

  const tempDir = join(tmpdir(), "claude-mermaid");
  await mkdir(tempDir, { recursive: true });

  const inputFile = join(tempDir, `diagram-${previewId}.mmd`);
  const outputFile = join(tempDir, `diagram-${previewId}.${format}`);

  await writeFile(inputFile, diagram, "utf-8");

  const args = [
    "-y",
    "@mermaid-js/mermaid-cli",
    "-i",
    inputFile,
    "-o",
    outputFile,
    "-t",
    theme,
    "-b",
    background,
    "-w",
    width.toString(),
    "-H",
    height.toString(),
    "-s",
    scale.toString(),
  ];

  if (format === "pdf") {
    args.push("--pdfFit");
  }

  mcpLogger.debug(`Executing mermaid-cli`, { args });

  try {
    // On Windows, `execFile`/`spawn` cannot invoke `npx` directly: the real
    // binary is `npx.cmd`, and Node no longer allows direct spawn of `.cmd`
    // files (see CVE-2024-27980 / spawn EINVAL). `{ shell: true }` would work
    // but is deprecated in Node 24+ (DEP0190) because args aren't escaped.
    // The Node-documented pattern is to go through `cmd.exe /c` explicitly.
    // See: https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
    const isWin = process.platform === "win32";
    const command = isWin ? "cmd.exe" : "npx";
    const finalArgs = isWin ? ["/c", "npx", ...args] : args;
    const { stdout, stderr } = await execFileAsync(command, finalArgs);
    if (stderr) {
      mcpLogger.debug(`mermaid-cli stderr`, { stderr });
    }
    await copyFile(outputFile, liveFilePath);
    mcpLogger.info(`Diagram rendered successfully: ${previewId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderrValue = error instanceof Error && "stderr" in error ? (error as any).stderr : "";
    const stderr = stderrValue ? `\n${stderrValue}` : "";
    mcpLogger.error(`Diagram rendering failed: ${previewId}`, { error: message });
    throw new Error(`${message}${stderr}`);
  }
}

async function setupLivePreview(
  previewId: string,
  liveFilePath: string
): Promise<{ serverUrl: string; hasConnections: boolean }> {
  const port = await ensureLiveServer();
  const hasConnections = hasActiveConnections(previewId);

  await addLiveDiagram(previewId, liveFilePath);
  const serverUrl = `http://localhost:${port}/${previewId}`;

  if (!hasConnections) {
    mcpLogger.info(`Opening browser for new diagram: ${previewId}`, { serverUrl });
    const { command, args } = getOpenCommand(serverUrl);
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", (error) => {
      mcpLogger.warn("Failed to open browser", { error: error.message, serverUrl });
    });
    child.unref();
  } else {
    mcpLogger.info(`Reusing existing browser tab for diagram: ${previewId}`);
  }

  return { serverUrl, hasConnections };
}

function createLivePreviewResponse(
  liveFilePath: string,
  format: string,
  serverUrl: string,
  hasConnections: boolean
): any {
  const actionMessage = hasConnections
    ? `Mermaid diagram updated successfully.`
    : `Mermaid diagram rendered successfully and opened in browser.`;

  const liveMessage = hasConnections
    ? `\nDiagram updated. Browser will refresh automatically.`
    : `\nLive reload URL: ${serverUrl}\nThe diagram will auto-refresh when you update it.`;

  return {
    content: [
      {
        type: "text",
        text: `${actionMessage}\nWorking file: ${liveFilePath} (${format.toUpperCase()})${liveMessage}`,
      },
    ],
  };
}

function createStaticRenderResponse(liveFilePath: string, format: string): any {
  return {
    content: [
      {
        type: "text",
        text: `Mermaid diagram rendered successfully.\nWorking file: ${liveFilePath} (${format.toUpperCase()})\n\nNote: Live preview is only available for SVG format. Use mermaid_save to save this diagram to a permanent location.`,
      },
    ],
  };
}

export async function handleMermaidPreview(args: any) {
  const diagram = args.diagram as string;
  const previewId = args.preview_id as string;
  const format = (args.format as string) || "svg";
  const theme = (args.theme as string) || "default";
  const background = (args.background as string) || "white";
  const width = (args.width as number) || 800;
  const height = (args.height as number) || 600;
  const scale = (args.scale as number) || 2;

  if (!diagram) {
    throw new Error("diagram parameter is required");
  }
  if (!previewId) {
    throw new Error("preview_id parameter is required");
  }

  try {
    validateBackground(background);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Invalid background: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }

  const previewDir = getPreviewDir(previewId);
  await mkdir(previewDir, { recursive: true });
  const liveFilePath = getDiagramFilePath(previewId, format);

  try {
    await saveDiagramSource(previewId, diagram, { theme, background, width, height, scale });
    await renderDiagram(
      { diagram, previewId, format, theme, background, width, height, scale },
      liveFilePath
    );

    if (format === "svg") {
      const { serverUrl, hasConnections } = await setupLivePreview(previewId, liveFilePath);
      return createLivePreviewResponse(liveFilePath, format, serverUrl, hasConnections);
    } else {
      return createStaticRenderResponse(liveFilePath, format);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error rendering Mermaid diagram: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleMermaidSave(args: any) {
  const savePath = args.save_path as string;
  const previewId = args.preview_id as string;
  const format = (args.format as string) || "svg";

  if (!savePath) {
    throw new Error("save_path parameter is required");
  }
  if (!previewId) {
    throw new Error("preview_id parameter is required");
  }

  // Validate save path to prevent path traversal attacks
  try {
    validateSavePath(savePath);
  } catch (error) {
    mcpLogger.error("Save path validation failed", {
      savePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      content: [
        {
          type: "text",
          text: `Invalid save path: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const liveFilePath = getDiagramFilePath(previewId, format);

    try {
      await access(liveFilePath);
    } catch {
      const diagram = await loadDiagramSource(previewId);
      const options = await loadDiagramOptions(previewId);
      await renderDiagram(
        {
          diagram,
          previewId,
          format,
          ...options,
        },
        liveFilePath
      );
    }

    const saveDir = dirname(savePath);
    await mkdir(saveDir, { recursive: true });
    await copyFile(liveFilePath, savePath);

    return {
      content: [
        {
          type: "text",
          text: `Diagram saved to: ${savePath} (${format.toUpperCase()})`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error saving diagram: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function handleListMermaidCharts() {
  try {
    const diagrams = await listDiagrams();

    if (diagrams.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No saved diagrams found. Use mermaid_preview to create a diagram first.",
          },
        ],
      };
    }

    const diagramList = diagrams
      .map(
        (d) =>
          `- ${d.id} (${d.format.toUpperCase()}, ${formatBytes(d.sizeBytes)}, modified ${d.modifiedAt.toISOString()})`
      )
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${diagrams.length} diagram(s):\n${diagramList}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error listing diagrams: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleGetMermaidChart(args: any) {
  const previewId = args.preview_id as string;

  if (!previewId) {
    throw new Error("preview_id parameter is required");
  }

  try {
    const info = await getDiagramInfo(previewId);
    if (!info) {
      return {
        content: [
          {
            type: "text",
            text: `Diagram not found: ${previewId}. Use list_mermaid_charts to see available diagrams.`,
          },
        ],
        isError: true,
      };
    }

    const source = await loadDiagramSource(previewId);
    const options = await loadDiagramOptions(previewId);

    return {
      content: [
        {
          type: "text",
          text: [
            `Diagram: ${info.id}`,
            `Format: ${info.format.toUpperCase()}`,
            `Size: ${formatBytes(info.sizeBytes)}`,
            `Modified: ${info.modifiedAt.toISOString()}`,
            `Theme: ${options.theme}`,
            `Background: ${options.background}`,
            `Dimensions: ${options.width}x${options.height}`,
            `Scale: ${options.scale}`,
            ``,
            `Source:`,
            "```mermaid",
            source,
            "```",
          ].join("\n"),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error getting diagram: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleUpdateMermaidChart(args: any) {
  const previewId = args.preview_id as string;

  if (!previewId) {
    throw new Error("preview_id parameter is required");
  }

  try {
    const exists = await diagramExists(previewId);
    if (!exists) {
      return {
        content: [
          {
            type: "text",
            text: `Diagram not found: ${previewId}. Use mermaid_preview to create a new diagram, or list_mermaid_charts to see existing diagrams.`,
          },
        ],
        isError: true,
      };
    }

    const existingSource = await loadDiagramSource(previewId);
    const existingOptions = await loadDiagramOptions(previewId);

    const diagram = args.diagram !== undefined ? (args.diagram as string) : existingSource;
    const mergedOptions = {
      theme: args.theme !== undefined ? (args.theme as string) : existingOptions.theme,
      background:
        args.background !== undefined ? (args.background as string) : existingOptions.background,
      width: args.width !== undefined ? (args.width as number) : existingOptions.width,
      height: args.height !== undefined ? (args.height as number) : existingOptions.height,
      scale: args.scale !== undefined ? (args.scale as number) : existingOptions.scale,
    };

    const info = await getDiagramInfo(previewId);
    const format = info?.format || "svg";

    const previewDir = getPreviewDir(previewId);
    await mkdir(previewDir, { recursive: true });
    await saveDiagramSource(previewId, diagram, mergedOptions);

    const liveFilePath = getDiagramFilePath(previewId, format);
    await renderDiagram({ diagram, previewId, format, ...mergedOptions }, liveFilePath);

    if (format === "svg") {
      await ensureLiveServer();
      await addLiveDiagram(previewId, liveFilePath);
    }

    const changes: string[] = [];
    if (args.diagram !== undefined) changes.push("source code");
    if (args.theme !== undefined) changes.push(`theme → ${mergedOptions.theme}`);
    if (args.background !== undefined) changes.push(`background → ${mergedOptions.background}`);
    if (args.width !== undefined) changes.push(`width → ${mergedOptions.width}`);
    if (args.height !== undefined) changes.push(`height → ${mergedOptions.height}`);
    if (args.scale !== undefined) changes.push(`scale → ${mergedOptions.scale}`);

    const changesText = changes.length > 0 ? changes.join(", ") : "no changes";
    const reloadNote =
      format === "svg" && hasActiveConnections(previewId)
        ? "\nBrowser will refresh automatically."
        : "";

    return {
      content: [
        {
          type: "text",
          text: `Diagram "${previewId}" updated successfully.\nUpdated: ${changesText}${reloadNote}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error updating diagram: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
