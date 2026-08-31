// The command a Linux user pastes to finish an update.
//
// OpenMausBot is installed from the releases repository by hand, not from a
// store, so there is no package handler worth delegating to — a stock Ubuntu
// 24.04 registers App Center for .deb and may not install a local one at all.
// The app therefore never installs the package itself; it downloads it,
// verifies it, and hands over this exact line.

const BUILDERS = {
  // apt-get, never `dpkg -i`: only apt-get resolves dependencies, and Ubuntu
  // satisfies ours through virtual Provides (libgtk-3-0 → libgtk-3-0t64).
  deb: (file) => `sudo apt-get install -y ${file}`,
  rpm: (file) => `sudo rpm -Uvh ${file}`,
  pacman: (file) => `sudo pacman -U ${file}`,
};

export const HAND_OFF_PACKAGE_TYPES = Object.freeze(Object.keys(BUILDERS));

/** Single-quote for the shell the user pastes into. The path is
 * electron-updater's cache under $HOME, so it can carry anything a directory
 * name can — an apostrophe included. */
export function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Throws for a package type with no builder, so a new target cannot reach
 * the banner with a command we never wrote. */
export function packageInstallCommand(packageType, file) {
  const build = BUILDERS[packageType];
  if (!build) throw new Error(`No install command for package type ${JSON.stringify(packageType)}`);
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("The downloaded package is no longer available. Download it again.");
  }
  return build(shellQuote(file));
}
