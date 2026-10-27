import { spawnSync } from "node:child_process";
import { it, expect } from "vitest";

it("loads the entity compiler without preexisting generated schema artifacts", () => {
  const compiler = new URL("../generator/entities/compile.ts", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { registerHooks } from "node:module";
       registerHooks({ resolve(specifier, context, nextResolve) {
         const result = nextResolve(specifier, context);
         if (result.url.includes("/packages/schemas/src/generated/"))
           throw new Error("Compiler bootstrap requires a generated schema: " + result.url);
         return result;
       }});
       await import(${JSON.stringify(compiler.href)});`,
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  expect({
    status: result.status,
    diagnostics: result.status === 0 ? "" : result.stderr,
  }).toEqual({ status: 0, diagnostics: "" });
});
