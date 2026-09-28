import { expect, it } from "vite-plus/test";
import { makeSandboxRuntimeCatalog, makeSandboxRuntimeManifest } from "./SandboxRuntime.ts";

it("identifies an artifact by its catalog, so the host can offer models before downloading it", () => {
  const catalog = makeSandboxRuntimeCatalog();
  const first = makeSandboxRuntimeManifest(`sha256-${"1".repeat(64)}`);
  const second = makeSandboxRuntimeManifest(`sha256-${"2".repeat(64)}`);
  expect(first.id).toBe(catalog.id);
  expect(second.id).toBe(catalog.id);
  expect(catalog.providers[0]?.models.length).toBeGreaterThan(0);
});
