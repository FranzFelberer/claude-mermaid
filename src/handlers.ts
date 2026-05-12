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
  resolveWorkspace,
  getOpenCommand,
} from "./file-utils.js";
import { listDiagrams, getDiagramInfo, diagramExists, deleteDiagram } from "./diagram-service.js";
import { mcpLogger } from "./logger.js";
import type { Workspace } from "./constants.js";

const execFileAsync = promisify(execFile);

export interface RenderOptions {
  diagram: string;
  workspace: Workspace;
  previewId: string;
  format: string;
  theme: string;
  background: string;
  width: number;
  height: number;
  scale: number;
}

export async function renderDiagram(options: RenderOptions, liveFilePath: string): Promise<void> {
  const { diagram, workspace, previewId, format, theme, background, width, height, scale } =
    options;

  mcpLogger.info(`Rendering diagram: ${workspace}/${previewId}`, {
    format,
    theme,
    width,
    height,
  });

  const tempDir = join(tmpdir(), "claude-mermaid");
  await mkdir(tempDir, { recursive: true });

  const tempName = `diagram-${workspace}-${previewId}`;
  const inputFile = join(tempDir, `${tempName}.mmd`);
  const outputFile = join(tempDir, `${tempName}.${format}`);

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
    mcpLogger.info(`Diagram rendered successfully: ${workspace}/${previewId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderrValue = error instanceof Error && "stderr" in error ? (error as any).stderr : "";
    const stderr = stderrValue ? `\n${stderrValue}` : "";
    mcpLogger.error(`Diagram rendering failed: ${workspace}/${previewId}`, { error: message });
    throw new Error(`${message}${stderr}`);
  }
}

async function setupLivePreview(
  workspace: Workspace,
  previewId: string,
  liveFilePath: string
): Promise<{ serverUrl: string; hasConnections: boolean }> {
  const port = await ensureLiveServer();
  const hasConnections = hasActiveConnections(workspace, previewId);

  await addLiveDiagram(workspace, previewId, liveFilePath);
  const serverUrl = `http://localhost:${port}/${workspace}/${previewId}`;

  if (!hasConnections) {
    mcpLogger.info(`Opening browser for new diagram: ${workspace}/${previewId}`, { serverUrl });
    // If MERMAID_OPEN_APP is set on macOS, route to that app via `open -a`
    // (typically the installed Chrome PWA "Mermaid Diagram Preview (Live)"),
    // so new diagrams land as PWA tabs instead of fresh browser tabs.
    const pwaName = process.env.MERMAID_OPEN_APP;
    let child;
    if (pwaName && process.platform === "darwin") {
      child = spawn("open", ["-a", pwaName, serverUrl], { detached: true, stdio: "ignore" });
    } else {
      const { command, args } = getOpenCommand(serverUrl);
      child = spawn(command, args, { detached: true, stdio: "ignore" });
    }
    child.on("error", (error) => {
      mcpLogger.warn("Failed to open browser", { error: error.message, serverUrl });
    });
    child.unref();
  } else {
    mcpLogger.info(`Reusing existing browser tab for diagram: ${workspace}/${previewId}`);
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

  let workspace: Workspace;
  try {
    workspace = resolveWorkspace(args.workspace as string | undefined);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Invalid workspace: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
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

  const previewDir = getPreviewDir(workspace, previewId);
  await mkdir(previewDir, { recursive: true });
  const liveFilePath = getDiagramFilePath(workspace, previewId, format);

  try {
    await saveDiagramSource(workspace, previewId, diagram, {
      theme,
      background,
      width,
      height,
      scale,
    });
    await renderDiagram(
      { diagram, workspace, previewId, format, theme, background, width, height, scale },
      liveFilePath
    );

    if (format === "svg") {
      const { serverUrl, hasConnections } = await setupLivePreview(
        workspace,
        previewId,
        liveFilePath
      );
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

  let workspace: Workspace;
  try {
    workspace = resolveWorkspace(args.workspace as string | undefined);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Invalid workspace: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
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
    const liveFilePath = getDiagramFilePath(workspace, previewId, format);

    try {
      await access(liveFilePath);
    } catch {
      const diagram = await loadDiagramSource(workspace, previewId);
      const options = await loadDiagramOptions(workspace, previewId);
      await renderDiagram(
        {
          diagram,
          workspace,
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

/**
 * Normalize Mermaid source for safe round-tripping through get/update tools.
 * Mermaid-cli treats actual newlines (0x0A) inside quoted labels as line breaks,
 * but these are ambiguous in plain text (indistinguishable from code-level newlines).
 * Also, literal two-char \n sequences are NOT interpreted by mermaid-cli.
 * This replaces both forms with <br/> inside quoted labels, which is unambiguous
 * and reliably rendered across all mermaid versions.
 */
function normalizeMermaidLineBreaks(source: string): string {
  return source.replace(/"([^"]*?)"/g, (match) =>
    match.replace(/\\n/g, "<br/>").replace(/\n\s*/g, "<br/>")
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function handleListMermaidCharts(args: any = {}) {
  let workspaceFilter: Workspace | undefined;
  if (args.workspace !== undefined && args.workspace !== "") {
    try {
      workspaceFilter = resolveWorkspace(args.workspace as string);
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid workspace: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  try {
    const diagrams = await listDiagrams(workspaceFilter);

    if (diagrams.length === 0) {
      const where = workspaceFilter ? ` in workspace "${workspaceFilter}"` : "";
      return {
        content: [
          {
            type: "text",
            text: `No saved diagrams found${where}. Use mermaid_preview to create a diagram first.`,
          },
        ],
      };
    }

    const diagramList = diagrams
      .map(
        (d) =>
          `- [${d.workspace}] ${d.id} (${d.format.toUpperCase()}, ${formatBytes(d.sizeBytes)}, modified ${d.modifiedAt.toISOString()})`
      )
      .join("\n");

    const header = workspaceFilter
      ? `Found ${diagrams.length} diagram(s) in workspace "${workspaceFilter}":`
      : `Found ${diagrams.length} diagram(s) across all workspaces:`;

    return {
      content: [
        {
          type: "text",
          text: `${header}\n${diagramList}`,
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

  let workspace: Workspace;
  try {
    workspace = resolveWorkspace(args.workspace as string | undefined);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Invalid workspace: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const info = await getDiagramInfo(workspace, previewId);
    if (!info) {
      return {
        content: [
          {
            type: "text",
            text: `Diagram not found: ${workspace}/${previewId}. Use list_mermaid_charts to see available diagrams.`,
          },
        ],
        isError: true,
      };
    }

    const rawSource = await loadDiagramSource(workspace, previewId);
    const source = normalizeMermaidLineBreaks(rawSource);
    const options = await loadDiagramOptions(workspace, previewId);

    return {
      content: [
        {
          type: "text",
          text: [
            `Diagram: ${info.id}`,
            `Workspace: ${info.workspace}`,
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

  let workspace: Workspace;
  try {
    workspace = resolveWorkspace(args.workspace as string | undefined);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Invalid workspace: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const exists = await diagramExists(workspace, previewId);
    if (!exists) {
      return {
        content: [
          {
            type: "text",
            text: `Diagram not found: ${workspace}/${previewId}. Use mermaid_preview to create a new diagram, or list_mermaid_charts to see existing diagrams.`,
          },
        ],
        isError: true,
      };
    }

    const existingSource = await loadDiagramSource(workspace, previewId);
    const existingOptions = await loadDiagramOptions(workspace, previewId);

    const diagram = args.diagram !== undefined ? (args.diagram as string) : existingSource;
    const mergedOptions = {
      theme: args.theme !== undefined ? (args.theme as string) : existingOptions.theme,
      background:
        args.background !== undefined ? (args.background as string) : existingOptions.background,
      width: args.width !== undefined ? (args.width as number) : existingOptions.width,
      height: args.height !== undefined ? (args.height as number) : existingOptions.height,
      scale: args.scale !== undefined ? (args.scale as number) : existingOptions.scale,
    };

    const info = await getDiagramInfo(workspace, previewId);
    const format = info?.format || "svg";

    const previewDir = getPreviewDir(workspace, previewId);
    await mkdir(previewDir, { recursive: true });
    await saveDiagramSource(workspace, previewId, diagram, mergedOptions);

    const liveFilePath = getDiagramFilePath(workspace, previewId, format);
    await renderDiagram(
      { diagram, workspace, previewId, format, ...mergedOptions },
      liveFilePath
    );

    if (format === "svg") {
      await ensureLiveServer();
      await addLiveDiagram(workspace, previewId, liveFilePath);
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
      format === "svg" && hasActiveConnections(workspace, previewId)
        ? "\nBrowser will refresh automatically."
        : "";

    return {
      content: [
        {
          type: "text",
          text: `Diagram "${workspace}/${previewId}" updated successfully.\nUpdated: ${changesText}${reloadNote}`,
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

export async function handleDeleteMermaidChart(args: any) {
  const previewId = args.preview_id as string;

  if (!previewId) {
    throw new Error("preview_id parameter is required");
  }

  let workspace: Workspace;
  try {
    workspace = resolveWorkspace(args.workspace as string | undefined);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Invalid workspace: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }

  try {
    await deleteDiagram(workspace, previewId);

    return {
      content: [
        {
          type: "text",
          text: `Diagram "${workspace}/${previewId}" deleted successfully.`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error deleting diagram: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
