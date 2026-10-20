import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Install starts with no generated schemas. A warm Vitest import graph hides
// renderer dependencies on those outputs, so load the real renderer afresh.
it.each([
  {
    name: "native shared constants",
    module: "./apps/web/generator/entities/render/swift-shared-constants.ts",
    size: "module.renderSwiftSharedConstants().length",
  },
  {
    name: "declaration pagination primitives",
    module: "./packages/schemas/src/pagination.ts",
    size: "module.sortDirection.options.length",
  },
])("loads $name before generated schemas exist", ({ module, size }) => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const probe = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url.includes('/generated/')) {
        throw new Error('Cold generator imported an output: ' + resolved.url);
      }
      return resolved;
    }});
    const module = await import(${JSON.stringify(module)});
    // Not console.log: Nx sets FORCE_COLOR, which colors an inspected number.
    process.stdout.write(String(${size}));
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", probe],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: "apps/web/tsconfig.json" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  expect(Number(output.trim())).toBeGreaterThan(0);
});
