import { readBuildOutput } from "@cloudflare/build-output-utils";
import { convertToWranglerConfig, type ModuleType } from "@cloudflare/config";
import path from "node:path";
import type { Unstable_RawConfig } from "wrangler";

// Wrangler retains the public test API for Workflow introspection, Durable
// Object eviction and structured logs. cf's CLI does not export a test harness.
export { createTestHarness } from "wrangler";
export type { TestHarness, TestHarnessOptions } from "wrangler";

type ModuleRule = NonNullable<
  ReturnType<typeof convertToWranglerConfig>["rules"]
>[number];

const moduleRuleTypes = {
  esm: "ESModule",
  cjs: "CommonJS",
  wasm: "CompiledWasm",
  text: "Text",
  data: "Data",
} satisfies Record<
  Exclude<ModuleType, "json" | "sourcemap" | "python" | "python-requirement">,
  ModuleRule["type"]
>;

/** Adapt v2 build output to Wrangler's public, in-memory test configuration. */
export async function builtWorkerTestConfig(root: string) {
  const output = await readBuildOutput(root);
  const built = output.workers.default;
  const { manifest, ...worker } = built.config;
  if (!built.bundleDir || !manifest)
    throw new Error(
      `The built Worker at ${built.configPath} has no bundle manifest`,
    );
  const config: Unstable_RawConfig = convertToWranglerConfig({
    worker: {
      ...worker,
      entrypoint: path.resolve(built.bundleDir, manifest.mainModule),
    },
    containers: [],
  });
  const rules: ModuleRule[] = Object.values(moduleRuleTypes).map((type) => ({
    type,
    globs: [],
    // The manifest owns module membership, including overriding discovery's
    // extension-based defaults for text, data and WASM.
    fallthrough: false,
  }));
  for (const [name, module] of Object.entries(manifest.modules)) {
    if (module.type === "sourcemap") continue;
    if (
      module.type === "json" ||
      module.type === "python" ||
      module.type === "python-requirement"
    )
      throw new Error(
        `The test harness cannot represent native ${module.type} module ${name} from ${built.configPath}`,
      );
    const type = moduleRuleTypes[module.type];
    rules.find((rule) => rule.type === type)?.globs.push(name);
  }
  return {
    ...config,
    compatibility_date: worker.compatibilityDate,
    // Match createTestHarness's prebuiltWorkerDir behavior without loading a
    // second source config: execute the built modules without rebundling.
    base_dir: built.bundleDir,
    no_bundle: true,
    find_additional_modules: true,
    rules,
    // Assets are copied into the build output; their path is not the original
    // Vite output directory and must not depend on the caller's cwd.
    assets: built.assetsDir
      ? { ...config.assets, directory: built.assetsDir }
      : undefined,
  };
}
