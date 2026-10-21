// @effect-diagnostics nodeBuiltinImport:off -- Desktop file transfers run in native callbacks.
import {
  type DesktopBrowserPrivateOperation,
  PREVIEW_UPLOAD_CHUNK_BYTES,
  PREVIEW_UPLOAD_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import { safeFileNameSegment } from "@t3tools/shared/fileNameSegment";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

type UploadChunk = Extract<DesktopBrowserPrivateOperation, { operation: "stageUpload" }>;

/** Disk-backed files for one remote browser tab. Only completed transfers reach CDP. */
export class BrowserUploads {
  private readonly files = new Map<
    string,
    {
      readonly input: Pick<UploadChunk, "name" | "sourcePath" | "sizeBytes">;
      readonly directory: string;
      readonly path: string;
      written: number;
    }
  >();
  private readonly paths = new Map<string, string>();
  private disposed = false;

  async stage(input: UploadChunk) {
    if (this.disposed) throw new Error("Browser tab disconnected during upload.");
    const bytes = Buffer.from(input.data, "base64");
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.sizeBytes > PREVIEW_UPLOAD_MAX_FILE_BYTES ||
      bytes.length > PREVIEW_UPLOAD_CHUNK_BYTES ||
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0
    )
      throw new Error("Invalid browser upload size or offset.");
    let file = this.files.get(input.id);
    if (!file) {
      if (input.offset !== 0) throw new Error("Unknown browser upload.");
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-upload-"));
      if (this.disposed) {
        await NodeFSP.rm(directory, { recursive: true, force: true });
        throw new Error("Browser tab disconnected during upload.");
      }
      file = {
        input: { name: input.name, sourcePath: input.sourcePath, sizeBytes: input.sizeBytes },
        directory,
        path: NodePath.join(directory, safeFileNameSegment(input.name)),
        written: 0,
      };
      this.files.set(input.id, file);
    }
    try {
      if (
        input.offset !== file.written ||
        input.name !== file.input.name ||
        input.sourcePath !== file.input.sourcePath ||
        input.sizeBytes !== file.input.sizeBytes ||
        file.written + bytes.length > input.sizeBytes ||
        (input.done && file.written + bytes.length !== input.sizeBytes) ||
        (!input.done && bytes.length === 0)
      )
        throw new Error("Invalid browser upload chunk.");
      const output = await NodeFSP.open(file.path, input.offset === 0 ? "wx" : "r+", 0o600);
      try {
        // A filesystem write may consume only part of a chunk.
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await output.write(
            bytes,
            offset,
            bytes.length - offset,
            input.offset + offset,
          );
          if (bytesWritten === 0) throw new Error("Browser upload write made no progress.");
          offset += bytesWritten;
        }
      } finally {
        await output.close();
      }
      if (this.disposed || !this.files.has(input.id))
        throw new Error("Browser tab disconnected during upload.");
      file.written += bytes.length;
      if (input.done) this.paths.set(input.sourcePath, file.path);
      return { writtenBytes: file.written };
    } catch (cause) {
      await this.discard(input.id);
      throw cause;
    }
  }

  resolve(paths: readonly string[]) {
    return paths.map((source) => {
      const path = this.paths.get(source);
      if (!path) throw new Error("Browser upload has not been transferred to this desktop.");
      return path;
    });
  }

  async discard(id: string) {
    const file = this.files.get(id);
    if (!file) return;
    this.files.delete(id);
    if (this.paths.get(file.input.sourcePath) === file.path)
      this.paths.delete(file.input.sourcePath);
    await NodeFSP.rm(file.directory, { recursive: true, force: true });
  }

  async dispose() {
    this.disposed = true;
    await Promise.all([...this.files.keys()].map((id) => this.discard(id)));
  }
}
