/**
 * Standalone server mode (--serve)
 * Starts the live server without the MCP stdio transport,
 * registers existing diagrams, and opens the gallery in the browser.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { ensureLiveServer } from "./live-server.js";
import { getOpenCommand } from "./file-utils.js";
import { getDiagramCount } from "./diagram-service.js";

const execFileAsync = promisify(execFile);

export interface ServeModeOptions {
  openBrowser?: boolean;
}

export async function startServeMode(options: ServeModeOptions = {}): Promise<void> {
  const { openBrowser = true } = options;

  // ensureLiveServer() restores all on-disk diagrams across workspaces into
  // the in-memory registry, so we don't need a separate registration step here.
  const port = await ensureLiveServer();
  const galleryUrl = `http://localhost:${port}/`;
  const diagramCount = await getDiagramCount();

  console.log(`Serving ${diagramCount} diagram(s) at ${galleryUrl}`);

  if (openBrowser) {
    const { command, args } = getOpenCommand(galleryUrl);
    try {
      await execFileAsync(command, args);
    } catch {
      console.warn(`Could not open browser automatically. Open ${galleryUrl} manually.`);
    }
  }
}
