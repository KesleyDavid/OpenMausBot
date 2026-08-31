// The vendored electron-updater bundle is a build artifact, but it is also the
// code that actually runs in the packaged app. These tests pin the one
// behaviour we deliberately changed in it: an AppImage update must land on the
// path the user launches, never a new versioned filename.
//
// See scripts/patch-appimage-updater.mjs for the reasoning.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { patchAppImageUpdater } from "../scripts/patch-appimage-updater.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = readFileSync(join(root, "electron/vendor/electron-updater.cjs"), "utf8");

// Non-global on purpose: a shared /g regex carries lastIndex between .test()
// calls and would report alternating results.
const renamePattern = /destination = (\w+)\.join\(\1\.dirname\(appImageFile\), \1\.basename\(installerPath\)\);/;

test("the vendored bundle still contains the AppImage installer we patch", () => {
  assert.match(bundle, /const appImageFile = process\.env\["APPIMAGE"\]/);
  assert.match(bundle, /destination = appImageFile;/);
});

test("an AppImage update can never be written to a different filename", () => {
  // Upstream renames when the running file has a version in its name, which
  // orphans every .desktop entry, symlink and dock pin pointing at it.
  assert.doesNotMatch(bundle, renamePattern);
});

test("the patch rewrites the rename branch to keep the running path", () => {
  const upstream = [
    "if (path2.basename(installerPath) === existingBaseName || !/\\d+\\.\\d+\\.\\d+/.test(existingBaseName)) {",
    "  destination = appImageFile;",
    "} else {",
    "  destination = path2.join(path2.dirname(appImageFile), path2.basename(installerPath));",
    "}",
  ].join("\n");

  const patched = patchAppImageUpdater(upstream);

  assert.doesNotMatch(patched, renamePattern);
  assert.equal(patched.match(/destination = appImageFile;/g)?.length, 2);
});

test("the patch tolerates esbuild renaming the path import", () => {
  const patched = patchAppImageUpdater(
    "destination = path7.join(path7.dirname(appImageFile), path7.basename(installerPath));",
  );
  assert.equal(patched, "destination = appImageFile;");
});

test("the patch fails closed when upstream's shape moves", () => {
  // A silent no-op here would ship the launcher-breaking rename again.
  assert.throws(() => patchAppImageUpdater("destination = somethingElse;"), /found 0/);
  assert.throws(
    () =>
      patchAppImageUpdater(
        [
          "destination = path2.join(path2.dirname(appImageFile), path2.basename(installerPath));",
          "destination = path2.join(path2.dirname(appImageFile), path2.basename(installerPath));",
        ].join("\n"),
      ),
    /found 2/,
  );
});

// The assertions above read the bundle as text. This one runs the shipped
// AppImageUpdater.doInstall against real files, which is what actually has to
// hold: the update lands on the path the user launches, and the old file is
// gone from nowhere else.
test("the shipped installer moves the update onto the running AppImage's path", (t) => {
  const electron = { app: {}, autoUpdater: new EventEmitter() };
  const load = Module._load;
  Module._load = (request, ...rest) => (request === "electron" ? electron : load(request, ...rest));
  t.after(() => {
    Module._load = load;
  });

  const { AppImageUpdater } = createRequire(import.meta.url)("./vendor/electron-updater.cjs");
  const workspace = mkdtempSync(join(tmpdir(), "omb-appimage-install-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  // The user launches a versioned filename — the case upstream renames.
  const launched = join(workspace, "OpenMausBot-0.1.43-x86_64.AppImage");
  const staged = join(workspace, "pending", "OpenMausBot-0.1.44-x86_64.AppImage");
  mkdirSync(join(workspace, "pending"));
  writeFileSync(launched, "old", { mode: 0o755 });
  writeFileSync(staged, "new", { mode: 0o755 });

  const previous = process.env.APPIMAGE;
  process.env.APPIMAGE = launched;
  t.after(() => {
    if (previous === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previous;
  });

  const renames = [];
  let relaunched = null;
  AppImageUpdater.prototype.doInstall.call(
    {
      installerPath: staged,
      _logger: { info() {}, warn() {}, error() {}, debug() {} },
      dispatchError: (error) => assert.fail(error),
      emit: (event, value) => renames.push([event, value]),
      spawnLog: (target) => {
        relaunched = target;
      },
    },
    { isForceRunAfter: true },
  );

  assert.equal(readFileSync(launched, "utf8"), "new", "the update must land on the launched path");
  assert.equal(existsSync(staged), false, "the staged download must be consumed");
  assert.deepEqual(readdirSync(workspace).sort(), ["OpenMausBot-0.1.43-x86_64.AppImage", "pending"]);
  assert.equal(relaunched, launched, "the relaunch must use the path the launcher points at");
  assert.deepEqual(renames, [], "no filename change means no appimage-filename-updated event");
});
