/**
 * Route Handlers
 * Single Responsibility: HTTP route handling logic
 * Open/Closed: Easy to add new routes without modifying existing handlers
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { URL } from "url";
import { RouteContext } from "./types.js";
import { renderPage } from "./page-renderer.js";
import { listDiagrams, deleteDiagram } from "./diagram-service.js";
import { resolveWorkspace } from "./file-utils.js";
import {
  ROUTES,
  CONTENT_TYPES,
  CSP_HEADER,
  CACHE_CONTROL,
  TEMPLATE_FILES,
  ASSET_FILES,
  WORKSPACE_REGEX,
  PREVIEW_ID_REGEX,
  type Workspace,
} from "./constants.js";
import { webLogger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PREVIEW_DIR = join(__dirname, "preview");

/**
 * Serves a static file
 */
async function serveStaticFile(
  filePath: string,
  contentType: string,
  cacheControl: string = CACHE_CONTROL.NO_STORE
): Promise<{ content: Buffer | string; contentType: string; cacheControl: string }> {
  const content = await readFile(filePath, contentType.includes("text") ? "utf-8" : undefined);
  return { content: content as Buffer | string, contentType, cacheControl };
}

/**
 * Gallery Page Handler
 * Renders the main gallery page
 */
export async function handleGallery(context: RouteContext): Promise<void> {
  const { res, port } = context;

  try {
    webLogger.debug("Gallery page request");

    const html = await renderPage(
      TEMPLATE_FILES.GALLERY,
      { PORT: port },
      {
        title: "Diagram Gallery - Claude Mermaid",
        styles: [ROUTES.SHARED_STYLE, ROUTES.GALLERY_STYLE],
        scripts: [ROUTES.GALLERY_SCRIPT],
        includeNav: false, // Gallery has its own header
        includeFooter: false,
      }
    );

    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES.HTML,
      "Content-Security-Policy": CSP_HEADER,
    });
    res.end(html);

    webLogger.info("Served gallery page");
  } catch (error) {
    webLogger.error("Failed to serve gallery page", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.writeHead(500, { "Content-Type": CONTENT_TYPES.PLAIN });
    res.end(`Error loading gallery: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * API: List Diagrams
 * Returns JSON list of all diagrams (optionally filtered by ?workspace=...)
 */
export async function handleApiDiagrams(context: RouteContext): Promise<void> {
  const { res, url } = context;

  let workspaceFilter: Workspace | undefined;
  try {
    // url here may be "/api/diagrams?workspace=rocketlink" — parse query.
    const parsed = new URL(url, "http://localhost");
    const wsParam = parsed.searchParams.get("workspace");
    if (wsParam) {
      workspaceFilter = resolveWorkspace(wsParam);
    }
  } catch (error) {
    res.writeHead(400, { "Content-Type": CONTENT_TYPES.JSON });
    res.end(
      JSON.stringify({
        error: "Invalid workspace parameter",
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return;
  }

  try {
    webLogger.debug("API request: list diagrams", { workspace: workspaceFilter });

    const diagrams = await listDiagrams(workspaceFilter);

    const response = {
      diagrams,
      count: diagrams.length,
    };

    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES.JSON,
      "Cache-Control": CACHE_CONTROL.NO_STORE,
    });
    res.end(JSON.stringify(response));

    webLogger.info(`API: Listed ${diagrams.length} diagrams`, {
      workspace: workspaceFilter,
    });
  } catch (error) {
    webLogger.error("API error: list diagrams", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.writeHead(500, { "Content-Type": CONTENT_TYPES.JSON });
    res.end(
      JSON.stringify({
        error: "Failed to list diagrams",
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

/**
 * API: Delete Diagram
 * Handles deletion of individual diagrams. Path: /api/diagrams/<workspace>/<id>
 */
export async function handleApiDiagramDelete(context: RouteContext): Promise<void> {
  const { req, res, url } = context;

  // Strip any query string before matching paths.
  const path = url.split("?")[0];

  // If it's exactly /api/diagrams, delegate to the list handler
  if (path === "/api/diagrams") {
    return handleApiDiagrams(context);
  }

  // Check for delete action: DELETE /api/diagrams/<workspace>/<id>
  const deleteMatch = path.match(/^\/api\/diagrams\/([^\/]+)\/([^\/]+)$/);
  if (deleteMatch) {
    if (req.method !== "DELETE") {
      res.writeHead(405, { "Content-Type": CONTENT_TYPES.JSON });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const workspaceRaw = deleteMatch[1];
    const diagramId = deleteMatch[2];

    if (!WORKSPACE_REGEX.test(workspaceRaw) || !PREVIEW_ID_REGEX.test(diagramId)) {
      res.writeHead(400, { "Content-Type": CONTENT_TYPES.JSON });
      res.end(JSON.stringify({ error: "Invalid workspace or diagram id" }));
      return;
    }
    const workspace = workspaceRaw as Workspace;

    try {
      webLogger.debug(`API request: delete diagram ${workspace}/${diagramId}`);

      await deleteDiagram(workspace, diagramId);

      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES.JSON,
        "Cache-Control": CACHE_CONTROL.NO_STORE,
      });
      res.end(JSON.stringify({ success: true }));

      webLogger.info(`API: Deleted diagram ${workspace}/${diagramId}`);
    } catch (error) {
      webLogger.error("API error: delete diagram", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.writeHead(500, { "Content-Type": CONTENT_TYPES.JSON });
      res.end(
        JSON.stringify({
          error: "Failed to delete diagram",
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }
    return;
  }

  // No match found
  res.writeHead(404, { "Content-Type": CONTENT_TYPES.JSON });
  res.end(JSON.stringify({ error: "Not found" }));
}

/**
 * Static Asset Handlers
 */

export async function handleSharedCss(context: RouteContext): Promise<void> {
  const { res } = context;
  try {
    const { content, contentType, cacheControl } = await serveStaticFile(
      join(PREVIEW_DIR, ASSET_FILES.SHARED_STYLE),
      CONTENT_TYPES.CSS
    );
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
    });
    res.end(content);
  } catch (error) {
    webLogger.error("Failed to serve shared.css", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.writeHead(404, { "Content-Type": CONTENT_TYPES.PLAIN });
    res.end("Not found");
  }
}

export async function handleGalleryCss(context: RouteContext): Promise<void> {
  const { res } = context;
  try {
    const { content, contentType, cacheControl } = await serveStaticFile(
      join(PREVIEW_DIR, ASSET_FILES.GALLERY_STYLE),
      CONTENT_TYPES.CSS
    );
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
    });
    res.end(content);
  } catch (error) {
    webLogger.error("Failed to serve gallery.css", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.writeHead(404, { "Content-Type": CONTENT_TYPES.PLAIN });
    res.end("Not found");
  }
}

export async function handleGalleryJs(context: RouteContext): Promise<void> {
  const { res } = context;
  try {
    const { content, contentType, cacheControl } = await serveStaticFile(
      join(PREVIEW_DIR, ASSET_FILES.GALLERY_SCRIPT),
      CONTENT_TYPES.JAVASCRIPT
    );
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
    });
    res.end(content);
  } catch (error) {
    webLogger.error("Failed to serve gallery.js", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.writeHead(404, { "Content-Type": CONTENT_TYPES.PLAIN });
    res.end("Not found");
  }
}

export async function handleManifest(context: RouteContext): Promise<void> {
  const { res } = context;
  try {
    const { content, contentType, cacheControl } = await serveStaticFile(
      join(PREVIEW_DIR, ASSET_FILES.MANIFEST),
      CONTENT_TYPES.MANIFEST
    );
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
    });
    res.end(content);
  } catch (error) {
    webLogger.error("Failed to serve manifest.json", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.writeHead(404, { "Content-Type": CONTENT_TYPES.PLAIN });
    res.end("Not found");
  }
}

/**
 * Route Configuration
 * Maps routes to their handlers
 */
export interface Route {
  path: string;
  exact?: boolean;
  handler: (context: RouteContext) => Promise<void>;
}

export const ROUTE_CONFIG: Route[] = [
  { path: ROUTES.ROOT, exact: true, handler: handleGallery },
  { path: ROUTES.API_DIAGRAMS, handler: handleApiDiagramDelete }, // Handles /api/diagrams/* including exact match
  { path: ROUTES.SHARED_STYLE, exact: true, handler: handleSharedCss },
  { path: ROUTES.GALLERY_STYLE, exact: true, handler: handleGalleryCss },
  { path: ROUTES.GALLERY_SCRIPT, exact: true, handler: handleGalleryJs },
  { path: ROUTES.MANIFEST, exact: true, handler: handleManifest },
];

/**
 * Matches a URL to a route configuration
 * @param url Request URL
 * @returns Matched route or null
 */
export function matchRoute(url: string): Route | null {
  for (const route of ROUTE_CONFIG) {
    if (route.exact) {
      if (url === route.path) {
        return route;
      }
    } else {
      if (url.startsWith(route.path)) {
        return route;
      }
    }
  }
  return null;
}
