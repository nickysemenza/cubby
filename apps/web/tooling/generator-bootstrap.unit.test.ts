import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Install starts with no generated schemas. A warm Vitest import graph hides
// renderer dependencies on those outputs, so load the real renderer afresh.
it("renders native shared constants before generated schemas exist", () => {
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
    const { renderSwiftSharedConstants } = await import('./scripts/generator/entities/render/swift-shared-constants.ts');
    console.log(renderSwiftSharedConstants().length);
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
