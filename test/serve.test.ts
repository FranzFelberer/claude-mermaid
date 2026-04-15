import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: Function) =>
    cb(null, { stdout: "", stderr: "" })
  ),
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readdir: vi.fn(),
    access: vi.fn(),
  };
});

vi.mock("../src/live-server.js", () => ({
  ensureLiveServer: vi.fn().mockResolvedValue(3737),
  addLiveDiagram: vi.fn().mockResolvedValue(undefined),
}));

import { readdir, access } from "fs/promises";
import { execFile } from "child_process";
import { ensureLiveServer, addLiveDiagram } from "../src/live-server.js";
import { startServeMode } from "../src/serve.js";

const mockReaddir = vi.mocked(readdir);
const mockAccess = vi.mocked(access);
const mockExecFile = vi.mocked(execFile);
const mockEnsureLiveServer = vi.mocked(ensureLiveServer);
const mockAddLiveDiagram = vi.mocked(addLiveDiagram);

describe("startServeMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureLiveServer.mockResolvedValue(3737);
  });

  it("starts the live server and opens the gallery", async () => {
    mockReaddir.mockResolvedValue([] as any);

    await startServeMode();

    expect(mockEnsureLiveServer).toHaveBeenCalled();
  });

  it("registers existing diagrams that have an SVG file", async () => {
    mockReaddir.mockResolvedValue([
      { name: "flow", isDirectory: () => true },
      { name: "arch", isDirectory: () => true },
    ] as any);
    mockAccess.mockResolvedValue(undefined);

    await startServeMode();

    expect(mockAddLiveDiagram).toHaveBeenCalledTimes(2);
    expect(mockAddLiveDiagram).toHaveBeenCalledWith("flow", expect.stringContaining("diagram.svg"));
    expect(mockAddLiveDiagram).toHaveBeenCalledWith("arch", expect.stringContaining("diagram.svg"));
  });

  it("skips directories without an SVG file", async () => {
    mockReaddir.mockResolvedValue([
      { name: "good", isDirectory: () => true },
      { name: "bad", isDirectory: () => true },
    ] as any);
    mockAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ENOENT"));

    await startServeMode();

    expect(mockAddLiveDiagram).toHaveBeenCalledTimes(1);
    expect(mockAddLiveDiagram).toHaveBeenCalledWith("good", expect.stringContaining("diagram.svg"));
  });

  it("skips non-directory entries", async () => {
    mockReaddir.mockResolvedValue([{ name: "file.txt", isDirectory: () => false }] as any);

    await startServeMode();

    expect(mockAddLiveDiagram).not.toHaveBeenCalled();
  });

  it("handles empty live directory gracefully", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    await startServeMode();

    expect(mockAddLiveDiagram).not.toHaveBeenCalled();
    expect(mockEnsureLiveServer).toHaveBeenCalled();
  });

  it("opens browser by default", async () => {
    mockReaddir.mockResolvedValue([] as any);

    await startServeMode();

    expect(mockExecFile).toHaveBeenCalled();
  });

  it("opens browser when openBrowser is true", async () => {
    mockReaddir.mockResolvedValue([] as any);

    await startServeMode({ openBrowser: true });

    expect(mockExecFile).toHaveBeenCalled();
  });

  it("does not open browser when openBrowser is false", async () => {
    mockReaddir.mockResolvedValue([] as any);

    await startServeMode({ openBrowser: false });

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("still starts server and prints URL when openBrowser is false", async () => {
    mockReaddir.mockResolvedValue([] as any);
    const consoleSpy = vi.spyOn(console, "log");

    await startServeMode({ openBrowser: false });

    expect(mockEnsureLiveServer).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("http://localhost:3737"));
    consoleSpy.mockRestore();
  });
});
