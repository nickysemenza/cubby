import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localSimulatorServer } from "../../../scripts/lib/simulator-server.ts";

// Failure modes: a launcher silently selects production, a URL with credentials
// or a non-origin path reaches the app, and --server is accepted for a real phone.
describe("local simulator server", () => {
  it.each(["http://localhost:3000", "http://127.0.0.1:3100/"])(
    "accepts a local origin %s",
    (url) => {
      expect(localSimulatorServer(url)).toBe(new URL(url).origin);
    },
  );
  it.each([
    "https://example.test:3000",
    "http://example.test:3000",
    "http://localhost",
    "http://localhost:3000/api",
    "http://localhost:3000/?x=1",
    "http://localhost:3000/#x",
    "http://synthetic:password@localhost:3000",
    "invalid",
  ])("rejects a non-local origin %s", (url) => {
    expect(() => localSimulatorServer(url)).toThrow(/loopback HTTP origin/u);
  });
  it("rejects a server override for a physical device before build or launch", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/apple.ts", "ios", "--server", "http://localhost:3000"],
        { cwd: path.resolve(import.meta.dirname, "../../.."), stdio: "pipe" },
      ),
    ).toThrow(/--server requires sim/u);
  });
});
