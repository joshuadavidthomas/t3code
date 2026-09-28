// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { startPortalProxy } from "./t3-portal.ts";

if (!process.env.AMP_THREAD_ID || !process.env.PUBLIC_URL) {
  throw new Error("Start T3 using amp orb services ensure");
}
const PORTAL_PORT = 5733;
// Offset 1 puts Vite on 5734 (server 13774) behind the portal proxy on 5733.
const PORT_OFFSET = 1;
const publicOrigin = new URL(process.env.PUBLIC_URL).origin;

const home = NodePath.resolve(".t3");
NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
const tokenPath = NodePath.join(home, "orb-portal-token");
if (!NodeFS.existsSync(tokenPath)) {
  NodeFS.writeFileSync(tokenPath, NodeCrypto.randomBytes(32).toString("hex"), {
    mode: 0o600,
    flag: "wx",
  });
}
const token = NodeFS.readFileSync(tokenPath, "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid local orb portal credential");

// A sandbox launch uploads a Linux build of this checkout; build it into
// .t3/sandbox-runtime (see docs/operations/release.md) to launch from the portal.
const sandboxRuntimeDir = NodePath.join(home, "sandbox-runtime");
const sandboxRuntimeArchive = NodeFS.existsSync(sandboxRuntimeDir)
  ? NodeFS.readdirSync(sandboxRuntimeDir).find((name) => name.endsWith("-linux-x64.tar.gz"))
  : undefined;

const child = NodeChildProcess.spawn(
  "vp",
  [
    "run",
    "dev",
    "--home-dir",
    home,
    "--dev-url",
    publicOrigin,
    "--auto-bootstrap-project-from-cwd",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      T3CODE_PORT_OFFSET: String(PORT_OFFSET),
      T3CODE_BUNDLED_DEV: "0",
      T3CODE_DEV_AUTH_TOKEN: token,
      ...(sandboxRuntimeArchive && !process.env.T3CODE_SANDBOX_RUNTIME_ARCHIVE
        ? {
            T3CODE_SANDBOX_RUNTIME_ARCHIVE: NodePath.join(sandboxRuntimeDir, sandboxRuntimeArchive),
          }
        : {}),
    },
  },
);
const proxy = startPortalProxy({
  listenPort: PORTAL_PORT,
  targetPort: PORTAL_PORT + PORT_OFFSET,
  publicOrigin,
  token,
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  proxy.close();
  process.exit(code ?? 1);
});
