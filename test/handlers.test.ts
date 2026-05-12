import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleMermaidPreview,
  handleMermaidSave,
  handleListMermaidCharts,
  handleGetMermaidChart,
  handleUpdateMermaidChart,
  handleDeleteMermaidChart,
} from "../src/handlers.js";
import {
  getPreviewDir,
  getDiagramFilePath,
  loadDiagramSource,
  loadDiagramOptions,
} from "../src/file-utils.js";
import { readdir, unlink, access } from "fs/promises";
import { execFile } from "child_process";
import { setupTestEnvWithPreview, restoreTestEnv } from "./helpers/env-helpers.js";

// Mock child_process to avoid actually running mmdc and opening browser
vi.mock("child_process", () => ({
  execFile: vi.fn((_file: string, args: string[], callback: Function) => {
    const outputIndex = args.indexOf("-o");
    if (outputIndex !== -1 && outputIndex + 1 < args.length) {
      const outputFile = args[outputIndex + 1];
      const fs = require("fs");
      const path = require("path");
      const dir = path.dirname(outputFile);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const ext = path.extname(outputFile);
      if (ext === ".svg") {
        fs.writeFileSync(outputFile, "<svg>test</svg>", "utf-8");
      } else if (ext === ".png") {
        fs.writeFileSync(outputFile, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      } else if (ext === ".pdf") {
        fs.writeFileSync(outputFile, "%PDF-1.4\n", "utf-8");
      } else {
        fs.writeFileSync(outputFile, "test", "utf-8");
      }

      callback(null, { stdout: "", stderr: "" });
    } else {
      callback(null, { stdout: "", stderr: "" });
    }
  }),
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

vi.mock("../src/live-server.js", () => ({
  ensureLiveServer: vi.fn(async () => 3737),
  addLiveDiagram: vi.fn(async () => {}),
  hasActiveConnections: vi.fn(() => false),
}));

describe("handleMermaidPreview", () => {
  const testPreviewId = "test-preview";
  let testDir: string;

  beforeEach(async () => {
    testDir = await setupTestEnvWithPreview(testPreviewId);
  });

  afterEach(async () => {
    await restoreTestEnv();
  });

  it("should throw error when diagram parameter is missing", async () => {
    await expect(
      handleMermaidPreview({ diagram: undefined, preview_id: testPreviewId })
    ).rejects.toThrow("diagram parameter is required");
  });

  it("should throw error when preview_id parameter is missing", async () => {
    await expect(
      handleMermaidPreview({ diagram: "graph TD; A-->B", preview_id: undefined })
    ).rejects.toThrow("preview_id parameter is required");
  });

  it("should use default values when optional parameters are not provided", async () => {
    const result = await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: testPreviewId,
    });

    expect(result.isError).toBeUndefined();
  });

  it("should accept all valid parameters", async () => {
    const result = await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: testPreviewId,
      format: "svg",
      theme: "dark",
      background: "transparent",
      width: 1024,
      height: 768,
      scale: 3,
    });

    expect(result.isError).toBeUndefined();
  });

  it("should save diagram source and options", async () => {
    await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: testPreviewId,
      theme: "dark",
      background: "white",
      width: 800,
      height: 600,
      scale: 2,
    });

    const files = await readdir(testDir);
    expect(files).toContain("diagram.mmd");
    expect(files).toContain("options.json");
  });

  it("should indicate live preview for SVG format", async () => {
    const result = await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: testPreviewId,
      format: "svg",
    });

    expect(result.content[0].text).toContain("Live reload");
  });

  it("should indicate static render for PNG format", async () => {
    const result = await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: testPreviewId,
      format: "png",
    });

    expect(result.content[0].text).toContain("Live preview is only available for SVG");
  });

  it("should indicate static render for PDF format", async () => {
    const result = await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: testPreviewId,
      format: "pdf",
    });

    expect(result.content[0].text).toContain("Live preview is only available for SVG");
  });

  it("should include stderr details in error when rendering fails", async () => {
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockImplementationOnce((_file: string, _args: any, callback: any) => {
      const error: any = new Error("Command failed: npx mmdc");
      error.stderr = "Parse error on line 3: invalid syntax near 'graph'";
      callback(error, { stdout: "", stderr: error.stderr });
    });

    const result = await handleMermaidPreview({
      diagram: "invalid diagram syntax",
      preview_id: testPreviewId,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Parse error on line 3");
    expect(result.content[0].text).toContain("Command failed");
  });

  it("should show original error message when stderr is empty", async () => {
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockImplementationOnce((_file: string, _args: any, callback: any) => {
      const error = new Error("Command failed: npx mmdc");
      callback(error, { stdout: "", stderr: "" });
    });

    const result = await handleMermaidPreview({
      diagram: "invalid diagram syntax",
      preview_id: testPreviewId,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Command failed");
  });

  it("should invoke cmd.exe /c npx on win32", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockClear();

    try {
      await handleMermaidPreview({
        diagram: "graph TD; A-->B",
        preview_id: testPreviewId,
      });

      expect(mockExecFile).toHaveBeenCalled();
      const [file, args] = mockExecFile.mock.calls[0] as [string, string[], unknown];
      expect(file).toBe("cmd.exe");
      expect(args[0]).toBe("/c");
      expect(args[1]).toBe("npx");
      expect(args).toContain("@mermaid-js/mermaid-cli");
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it("should invoke npx directly on non-win32 platforms", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockClear();

    try {
      await handleMermaidPreview({
        diagram: "graph TD; A-->B",
        preview_id: testPreviewId,
      });

      expect(mockExecFile).toHaveBeenCalled();
      const [file, args] = mockExecFile.mock.calls[0] as [string, string[], unknown];
      expect(file).toBe("npx");
      expect(args[0]).not.toBe("/c");
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it("should reject background with shell metacharacters without invoking npx", async () => {
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockClear();

    const result = await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: testPreviewId,
      background: "red & calc.exe",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid background");
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe("handleMermaidSave", () => {
  const testPreviewId = "test-save";

  beforeEach(async () => {
    await setupTestEnvWithPreview(testPreviewId);

    await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: testPreviewId,
      format: "svg",
    });
  });

  afterEach(async () => {
    await restoreTestEnv();
  });

  it("should throw error when save_path parameter is missing", async () => {
    await expect(
      handleMermaidSave({ save_path: undefined, preview_id: testPreviewId })
    ).rejects.toThrow("save_path parameter is required");
  });

  it("should throw error when preview_id parameter is missing", async () => {
    await expect(
      handleMermaidSave({ save_path: "./test.svg", preview_id: undefined })
    ).rejects.toThrow("preview_id parameter is required");
  });

  it("should use default format svg", async () => {
    const result = await handleMermaidSave({
      save_path: "/tmp/test-diagram.svg",
      preview_id: testPreviewId,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("SVG");
  });

  it("should support saving to different formats", async () => {
    const formats = ["svg", "png", "pdf"];

    for (const format of formats) {
      const result = await handleMermaidSave({
        save_path: `/tmp/test-diagram.${format}`,
        preview_id: testPreviewId,
        format,
      });

      expect(result.isError).toBeUndefined();
    }
  });

  it("should re-render if target format does not exist", async () => {
    const result = await handleMermaidSave({
      save_path: "/tmp/test-diagram.png",
      preview_id: testPreviewId,
      format: "png",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("PNG");

    const pngPath = getDiagramFilePath("default", testPreviewId, "png");
    await access(pngPath);
    await unlink(pngPath);
  });

  it("should handle missing diagram source when saving", async () => {
    const result = await handleMermaidSave({
      save_path: "/tmp/test-diagram.svg",
      preview_id: "non-existent-preview",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error saving diagram");
  });
});

describe("handleListMermaidCharts", () => {
  beforeEach(async () => {
    await setupTestEnvWithPreview("list-test");
  });

  afterEach(async () => {
    await restoreTestEnv();
  });

  it("should return empty message when no diagrams have been rendered", async () => {
    // setupTestEnvWithPreview creates the directory but no rendered diagram files
    const result = await handleListMermaidCharts();
    expect(result.content[0].text).toContain("No saved diagrams found");
  });

  it("should list diagrams after creating them", async () => {
    await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: "list-test",
    });

    const result = await handleListMermaidCharts();
    expect(result.content[0].text).toContain("list-test");
    expect(result.content[0].text).toContain("1 diagram(s)");
  });

  it("should list multiple diagrams", async () => {
    await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: "list-test",
    });
    // Create second diagram in the same test env (don't call setupTestEnvWithPreview again)
    const { mkdir } = await import("fs/promises");
    await mkdir(getPreviewDir("default", "list-test-2"), { recursive: true });
    await handleMermaidPreview({
      diagram: "graph LR; X-->Y",
      preview_id: "list-test-2",
    });

    const result = await handleListMermaidCharts();
    expect(result.content[0].text).toContain("2 diagram(s)");
    expect(result.content[0].text).toContain("list-test");
    expect(result.content[0].text).toContain("list-test-2");
  });
});

describe("handleGetMermaidChart", () => {
  const testPreviewId = "get-test";

  beforeEach(async () => {
    await setupTestEnvWithPreview(testPreviewId);
    await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: testPreviewId,
      theme: "dark",
    });
  });

  afterEach(async () => {
    await restoreTestEnv();
  });

  it("should throw error when preview_id is missing", async () => {
    await expect(handleGetMermaidChart({ preview_id: undefined })).rejects.toThrow(
      "preview_id parameter is required"
    );
  });

  it("should return error for non-existent diagram", async () => {
    const result = await handleGetMermaidChart({ preview_id: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Diagram not found");
  });

  it("should return source code and options for existing diagram", async () => {
    const result = await handleGetMermaidChart({ preview_id: testPreviewId });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("graph TD; A-->B");
    expect(result.content[0].text).toContain("dark");
    expect(result.content[0].text).toContain("SVG");
  });

  it("should include diagram metadata", async () => {
    const result = await handleGetMermaidChart({ preview_id: testPreviewId });
    expect(result.content[0].text).toContain(`Diagram: ${testPreviewId}`);
    expect(result.content[0].text).toContain("Format:");
    expect(result.content[0].text).toContain("Size:");
    expect(result.content[0].text).toContain("Modified:");
    expect(result.content[0].text).toContain("Dimensions:");
    expect(result.content[0].text).toContain("Scale:");
  });

  it("should normalize backslash-n to br tags in node labels", async () => {
    await handleMermaidPreview({
      diagram: 'graph TD; A["Hello\\nWorld"] --> B["Foo\\nBar"]',
      preview_id: testPreviewId,
    });

    const result = await handleGetMermaidChart({ preview_id: testPreviewId });
    expect(result.content[0].text).toContain("Hello<br/>World");
    expect(result.content[0].text).toContain("Foo<br/>Bar");
    expect(result.content[0].text).not.toContain("Hello\\nWorld");
  });

  it("should not normalize outside of quoted labels", async () => {
    await handleMermaidPreview({
      diagram: 'graph TD\n    A["Plain"] --> B',
      preview_id: testPreviewId,
    });

    const result = await handleGetMermaidChart({ preview_id: testPreviewId });
    // newlines outside quotes (code-level formatting) should be left alone
    expect(result.content[0].text).toContain("graph TD\n");
  });
});

describe("handleUpdateMermaidChart", () => {
  const testPreviewId = "update-test";

  beforeEach(async () => {
    await setupTestEnvWithPreview(testPreviewId);
    await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: testPreviewId,
      theme: "default",
      background: "white",
    });
  });

  afterEach(async () => {
    await restoreTestEnv();
  });

  it("should throw error when preview_id is missing", async () => {
    await expect(handleUpdateMermaidChart({ preview_id: undefined })).rejects.toThrow(
      "preview_id parameter is required"
    );
  });

  it("should return error for non-existent diagram", async () => {
    const result = await handleUpdateMermaidChart({ preview_id: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Diagram not found");
  });

  it("should update only the source code when only diagram is provided", async () => {
    const result = await handleUpdateMermaidChart({
      preview_id: testPreviewId,
      diagram: "graph LR; X-->Y",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("updated successfully");
    expect(result.content[0].text).toContain("source code");

    const source = await loadDiagramSource("default", testPreviewId);
    expect(source).toBe("graph LR; X-->Y");
  });

  it("should update only options when diagram is not provided", async () => {
    const result = await handleUpdateMermaidChart({
      preview_id: testPreviewId,
      theme: "dark",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("updated successfully");
    expect(result.content[0].text).toContain("theme");

    const source = await loadDiagramSource("default", testPreviewId);
    expect(source).toBe("graph TD; A-->B");

    const options = await loadDiagramOptions("default", testPreviewId);
    expect(options.theme).toBe("dark");
  });

  it("should update both source and options together", async () => {
    const result = await handleUpdateMermaidChart({
      preview_id: testPreviewId,
      diagram: "graph LR; X-->Y",
      theme: "forest",
      width: 1024,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("source code");
    expect(result.content[0].text).toContain("theme");
    expect(result.content[0].text).toContain("width");
  });

  it("should preserve existing options when not provided", async () => {
    await handleUpdateMermaidChart({
      preview_id: testPreviewId,
      theme: "forest",
    });

    const options = await loadDiagramOptions("default", testPreviewId);
    expect(options.theme).toBe("forest");
    expect(options.background).toBe("white");
    expect(options.width).toBe(800);
    expect(options.height).toBe(600);
    expect(options.scale).toBe(2);
  });
});

describe("handleDeleteMermaidChart", () => {
  const testPreviewId = "delete-test";

  beforeEach(async () => {
    await setupTestEnvWithPreview(testPreviewId);
    await handleMermaidPreview({
      diagram: "graph TD; A-->B",
      preview_id: testPreviewId,
    });
  });

  afterEach(async () => {
    await restoreTestEnv();
  });

  it("should throw error when preview_id is missing", async () => {
    await expect(handleDeleteMermaidChart({ preview_id: undefined })).rejects.toThrow(
      "preview_id parameter is required"
    );
  });

  it("should return error for non-existent diagram", async () => {
    const result = await handleDeleteMermaidChart({ preview_id: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error deleting diagram");
  });

  it("should delete an existing diagram", async () => {
    const result = await handleDeleteMermaidChart({ preview_id: testPreviewId });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("deleted successfully");

    // Verify it's gone
    const getResult = await handleGetMermaidChart({ preview_id: testPreviewId });
    expect(getResult.isError).toBe(true);
    expect(getResult.content[0].text).toContain("Diagram not found");
  });
});
