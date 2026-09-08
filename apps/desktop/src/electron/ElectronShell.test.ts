import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { openExternalMock, writeTextMock, showItemInFolderMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  writeTextMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openExternal: openExternalMock,
    showItemInFolder: showItemInFolderMock,
  },
  clipboard: {
    writeText: writeTextMock,
  },
}));

import * as ElectronShell from "./ElectronShell.ts";

describe("ElectronShell", () => {
  beforeEach(() => {
    openExternalMock.mockReset();
    writeTextMock.mockReset();
    showItemInFolderMock.mockReset();
  });

  it.effect("opens safe external URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("copies text to the system clipboard", () =>
    Effect.gen(function* () {
      writeTextMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      yield* electronShell.copyText("https://example.com/path");

      assert.deepEqual(writeTextMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not fail when the clipboard write rejects", () =>
    Effect.gen(function* () {
      writeTextMock.mockRejectedValue(new Error("write failed"));

      const electronShell = yield* ElectronShell.ElectronShell;
      yield* electronShell.copyText("https://example.com/path");

      assert.deepEqual(writeTextMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens the Full Disk Access settings anchor", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openSystemSettings("full-disk-access");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [
        ["x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens remote SSH editor URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(
        "vscode://vscode-remote/ssh-remote+example.com/home/user/project",
      );

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [
        ["vscode://vscode-remote/ssh-remote+example.com/home/user/project"],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open remote editor URLs with userinfo", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.all([
        electronShell.openExternal(
          "vscode://user@vscode-remote/ssh-remote+example.com/home/user/project",
        ),
        electronShell.openExternal(
          "vscode://:secret@vscode-remote/ssh-remote+example.com/home/user/project",
        ),
      ]);

      assert.deepEqual(results, [false, false]);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open unsafe external URLs", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("file:///etc/passwd");

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open non-remote editor URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(
        "vscode://ms-python.python/some-command?argument=attacker",
      );

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("returns false when Electron rejects openExternal", () =>
    Effect.gen(function* () {
      openExternalMock.mockRejectedValue(new Error("open failed"));

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, false);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );
});

describe("revealPath", () => {
  beforeEach(() => showItemInFolderMock.mockReset());
  it.effect("reveals an existing absolute path without opening the file", () =>
    Effect.gen(function* () {
      const shell = yield* ElectronShell.ElectronShell;
      assert.equal(yield* shell.revealPath(process.execPath), true);
      assert.deepEqual(showItemInFolderMock.mock.calls, [[process.execPath]]);
    }).pipe(Effect.provide([ElectronShell.layer, NodeServices.layer])),
  );

  it.effect("rejects relative, missing, and malformed paths", () =>
    Effect.gen(function* () {
      showItemInFolderMock.mockClear();
      const shell = yield* ElectronShell.ElectronShell;
      for (const path of [
        "relative.md",
        "/t3-missing-file/reveal.md",
        "/tmp/bad\0path",
        "file:///tmp/test.md",
      ]) {
        assert.equal(yield* shell.revealPath(path), false);
      }
      assert.equal(showItemInFolderMock.mock.calls.length, 0);
    }).pipe(Effect.provide([ElectronShell.layer, NodeServices.layer])),
  );

  it.effect("returns false when the file manager fails", () =>
    Effect.gen(function* () {
      showItemInFolderMock.mockImplementationOnce(() => {
        throw new Error("Failed");
      });
      const shell = yield* ElectronShell.ElectronShell;
      assert.equal(yield* shell.revealPath(process.execPath), false);
    }).pipe(Effect.provide([ElectronShell.layer, NodeServices.layer])),
  );
});
