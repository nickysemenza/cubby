import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  sourceFiles,
  SOURCE_ROOT,
} from "../../../scripts/generator/start-operations/collect";

it("ignores temporary lint fixtures when discovering the application operation catalog", async () => {
  const directory = await mkdtemp(join(SOURCE_ROOT, "server/.lint-fixture-"));
  try {
    await writeFile(
      join(directory, "temporary-client.ts"),
      'import "~/server/db"; const temporary = defineOperationDomain({});',
    );
    const files = sourceFiles(SOURCE_ROOT);
    expect(files).not.toContain(join(directory, "temporary-client.ts"));
    expect(files).toContain(join(SOURCE_ROOT, "server/mcp/server.ts"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
