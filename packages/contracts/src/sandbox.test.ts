import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "./providerInstance.ts";
import { sandboxInstanceHasCredential, withSandboxCredential } from "./sandbox.ts";

const claude = { driver: ProviderDriverKind.make("claudeAgent"), enabled: true };

describe("sandbox credentials", () => {
  it("accepts any listed variable, including a redacted stored value", () => {
    expect(sandboxInstanceHasCredential(claude)).toBe(false);
    expect(
      sandboxInstanceHasCredential({
        ...claude,
        environment: [
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: true, valueRedacted: true },
        ],
      }),
    ).toBe(true);
    expect(
      sandboxInstanceHasCredential({
        ...claude,
        environment: [{ name: "ANTHROPIC_API_KEY", value: " ", sensitive: false }],
      }),
    ).toBe(false);
    expect(sandboxInstanceHasCredential({ driver: ProviderDriverKind.make("codex") })).toBe(true);
  });

  it("stores a pasted token as the primary sensitive variable, replacing a previous one", () => {
    const other = { name: "ANTHROPIC_BASE_URL", value: "https://example.test", sensitive: false };
    const first = withSandboxCredential({ ...claude, environment: [other] }, " sk-ant-oat-1 ");
    expect(first.environment).toEqual([
      other,
      { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat-1", sensitive: true },
    ]);
    expect(withSandboxCredential(first, "sk-ant-oat-2").environment).toEqual([
      other,
      { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat-2", sensitive: true },
    ]);
    expect(withSandboxCredential(first, "  ")).toBe(first);
  });
});
