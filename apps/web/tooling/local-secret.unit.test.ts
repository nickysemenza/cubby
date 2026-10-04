import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { localSecret } from "./local-secret";

// Failure modes: a worktree has no apps/web/.env, so agents scraped the main
// checkout's file by hand; the shell value must still win; a secret lookup
// must never hand back database or storage settings from the same file.
function checkout(env?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-secret-"));
  mkdirSync(path.join(root, "apps/web"), { recursive: true });
  if (env !== undefined)
    writeFileSync(path.join(root, "apps/web/.env"), env, "utf8");
  return root;
}

describe("localSecret", () => {
  it("falls back to the main checkout when a worktree has no .env", () => {
    const main = checkout('AI_GATEWAY_API_KEY="main-key"\n');
    const worktree = checkout();
    expect(
      localSecret(["AI_GATEWAY_API_KEY"], {
        env: {},
        checkoutRoot: worktree,
        mainCheckoutRoot: main,
      }),
    ).toBe("main-key");
  });

  it("prefers the shell, then the current checkout, in name order", () => {
    const main = checkout("AI_GATEWAY_API_KEY=main-key\n");
    const worktree = checkout("SECOND=worktree-second\n");
    const roots = { checkoutRoot: worktree, mainCheckoutRoot: main };
    expect(
      localSecret(["AI_GATEWAY_API_KEY"], {
        env: { AI_GATEWAY_API_KEY: "shell-key" },
        ...roots,
      }),
    ).toBe("shell-key");
    expect(
      localSecret(["SECOND", "AI_GATEWAY_API_KEY"], { env: {}, ...roots }),
    ).toBe("worktree-second");
  });

  it("reads only the requested names and an explicit file when given", () => {
    const main = checkout("DATABASE_URL=postgres://example\n");
    const explicit = path.join(checkout(), "other.env");
    writeFileSync(explicit, "AI_GATEWAY_API_KEY=explicit-key\n", "utf8");
    const roots = { checkoutRoot: checkout(), mainCheckoutRoot: main };
    expect(
      localSecret(["AI_GATEWAY_API_KEY"], { env: {}, ...roots }),
    ).toBeUndefined();
    expect(
      localSecret(["AI_GATEWAY_API_KEY"], {
        env: {},
        envFile: explicit,
        ...roots,
      }),
    ).toBe("explicit-key");
  });
});
