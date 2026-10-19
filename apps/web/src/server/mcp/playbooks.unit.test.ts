import { describe, expect, it } from "vitest";

import { PLAYBOOK_FILES } from "~/server/generated/playbooks.gen";

import {
  PLAYBOOK_READ_LIMIT,
  getPlaybook,
  listPlaybooks,
  markdownSection,
  readPlaybookFile,
} from "./playbooks";

describe("playbooks", () => {
  it("serves every listed file, with no link left relative to the checkout", () => {
    for (const playbook of listPlaybooks())
      for (const file of playbook.files) {
        expect({ file, served: file in PLAYBOOK_FILES }).toEqual({
          file,
          served: true,
        });
        expect(PLAYBOOK_FILES[file]).not.toMatch(/\]\(\.{1,2}\//u);
      }
  });

  it("returns a playbook's SKILL.md by name and refuses an unknown one", () => {
    expect(getPlaybook("purchase-import").content).toMatch(
      /^---\nname: purchase-import\n/u,
    );
    expect(() => getPlaybook("repo-audit")).toThrow(/playbook\.list names/u);
  });

  it("reads one section by anchor and outlines a large file", () => {
    const section = readPlaybookFile("README.md", "#tenets");
    expect(section.content).toMatch(/^#+ Tenets\n/u);
    expect(section.content?.length).toBeLessThan(
      PLAYBOOK_FILES["README.md"]?.length ?? 0,
    );

    const large = Object.keys(PLAYBOOK_FILES).find(
      (path) => (PLAYBOOK_FILES[path]?.length ?? 0) > PLAYBOOK_READ_LIMIT,
    );
    expect(large).toBeDefined();
    const outlined = readPlaybookFile(large ?? "");
    expect(outlined.content).toBeNull();
    expect(outlined.outline?.length).toBeGreaterThan(0);

    expect(() => readPlaybookFile("apps/web/src/server/mcp/server.ts")).toThrow(
      /not a playbook file/u,
    );
    expect(() => readPlaybookFile("README.md", "no such heading")).toThrow(
      /has no heading/u,
    );
  });

  it("ends a section at the next heading of the same level, ignoring code fences", () => {
    const markdown = [
      "# Top",
      "## A",
      "text",
      "```",
      "# not a heading",
      "```",
      "### A.1",
      "## B",
    ].join("\n");
    expect(markdownSection(markdown, "a")).toBe(
      ["## A", "text", "```", "# not a heading", "```", "### A.1"].join("\n"),
    );
  });
});
