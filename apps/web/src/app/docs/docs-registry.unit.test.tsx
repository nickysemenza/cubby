import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { docSlug, resolveDocHref } from "./doc-paths";
import { DEFAULT_DOC_SLUG, docSections, getDocSection } from "./docs-registry";

describe("repository documentation", () => {
  it("exposes every Markdown file in the docs tree", () => {
    const docsRoot = resolve(process.cwd(), "../../docs");
    const files = readdirSync(docsRoot, { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".md"))
      .sort();
    const published = docSections
      .flatMap((section) => section.sourcePath ?? [])
      .sort();

    expect(published).toEqual(files);
    expect(DEFAULT_DOC_SLUG).toBe("readme");
    expect(docSections[0]?.title).toBe("README.md");
    expect(getDocSection("ci")?.title).toBe("ci.md");
    expect(getDocSection("inventory-audit")?.group).toBe("docs");
    expect(
      getDocSection("adr--0001-entity-relationship-authority")?.group,
    ).toBe("adr");
  });

  it("keeps docs links in the app and sends repository links to the source", () => {
    expect(docSlug("agents/validation.md")).toBe("agents--validation");
    expect(
      resolveDocHref("../terminology.md#core-entities", "agents/web-ui.md"),
    ).toBe("/docs/terminology#core-entities");
    expect(resolveDocHref("agents/validation.md", "ci.md")).toBe(
      "/docs/agents--validation",
    );
    expect(resolveDocHref("../README.md", "inventory-audit.md")).toBe(
      "https://github.com/nickysemenza/cubby/blob/main/README.md",
    );
    expect(resolveDocHref("#local-verification", "ci.md")).toBe(
      "#local-verification",
    );
  });
});
