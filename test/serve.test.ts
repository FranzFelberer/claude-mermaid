import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: Function) =>
    cb(null, { stdout: "", stderr: "" })
  ),
}));

vi.mock("../src/live-server.js", () => ({
  ensureLiveServer: vi.fn().mockResolvedValue(3737),
}));

vi.mock("../src/diagram-service.js", () => ({
  getDiagramCount: vi.fn().mockResolvedValue(0),
}));

import { execFile } from "child_process";
import { ensureLiveServer } from "../src/live-server.js";
import { getDiagramCount } from "../src/diagram-service.js";
import { startServeMode } from "../src/serve.js";

const mockExecFile = vi.mocked(execFile);
const mockEnsureLiveServer = vi.mocked(ensureLiveServer);
const mockGetDiagramCount = vi.mocked(getDiagramCount);

describe("startServeMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureLiveServer.mockResolvedValue(3737);
    mockGetDiagramCount.mockResolvedValue(0);
  });

  it("starts the live server", async () => {
    await startServeMode();
    expect(mockEnsureLiveServer).toHaveBeenCalled();
  });

  it("reports diagram count via getDiagramCount", async () => {
    mockGetDiagramCount.mockResolvedValue(5);
    const consoleSpy = vi.spyOn(console, "log");

    await startServeMode({ openBrowser: false });

    expect(mockGetDiagramCount).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("5 diagram"));
    consoleSpy.mockRestore();
  });

  it("opens browser by default", async () => {
    await startServeMode();
    expect(mockExecFile).toHaveBeenCalled();
  });

  it("opens browser when openBrowser is true", async () => {
    await startServeMode({ openBrowser: true });
    expect(mockExecFile).toHaveBeenCalled();
  });

  it("does not open browser when openBrowser is false", async () => {
    await startServeMode({ openBrowser: false });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("still starts server and prints URL when openBrowser is false", async () => {
    const consoleSpy = vi.spyOn(console, "log");

    await startServeMode({ openBrowser: false });

    expect(mockEnsureLiveServer).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("http://localhost:3737"));
    consoleSpy.mockRestore();
  });
});
