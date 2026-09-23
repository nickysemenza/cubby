import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const PORCELAIN_CANVAS = "#f7f9fc";

describe("PWA Porcelain color metadata", () => {
  it("keeps document and manifest colors synchronized", () => {
    const manifest = z
      .object({ theme_color: z.string(), background_color: z.string() })
      .parse(JSON.parse(readFileSync(resolve("public/manifest.json"), "utf8")));
    const root = readFileSync(resolve("src/routes/__root.tsx"), "utf8");

    expect(manifest.theme_color).toBe(PORCELAIN_CANVAS);
    expect(manifest.background_color).toBe(PORCELAIN_CANVAS);
    expect(root).toContain(`content: "${PORCELAIN_CANVAS}"`);
  });
});

describe("PWA Home Screen manifest", () => {
  it("opens Today without changing the installed app identity", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(resolve("public/manifest.json"), "utf8"),
    );

    expect(manifest).toMatchObject({
      id: "/inventory/session",
      start_url: "/",
      scope: "/",
      share_target: { action: "/recipes/new" },
    });
  });
});

describe("PWA deployment cache headers", () => {
  it("keeps hashed assets immutable", () => {
    const headers = readFileSync(resolve("public/_headers"), "utf8");

    expect(headers).toMatch(
      /\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/,
    );
  });
});
