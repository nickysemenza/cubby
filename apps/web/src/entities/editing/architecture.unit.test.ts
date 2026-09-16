import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = (name: string) =>
  readFileSync(new URL(name, import.meta.url), "utf8");

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[jt]sx?$/u.test(entry.name) && !entry.name.includes(".test.")
      ? [path]
      : [];
  });

describe("entity editing architecture", () => {
  it("keeps transport and semantic policy out of generic UI hosts", () => {
    const uiSources = [
      source("./editor-presentations.tsx"),
      source("./entity-edit-dialog.tsx"),
      source("./entity-edit-dialog-content.tsx"),
    ].join("\n");

    expect(uiSources).not.toMatch(/mutationOptions|invalidateKeys|zodResolver/);
    expect(source("./editor-presentations.tsx")).not.toMatch(
      /buildPayload|toPayload|mutationFn/,
    );
  });

  it("keeps the editing barrel out of client modules", () => {
    const appRoot = new URL("../../", import.meta.url).pathname;
    const offenders = sourceFiles(appRoot).filter((path) =>
      readFileSync(path, "utf8").includes('from "~/entities/editing"'),
    );

    expect(offenders).toEqual([]);
  });
});
