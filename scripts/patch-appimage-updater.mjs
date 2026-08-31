// electron-updater installs an AppImage update by writing the new file under
// the *release asset's* name and unlinking the old one. Our feed names assets
// after the version, so a user whose AppImage is called
// OpenMausBot-0.1.43-x86_64.AppImage ends up with a 0.1.44 file and nothing at
// the old path — every .desktop entry, symlink, dock pin and AppImageLauncher
// registration pointing at it breaks, and the app vanishes from the launcher.
//
// Upstream only overwrites in place when the running file has no version in
// its name. Force that branch unconditionally: the update lands on whatever
// path the user already launches, whatever they named it.
//
// Applied to the generated bundle by scripts/bundle-updater.mjs, and asserted
// on the committed artifact by electron/vendor-updater.node-test.mjs.

// esbuild renames the imported `path` module per build (path2, path3, …), so
// match the identifier instead of pinning one. The back-reference keeps this
// from matching an unrelated join().
const RENAME_ASSIGNMENT =
  /destination = (\w+)\.join\(\1\.dirname\(appImageFile\), \1\.basename\(installerPath\)\);/g;

const IN_PLACE_ASSIGNMENT = "destination = appImageFile;";

/**
 * Rewrite the AppImage rename branch to keep the running file's path.
 * Throws when the upstream shape moved: a silently unpatched bundle would
 * ship the launcher-breaking behaviour again.
 */
export function patchAppImageUpdater(source) {
  const matches = source.match(RENAME_ASSIGNMENT);
  const count = matches ? matches.length : 0;
  if (count !== 1) {
    throw new Error(
      `Expected exactly 1 AppImage rename assignment to patch, found ${count}. ` +
        "electron-updater's AppImageUpdater.doInstall changed shape — re-read it and update " +
        "scripts/patch-appimage-updater.mjs before releasing.",
    );
  }
  return source.replace(RENAME_ASSIGNMENT, IN_PLACE_ASSIGNMENT);
}
