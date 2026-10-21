// @effect-diagnostics nodeBuiltinImport:off -- Verifies real disk-backed upload staging.
import { PREVIEW_UPLOAD_CHUNK_BYTES, PREVIEW_UPLOAD_MAX_FILE_BYTES } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BrowserUploads } from "./BrowserUploads.ts";

const active: BrowserUploads[] = [];
const create = () => {
  const uploads = new BrowserUploads();
  active.push(uploads);
  return uploads;
};
const chunk = {
  operation: "stageUpload" as const,
  id: "upload-1",
  sourcePath: "/remote/TRAIND.aab",
  name: "TRAIND.aab",
  sizeBytes: 6,
  offset: 0,
  data: Buffer.from("abc").toString("base64"),
  done: false,
};

afterEach(async () => {
  await Promise.all(active.splice(0).map((uploads) => uploads.dispose()));
});

describe("BrowserUploads", () => {
  it("stages a 75 MiB bundle in bounded chunks, retaining its name and bytes", async () => {
    const uploads = create();
    const sizeBytes = 75 * 1024 * 1024;
    const data = Buffer.alloc(PREVIEW_UPLOAD_CHUNK_BYTES, 0x5a).toString("base64");
    for (let offset = 0; offset < sizeBytes; offset += PREVIEW_UPLOAD_CHUNK_BYTES) {
      const done = offset + PREVIEW_UPLOAD_CHUNK_BYTES === sizeBytes;
      await uploads.stage({ ...chunk, sizeBytes, offset, data, done });
      if (!done) expect(() => uploads.resolve([chunk.sourcePath])).toThrow("not been transferred");
    }
    const [path] = uploads.resolve([chunk.sourcePath]);
    expect(path).toMatch(/\/TRAIND\.aab$/);
    expect((await NodeFSP.stat(path!)).size).toBe(sizeBytes);
    const file = await NodeFSP.open(path!, "r");
    try {
      for (const position of [0, sizeBytes - 32]) {
        const bytes = Buffer.alloc(32);
        expect((await file.read(bytes, 0, bytes.length, position)).bytesRead).toBe(32);
        expect(bytes).toEqual(Buffer.alloc(32, 0x5a));
      }
    } finally {
      await file.close();
    }
    await uploads.dispose();
    await expect(NodeFSP.stat(path!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { offset: 4, data: "ZGVm", done: true },
    { offset: 3, data: "ZA==", done: true },
    { offset: 3, data: "ZGVmZw==", done: true },
    { offset: 3, sourcePath: "/different/file", data: "ZGVm", done: true },
  ])("rejects an out-of-order, truncated, oversized or substituted transfer: %j", async (next) => {
    const uploads = create();
    await uploads.stage(chunk);
    await expect(uploads.stage({ ...chunk, ...next })).rejects.toThrow(
      "Invalid browser upload chunk",
    );
    expect(() => uploads.resolve([chunk.sourcePath])).toThrow("not been transferred");
    await expect(uploads.stage({ ...chunk, offset: 3 })).rejects.toThrow("Unknown browser upload");
  });

  it("rejects files above 1 GiB and chunks above the transport bound", async () => {
    const uploads = create();
    await expect(
      uploads.stage({ ...chunk, sizeBytes: PREVIEW_UPLOAD_MAX_FILE_BYTES + 1 }),
    ).rejects.toThrow("Invalid browser upload size");
    await expect(
      uploads.stage({
        ...chunk,
        data: Buffer.alloc(PREVIEW_UPLOAD_CHUNK_BYTES + 1).toString("base64"),
      }),
    ).rejects.toThrow("Invalid browser upload size");
  });

  it("handles empty files, isolates duplicate names, and discards only the requested file", async () => {
    const uploads = create();
    await uploads.stage({ ...chunk, sizeBytes: 0, data: "", done: true });
    await uploads.stage({
      ...chunk,
      id: "upload-2",
      sourcePath: "/elsewhere/TRAIND.aab",
      sizeBytes: 3,
      done: true,
    });
    const [first, second] = uploads.resolve([chunk.sourcePath, "/elsewhere/TRAIND.aab"]);
    expect(first).not.toBe(second);
    expect((await NodeFSP.stat(first!)).size).toBe(0);
    await uploads.discard("upload-1");
    expect(() => uploads.resolve([chunk.sourcePath])).toThrow("not been transferred");
    expect(await NodeFSP.readFile(second!, "utf8")).toBe("abc");
    await uploads.dispose();
    await expect(uploads.stage(chunk)).rejects.toThrow("disconnected");
  });
});
