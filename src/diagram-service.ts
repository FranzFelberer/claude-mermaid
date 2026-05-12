/**
 * Diagram Service
 * Single Responsibility: Business logic for diagram data access and management
 */

import { readdir, stat } from "fs/promises";
import {
  getWorkspaceDir,
  validatePreviewId,
  validateWorkspace,
  getDiagramFilePath,
  deleteDiagram as deleteDiagramFiles,
} from "./file-utils.js";
import { DIAGRAM_FORMATS, WORKSPACES, type Workspace } from "./constants.js";
import { DiagramInfo } from "./types.js";
import { webLogger } from "./logger.js";

/**
 * Lists diagrams across all workspaces, or filtered to one workspace.
 * Returns entries sorted by modification time (newest first).
 */
export async function listDiagrams(workspace?: Workspace): Promise<DiagramInfo[]> {
  try {
    if (workspace) {
      return await listWorkspaceDiagrams(workspace);
    }

    // Aggregate across all known workspaces.
    const all: DiagramInfo[] = [];
    for (const ws of WORKSPACES) {
      const entries = await listWorkspaceDiagrams(ws);
      all.push(...entries);
    }
    all.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    webLogger.debug(`Listed ${all.length} diagrams across all workspaces`);
    return all;
  } catch (error) {
    webLogger.error("Failed to list diagrams", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Lists diagrams inside a single workspace directory.
 * Returns empty array if the workspace dir does not exist yet.
 */
async function listWorkspaceDiagrams(workspace: Workspace): Promise<DiagramInfo[]> {
  validateWorkspace(workspace);
  const dir = getWorkspaceDir(workspace);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Workspace dir not created yet — that's fine.
    return [];
  }

  const diagrams: DiagramInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    try {
      validatePreviewId(entry.name);
      const info = await getDiagramInfo(workspace, entry.name);
      if (info) diagrams.push(info);
    } catch (error) {
      webLogger.debug(`Skipping diagram directory: ${workspace}/${entry.name}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  diagrams.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return diagrams;
}

/**
 * Gets detailed information about a specific diagram
 * @param workspace The workspace the diagram lives in
 * @param previewId The diagram ID
 * @returns Diagram info or null if not found
 */
export async function getDiagramInfo(
  workspace: Workspace,
  previewId: string
): Promise<DiagramInfo | null> {
  try {
    validateWorkspace(workspace);
    validatePreviewId(previewId);

    // Try each format to find the diagram
    for (const format of Object.values(DIAGRAM_FORMATS)) {
      try {
        const filePath = getDiagramFilePath(workspace, previewId, format);
        const stats = await stat(filePath);

        return {
          id: previewId,
          workspace,
          format,
          modifiedAt: stats.mtime,
          sizeBytes: stats.size,
        };
      } catch {
        continue;
      }
    }

    webLogger.debug(`Diagram not found: ${workspace}/${previewId}`);
    return null;
  } catch (error) {
    webLogger.error(`Error getting diagram info: ${workspace}/${previewId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Searches diagrams by ID
 * @param query Search query (case-insensitive)
 * @param workspace Optional workspace filter
 * @returns Filtered array of diagram info
 */
export async function searchDiagrams(
  query: string,
  workspace?: Workspace
): Promise<DiagramInfo[]> {
  if (!query || !query.trim()) {
    return listDiagrams(workspace);
  }

  const allDiagrams = await listDiagrams(workspace);
  const normalizedQuery = query.toLowerCase().trim();
  return allDiagrams.filter((diagram) => diagram.id.toLowerCase().includes(normalizedQuery));
}

/**
 * Checks if a diagram exists
 * @param workspace The workspace
 * @param previewId The diagram ID
 * @returns True if diagram exists
 */
export async function diagramExists(
  workspace: Workspace,
  previewId: string
): Promise<boolean> {
  try {
    validateWorkspace(workspace);
    validatePreviewId(previewId);
    const info = await getDiagramInfo(workspace, previewId);
    return info !== null;
  } catch {
    return false;
  }
}

/**
 * Finds which workspace a diagram lives in, by scanning all workspaces.
 * Returns the first match, or null if not found anywhere.
 * Used to locate a diagram when the caller only has its ID (legacy / forgiving lookups).
 */
export async function findDiagramWorkspace(previewId: string): Promise<Workspace | null> {
  try {
    validatePreviewId(previewId);
  } catch {
    return null;
  }
  for (const ws of WORKSPACES) {
    if (await diagramExists(ws, previewId)) return ws;
  }
  return null;
}

/**
 * Gets the count of diagrams (optionally filtered to a workspace)
 */
export async function getDiagramCount(workspace?: Workspace): Promise<number> {
  const diagrams = await listDiagrams(workspace);
  return diagrams.length;
}

/**
 * Deletes a diagram and all its associated files
 */
export async function deleteDiagram(workspace: Workspace, previewId: string): Promise<void> {
  try {
    validateWorkspace(workspace);
    validatePreviewId(previewId);

    const info = await getDiagramInfo(workspace, previewId);
    if (!info) {
      throw new Error(`Diagram not found: ${workspace}/${previewId}`);
    }

    await deleteDiagramFiles(workspace, previewId);
    webLogger.info(`Deleted diagram: ${workspace}/${previewId}`);
  } catch (error) {
    webLogger.error(`Error deleting diagram: ${workspace}/${previewId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

