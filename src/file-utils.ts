import { readdir, unlink, readFile, writeFile, rmdir } from "fs/promises";
import { join, resolve } from "path";
import { tmpdir } from "os";
import {
  APP_NAME,
  BACKGROUND_REGEX,
  PREVIEW_ID_REGEX,
  UNIX_SYSTEM_PATHS,
  WINDOWS_SYSTEM_PATHS,
  FILE_NAMES,
  DIR_NAMES,
  WORKSPACE_REGEX,
  DEFAULT_WORKSPACE,
} from "./constants.js";
import type { Workspace } from "./constants.js";
import type { DiagramOptions } from "./types.js";

export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return xdg;
  const homeDir = process.env.HOME || process.env.USERPROFILE || tmpdir();
  return join(homeDir, ".config");
}

export function getAppDir(): string {
  return join(getConfigDir(), APP_NAME);
}

export function getLiveDir(): string {
  return join(getAppDir(), DIR_NAMES.LIVE);
}

export function getWorkspaceDir(workspace: Workspace): string {
  validateWorkspace(workspace);
  return join(getLiveDir(), workspace);
}

export function getLogsDir(): string {
  return join(getAppDir(), DIR_NAMES.LOGS);
}

/**
 * Validates that previewId is safe to use in file paths
 * Only allows alphanumeric characters, hyphens, and underscores
 */
export function validatePreviewId(previewId: string): void {
  if (!previewId || !PREVIEW_ID_REGEX.test(previewId)) {
    throw new Error(
      "Invalid preview ID format. Only alphanumeric characters, hyphens, and underscores are allowed."
    );
  }
}

/**
 * Validates a workspace name against the fixed allowlist.
 * Allowlist is intentionally closed (no free-form workspaces) to keep
 * gallery tabs deterministic and avoid spelling drift.
 */
export function validateWorkspace(workspace: string): void {
  if (!workspace || !WORKSPACE_REGEX.test(workspace)) {
    throw new Error(
      `Invalid workspace "${workspace}". Allowed: rocketlink, quartz, personal, default.`
    );
  }
}

/**
 * Normalizes a workspace input: falls back to DEFAULT_WORKSPACE when undefined,
 * otherwise validates and returns the typed value.
 */
export function resolveWorkspace(workspace: string | undefined): Workspace {
  if (workspace === undefined || workspace === "") return DEFAULT_WORKSPACE;
  validateWorkspace(workspace);
  return workspace as Workspace;
}

/**
 * Validates that a background color string is safe to pass as a CLI argument.
 * Accepts CSS named colors, hex, and rgb/rgba/hsl/hsla functions — rejects
 * anything that could be interpreted as a shell metacharacter on Windows,
 * where the child process is launched via `cmd.exe /c`.
 */
export function validateBackground(background: string): void {
  if (!background || !BACKGROUND_REGEX.test(background)) {
    throw new Error(
      "Invalid background color. Use a CSS named color (e.g. 'transparent'), hex (e.g. '#F0F0F0'), or rgb/rgba/hsl/hsla(...)."
    );
  }
}

export function getPreviewDir(workspace: Workspace, previewId: string): string {
  validateWorkspace(workspace);
  validatePreviewId(previewId);
  return join(getLiveDir(), workspace, previewId);
}

export function getDiagramFilePath(
  workspace: Workspace,
  previewId: string,
  format: string
): string {
  return join(getPreviewDir(workspace, previewId), `diagram.${format}`);
}

export function getDiagramSourcePath(workspace: Workspace, previewId: string): string {
  return join(getPreviewDir(workspace, previewId), FILE_NAMES.DIAGRAM_SOURCE);
}

export function getDiagramOptionsPath(workspace: Workspace, previewId: string): string {
  return join(getPreviewDir(workspace, previewId), FILE_NAMES.DIAGRAM_OPTIONS);
}

// Re-export DiagramOptions type from types.ts for backward compatibility
export type { DiagramOptions } from "./types.js";

// Re-export DEFAULT_DIAGRAM_OPTIONS from constants.ts for backward compatibility
export { DEFAULT_DIAGRAM_OPTIONS } from "./constants.js";

export async function saveDiagramSource(
  workspace: Workspace,
  previewId: string,
  diagram: string,
  options: DiagramOptions
): Promise<void> {
  const sourcePath = getDiagramSourcePath(workspace, previewId);
  const optionsPath = getDiagramOptionsPath(workspace, previewId);
  await writeFile(sourcePath, diagram, "utf-8");
  await writeFile(optionsPath, JSON.stringify(options, null, 2), "utf-8");
}

export async function loadDiagramSource(
  workspace: Workspace,
  previewId: string
): Promise<string> {
  const sourcePath = getDiagramSourcePath(workspace, previewId);
  return await readFile(sourcePath, "utf-8");
}

export async function loadDiagramOptions(
  workspace: Workspace,
  previewId: string
): Promise<DiagramOptions> {
  const optionsPath = getDiagramOptionsPath(workspace, previewId);
  const content = await readFile(optionsPath, "utf-8");
  return JSON.parse(content);
}

/**
 * Helper function to delete a directory and all its contents
 * @param dirPath - The absolute path to the directory to delete
 */
async function deleteDiagramDirectory(dirPath: string): Promise<void> {
  const files = await readdir(dirPath);
  for (const file of files) {
    await unlink(join(dirPath, file));
  }
  await rmdir(dirPath);
}

export async function deleteDiagram(workspace: Workspace, previewId: string): Promise<void> {
  validateWorkspace(workspace);
  validatePreviewId(previewId);
  const dirPath = getPreviewDir(workspace, previewId);

  try {
    await deleteDiagramDirectory(dirPath);
  } catch (error) {
    throw new Error(
      `Failed to delete diagram: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Validates a save path to prevent path traversal and writing to sensitive locations
 * @param savePath - The path where the user wants to save the file
 * @throws Error if the path is invalid or dangerous
 */
export function validateSavePath(savePath: string): void {
  // Check for null bytes (potential security issue)
  if (savePath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }

  // Resolve to absolute path
  const absolutePath = resolve(savePath);

  // Prevent writing to sensitive system directories (Unix/Linux/macOS)
  if (
    process.platform !== "win32" &&
    UNIX_SYSTEM_PATHS.some((danger) => absolutePath.startsWith(danger))
  ) {
    throw new Error("Cannot write to system directories");
  }

  // Prevent writing to Windows system directories
  if (process.platform === "win32") {
    const normalizedPath = absolutePath.replace(/\//g, "\\");
    if (WINDOWS_SYSTEM_PATHS.some((danger) => normalizedPath.startsWith(danger))) {
      throw new Error("Cannot write to system directories");
    }
  }
}

export interface OpenCommand {
  command: string;
  args: string[];
}

export function getOpenCommand(url: string): OpenCommand {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "cmd.exe", args: ["/c", "start", "", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}
