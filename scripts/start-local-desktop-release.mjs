import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const appPath = NodePath.join(repoRoot, "release", "T3 Code (Alpha).app");
const executablePath = NodePath.join(appPath, "Contents", "MacOS", "T3 Code (Alpha)");
const releaseHome = NodePath.join(repoRoot, ".t3-release");

if (!NodeFS.existsSync(executablePath)) {
  throw new Error(
    `Local release app not found at ${appPath}. Build and extract the macOS release first.`,
  );
}

if (!NodeFS.existsSync(NodePath.join(releaseHome, "userdata"))) {
  throw new Error(`Local release state not found at ${releaseHome}.`);
}

const child = NodeChildProcess.spawn(executablePath, [], {
  detached: true,
  env: {
    ...process.env,
    T3CODE_HOME: releaseHome,
  },
  stdio: "ignore",
});

child.unref();
