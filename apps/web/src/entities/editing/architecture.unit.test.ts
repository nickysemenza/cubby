import { existsSync, readdirSync, readFileSync } from "node:fs";
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
      source("./entity-edit-page.tsx"),
      source("./entity-form-dialog.tsx"),
    ].join("\n");

    expect(uiSources).not.toMatch(/mutationOptions|invalidateKeys|zodResolver/);
    expect(source("./editor-presentations.tsx")).not.toMatch(
      /buildPayload|toPayload|mutationFn/,
    );
  });

  it("does not reintroduce ordinary entity-specific dialog shells", () => {
    const removedShells = [
      "../../app/meals/create-meal-dialog.tsx",
      "../../app/tasks/create-task-dialog.tsx",
      "../../app/expenses/create-expense-dialog.tsx",
      "../../app/projects/create-project-dialog.tsx",
      "../../app/vendors/create-vendor-dialog.tsx",
      "../../app/purchases/create-purchase-dialog.tsx",
      "../../app/wishes/wish-form-dialog.tsx",
      "../../app/_components/forms/quick-add-dialog.tsx",
    ];
    for (const path of removedShells) {
      expect(existsSync(new URL(path, import.meta.url)), path).toBe(false);
    }
  });

  it("has no raw legacy CRUD intent escape hatch", () => {
    const commands = source("./use-entity-commands.ts");
    expect(commands).not.toMatch(/executeOrThrow|intent\s*=\s*["']legacy/);
    expect(commands).not.toMatch(/readonly raw:|readonly update:/);
  });

  it("keeps the editing barrel out of client modules", () => {
    const appRoot = new URL("../../", import.meta.url).pathname;
    const offenders = sourceFiles(appRoot).filter((path) =>
      readFileSync(path, "utf8").includes('from "~/entities/editing"'),
    );

    expect(offenders).toEqual([]);
  });
});
