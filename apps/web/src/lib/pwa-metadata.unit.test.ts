import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PORCELAIN_CANVAS = "#f7f9fc";

describe("PWA Porcelain color metadata", () => {
  it("keeps document, manifest, and offline colors synchronized", () => {
    const manifest = JSON.parse(
      readFileSync(resolve("public/manifest.json"), "utf8"),
    ) as { theme_color: string; background_color: string };
    const root = readFileSync(resolve("src/routes/__root.tsx"), "utf8");
    const offline = readFileSync(resolve("public/offline.html"), "utf8");

    expect(manifest.theme_color).toBe(PORCELAIN_CANVAS);
    expect(manifest.background_color).toBe(PORCELAIN_CANVAS);
    expect(root).toContain(`content: "${PORCELAIN_CANVAS}"`);
    expect(offline).toContain(`content="${PORCELAIN_CANVAS}"`);
    expect(offline).toContain(`--bg: ${PORCELAIN_CANVAS}`);
  });
});

describe("PWA deployment cache headers", () => {
  it("revalidates the worker while keeping hashed assets immutable", () => {
    const headers = readFileSync(resolve("public/_headers"), "utf8");

    expect(headers).toMatch(
      /\/sw\.js\s+Cache-Control: public, max-age=0, must-revalidate/,
    );
    expect(headers).toMatch(
      /\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/,
    );
  });
});
