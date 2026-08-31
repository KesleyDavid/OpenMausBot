// The command handed to a Linux user is the whole deliverable of the .deb
// update path: the app deliberately does not run it. If it is wrong, the user
// is stuck with a downloaded package and no way to finish.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HAND_OFF_PACKAGE_TYPES,
  packageInstallCommand,
  shellQuote,
} from "./package-install-command.mjs";

test("the Ubuntu command resolves dependencies", () => {
  const command = packageInstallCommand("deb", "/home/u/.cache/openmausbot-updater/pending/x.deb");

  assert.equal(
    command,
    "sudo apt-get install -y '/home/u/.cache/openmausbot-updater/pending/x.deb'",
  );
  // `dpkg -i` is what electron-updater ran, and it installs nothing when a
  // release adds a dependency. Ubuntu also satisfies ours through virtual
  // Provides, which only apt resolves.
  assert.doesNotMatch(command, /dpkg/);
});

test("every hand-off package type has a command", () => {
  for (const packageType of HAND_OFF_PACKAGE_TYPES) {
    assert.match(packageInstallCommand(packageType, "/tmp/pkg"), /^sudo \S+/);
  }
  assert.throws(() => packageInstallCommand("snap", "/tmp/pkg"), /No install command/);
});

test("a missing download is reported instead of building a broken command", () => {
  assert.throws(() => packageInstallCommand("deb", undefined), /no longer available/);
  assert.throws(() => packageInstallCommand("deb", ""), /no longer available/);
});

// The path lives under $HOME, so it can carry whatever a directory name can.
// A mis-quoted command would either fail to install or run something else.
test("the quoted path survives a shell round-trip", () => {
  const workspace = mkdtempSync(join(tmpdir(), "omb-quote-"));
  try {
    for (const name of ["plain.deb", "with space.deb", "o'brien.deb", "a;b&c.deb", "$(echo bad).deb"]) {
      const file = join(workspace, name);
      writeFileSync(file, "x");
      // `printf %s` echoes exactly one argument: what the shell parsed out of
      // our quoting has to be the path we meant, byte for byte.
      const parsed = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(file)}`], {
        encoding: "utf8",
      });
      assert.equal(parsed, file, `quoting mangled ${name}`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the whole command parses into the arguments apt-get would receive", () => {
  const file = "/home/o'brien/.cache/openmausbot-updater/pending/OpenMausBot-0.1.44-amd64.deb";
  const command = packageInstallCommand("deb", file);

  // Replace the privileged verb with a printer, then confirm the shell hands
  // it exactly the flags and the one path.
  const printed = execFileSync(
    "/bin/sh",
    ["-c", `set -- ${command.replace("sudo apt-get", "")}; for a in "$@"; do printf '%s\\n' "$a"; done`],
    { encoding: "utf8" },
  );

  assert.deepEqual(printed.split("\n").filter(Boolean), ["install", "-y", file]);
});
