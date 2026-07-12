import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PAPER_THEME = "#fcfaf4";
const PAPER_BACKGROUND = "#f7f4ec";

describe("PWA paper-color metadata", () => {
  it("keeps document, manifest, and offline colors synchronized", () => {
    const manifest = JSON.parse(
      readFileSync(resolve("public/manifest.json"), "utf8"),
    ) as { theme_color: string; background_color: string };
    const root = readFileSync(resolve("src/routes/__root.tsx"), "utf8");
    const offline = readFileSync(resolve("public/offline.html"), "utf8");

    expect(manifest.theme_color).toBe(PAPER_THEME);
    expect(manifest.background_color).toBe(PAPER_BACKGROUND);
    expect(root).toContain(`content: "${PAPER_THEME}"`);
    expect(offline).toContain(`content="${PAPER_THEME}"`);
    expect(offline).toContain(`--bg: ${PAPER_BACKGROUND}`);
  });
});
