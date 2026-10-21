import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// This pinned dependency patch must release syntax trees without losing import
// protection's names or diagnostic positions; browser journeys cannot see caches.
const require = createRequire(
  import.meta.resolve("@tanstack/react-start/package.json"),
);
const analysis = await import(
  pathToFileURL(
    join(
      dirname(require.resolve("@tanstack/start-plugin-core/package.json")),
      "dist/esm/import-protection/analysis.js",
    ),
  ).href
);

const compactResult = z.object({
  parsedAst: z.undefined().optional(),
  analysis: z.object({ ast: z.undefined().optional() }),
});

test("import analysis caches names without retaining every module's syntax tree", () => {
  const result = {
    code: 'import { secret as value } from "./secret.server";\nexport { shared as renamed } from "./shared";\nexport type { OnlyType } from "./types";',
    filename: "synthetic.ts",
    map: undefined,
    originalCode: undefined,
  };
  assert.deepEqual(analysis.getImportSourcesFromResult(result), [
    "./secret.server",
    "./shared",
  ]);
  assert.deepEqual(analysis.getNamedExportsFromResult(result), ["renamed"]);
  compactResult.parse(result);
});

test("cached analysis still finds unsafe usage after safe boundaries and shadowed names", () => {
  const result = {
    code: 'import { secret } from "./secret.server";\nconst safe = createServerFn().handler(() => secret());\nfunction shadow(secret) { return secret(); }\nexport const unsafe = secret();',
    filename: "synthetic.ts",
    map: undefined,
    originalCode: undefined,
  };
  analysis.getImportSourcesFromResult(result);
  assert.deepEqual(
    analysis.findOriginalUnsafeUsagePosFromResult(
      result,
      "./secret.server",
      "client",
    ),
    { line: 4, column0: 22 },
  );
  compactResult.parse(result);
  assert.deepEqual(
    analysis.findOriginalUnsafeUsagePosFromResult(
      result,
      "./secret.server",
      "client",
    ),
    { line: 4, column0: 22 },
  );
  compactResult.parse(result);
});
