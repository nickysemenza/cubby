import {
  copyFileSync,
  existsSync,
  globSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";

export const storageOwners = [
  "src/server/generic/entity-links/repo/entity-external-ids.ts",
  "src/server/domains/product/repo/gtin.ts",
  "src/server/domains/product/repo/find-by-external-ids.ts",
  "src/server/domains/product/repo/external-id-collisions.ts",
  "src/server/domains/product/repo/external-id-types.ts",
  "src/server/db/generated/identity-storage-tables.gen.ts",
  "src/server/db/external-identifier-tables.ts",
  "src/server/db/schema-primitives.ts",
  "src/server/db/entity-identity-schema.ts",
  "src/server/db/helpers/predicates.ts",
  "src/server/db/generated/entity-table-definitions.gen.ts",
  "src/server/db/retained-tables.ts",
  "src/server/db/helpers/query.ts",
  "src/server/db/helpers/crud.ts",
  "src/server/db/helpers/transform.ts",
  "src/server/generic/list/repo/list-contracts.ts",
  "src/server/generic/entity-links/repo/entity-links.ts",
  "src/server/generic/list/repo/label-canonical.ts",
  "src/server/generic/work-queue/repo/catch-up-claim.ts",
  "src/server/generic/assessment/repo/assessment-image.ts",
  "src/server/generic/assessment/repo/assessment-state.ts",
  "src/server/generic/assessment/repo/assessment.ts",
  "src/server/generic/problems/repo/detectors-vendor.ts",
  "src/server/generic/problems/repo/detectors-purchase.ts",
  "src/server/generic/problems/repo/reparse.ts",
  "src/server/ai/repo/ai-evaluation-requests.ts",
  "src/server/entity-kernel/repo/entity-identity.ts",
  "src/server/entity-kernel/repo/debug.ts",
  "src/server/entity-kernel/repo/singular-attachment.ts",
  "src/server/domains/email/repo/email-financial-associations.ts",
  "src/server/domains/ledger-party/repo/current-member-party.ts",
  "src/server/domains/run/repo/reclassification-recovery-state.ts",
  "src/server/domains/device/repo/device-participation.ts",
  "src/server/domains/spending-category/repo/spending-classification-review-authorization.ts",
  "src/server/domains/inventory/repo/stock-tracking.ts",
  "src/server/domains/inventory/repo/product-stock.ts",
  "src/server/domains/product/repo/product-identifier-source.ts",
  "src/server/domains/product/repo/upc-lookup-cache.ts",
  "src/server/domains/recipe/repo/totals.ts",
  "src/server/domains/location/repo/ai-description.ts",
  "src/server/domains/location/repo/home.ts",
  "src/server/domains/mail/repo/retained-mail.ts",
  "src/server/domains/purchase-import/repo/capabilities.ts",
  "src/server/domains/purchase-import/repo/agent-auth.ts",
  "src/server/domains/purchase-import/repo/gmail/reclassification-receipt.ts",
  "src/server/domains/financial-transaction/repo/financial-evidence.ts",
  "src/server/domains/expense/repo/attribution-defaults.ts",
  "src/server/domains/expense/repo/expense-category-resolution.ts",
  "src/server/db/external-id-schema.ts",
  "src/server/db/auth.schema.ts",
  "src/server/db/assessment-email-link-schema.ts",
  "src/server/db/entity-link-schema.ts",
  "src/server/observability/list-read-tracing.ts",
  "src/server/clients/r2-public-url.ts",
  "src/server/lib/zod-utils.ts",
  "src/server/db/helpers/dependency-graph.ts",
  "src/server/db/computed/product-category-sql.ts",
  "src/server/db/computed/location-ai-description.ts",
  "src/server/domains/cookbook/repo/cookbook-source-count.ts",
  "src/server/domains/email/repo/discovery-email-audit.ts",
  "src/server/domains/email/repo/email-purchase-associations.ts",
  "src/server/domains/email/repo/email-purchase-links.ts",
  "src/server/domains/email/repo/email-sql.ts",
  "src/server/domains/expense/repo/line-role-classifier.ts",
  "src/server/domains/expense/repo/match-grading.ts",
  "src/server/domains/financial-transaction/repo/financial-allocation-integrity.ts",
  "src/server/domains/financial-transaction/repo/financial-statement-preview.ts",
  "src/server/domains/image/repo/image-displayability.ts",
  "src/server/domains/image/repo/image-identification.ts",
  "src/server/domains/image/repo/image-integrity.ts",
  "src/server/domains/ingredient/repo/nutrition-product.ts",
  "src/server/domains/inventory/repo/ownership-evidence.ts",
  "src/server/domains/inventory/repo/slot.ts",
  "src/server/domains/inventory/repo/types.ts",
  "src/server/domains/location/repo/identity-product.ts",
  "src/server/domains/location/repo/internal-types.ts",
  "src/server/domains/location/repo/location-valuation-rollup.ts",
  "src/server/domains/location/repo/parse-type.ts",
  "src/server/domains/location/repo/tree-depth.ts",
  "src/server/domains/photo-import/repo/photo-correctness.ts",
  "src/server/domains/photo-import/repo/run/photo-group-steps.ts",
  "src/server/domains/plant/repo/windows.ts",
  "src/server/domains/product-category/repo/category-connections.ts",
  "src/server/domains/product/repo/book-title-match.ts",
  "src/server/domains/product/repo/conversion-coverage.ts",
  "src/server/domains/product/repo/discard-preview.ts",
  "src/server/domains/product/repo/helpers.ts",
  "src/server/domains/product/repo/kit-projection.ts",
  "src/server/domains/product/repo/match/product-match-ranking.ts",
  "src/server/domains/product/repo/nutrition-display.ts",
  "src/server/domains/product/repo/product-variant-comparison.ts",
  "src/server/domains/product/repo/write/scan-code.ts",
  "src/server/domains/project/repo/external-links.ts",
  "src/server/domains/purchase-import/repo/email-content.ts",
  "src/server/domains/purchase-import/repo/gmail/candidate-source.ts",
  "src/server/domains/purchase-import/repo/gmail/checksum.ts",
  "src/server/domains/purchase-import/repo/gmail/evidence-candidates.ts",
  "src/server/domains/purchase-import/repo/gmail/normalize.ts",
  "src/server/domains/purchase-import/repo/gmail/refresh-evaluation-state.ts",
  "src/server/domains/purchase-import/repo/gmail/targets.ts",
  "src/server/domains/purchase-import/repo/gmail/types.ts",
  "src/server/domains/purchase-import/repo/gmail/vendor-identity.ts",
  "src/server/domains/purchase-import/repo/import-scope.ts",
  "src/server/domains/purchase-import/repo/mail-run-membership.ts",
  "src/server/domains/purchase-import/repo/mail-source-identity.ts",
  "src/server/domains/purchase-import/repo/manufacturer-identity.ts",
  "src/server/domains/purchase-import/repo/source-claim-family.ts",
  "src/server/domains/purchase-import/repo/source-order-key.ts",
  "src/server/domains/purchase-import/repo/writer-policy.ts",
  "src/server/domains/purchase/repo/purchase-link-draft.ts",
  "src/server/domains/purchase/repo/purchase-settlement-allocation.ts",
  "src/server/domains/purchase/repo/purchase-settlement-review.ts",
  "src/server/domains/purchase/repo/settlement-grace.ts",
  "src/server/domains/recipe/repo/helpers.ts",
  "src/server/domains/recipe/repo/internal-types.ts",
  "src/server/domains/recipe/repo/meta.ts",
  "src/server/domains/recipe/repo/servings.ts",
  "src/server/domains/recipe/repo/source.ts",
  "src/server/domains/run/repo/execution-lineage.ts",
  "src/server/domains/run/repo/run-reclassification-read.ts",
  "src/server/domains/run/repo/run-target-merge.ts",
  "src/server/domains/statement-import/repo/statement-import-membership.ts",
  "src/server/domains/statement-import/repo/statement-row-identity.ts",
  "src/server/domains/task/repo/blocking-sql.ts",
  "src/server/domains/task/repo/helpers.ts",
  "src/server/domains/task/repo/summary.ts",
  "src/server/domains/task/repo/today-briefing.ts",
  "src/server/domains/vendor/repo/merchant-vendor-inference.ts",
  "src/server/entity-kernel/repo/detail-display-labels.ts",
  "src/server/entity-kernel/repo/impact.ts",
  "src/server/entity-kernel/repo/relation-preflight.ts",
  "src/server/generic/assessment/repo/assessment-email-link.ts",
  "src/server/generic/assessment/repo/assessment-email.ts",
  "src/server/generic/audit-log/repo/audit-receipts.ts",
  "src/server/generic/collection/repo/collection-items.ts",
  "src/server/generic/collection/repo/collection-membership.ts",
  "src/server/generic/collection/repo/smart-collection-membership.ts",
  "src/server/generic/data-quality/repo/checks/classification-policy.ts",
  "src/server/generic/data-quality/repo/checks/cookbook.ts",
  "src/server/generic/data-quality/repo/checks/device.ts",
  "src/server/generic/data-quality/repo/checks/email.ts",
  "src/server/generic/data-quality/repo/checks/financial-account.ts",
  "src/server/generic/data-quality/repo/checks/garden-entry.ts",
  "src/server/generic/data-quality/repo/checks/image-job.ts",
  "src/server/generic/data-quality/repo/checks/image.ts",
  "src/server/generic/data-quality/repo/checks/ingredient.ts",
  "src/server/generic/data-quality/repo/checks/inventory.ts",
  "src/server/generic/data-quality/repo/checks/ledger-party.ts",
  "src/server/generic/data-quality/repo/checks/ledger-transfer.ts",
  "src/server/generic/data-quality/repo/checks/location.ts",
  "src/server/generic/data-quality/repo/checks/meal.ts",
  "src/server/generic/data-quality/repo/checks/plant.ts",
  "src/server/generic/data-quality/repo/checks/planting.ts",
  "src/server/generic/data-quality/repo/checks/product-category.ts",
  "src/server/generic/data-quality/repo/checks/project.ts",
  "src/server/generic/data-quality/repo/checks/recipe.ts",
  "src/server/generic/data-quality/repo/checks/run.ts",
  "src/server/generic/data-quality/repo/checks/spending-category.ts",
  "src/server/generic/data-quality/repo/checks/vendor.ts",
  "src/server/generic/data-quality/repo/checks/wish.ts",
  "src/server/generic/data-quality/repo/exception-reasons.ts",
  "src/server/generic/data-quality/repo/registry.ts",
  "src/server/generic/embedding/repo/semantic/hash.ts",
  "src/server/generic/embedding/repo/semantic/text.ts",
  "src/server/generic/entity-graph/repo/entity-graph-path-search.ts",
  "src/server/generic/entity-links/repo/dependency-edges.ts",
  "src/server/generic/entity-report/repo/finance-section.ts",
  "src/server/generic/entity-report/repo/fold-repeats.ts",
  "src/server/generic/entity-report/repo/purchase-reconciliation.ts",
  "src/server/generic/field-explanation/repo/explanation-reference-values.ts",
  "src/server/generic/list/repo/hierarchy.ts",
  "src/server/generic/list/repo/list-all.ts",
  "src/server/generic/list/repo/list-display-labels.ts",
  "src/server/generic/list/repo/list-read-adapters.ts",
  "src/server/generic/merge/repo/collisions.ts",
  "src/server/generic/problems/repo/detectors-label-variants.ts",
  "src/server/generic/problems/repo/unused-aliases.ts",
  "src/server/generic/search/repo/search-lexical.ts",
  "src/server/generic/work-queue/repo/work-attention.ts",
  "src/server/generic/work-queue/repo/work-queue-projection.ts",
  "src/server/generic/work-queue/repo/work-queue-routing.ts",
] as const;

export function createStoragePrograms(
  appRoot: string,
  owners: readonly string[],
) {
  const app = resolve(appRoot);
  const repository = resolve(app, "../..");
  const storageState = join(app, "artifacts/storage-typecheck");
  const storageCache = join(storageState, "emit");
  const storageOutput = join(app, "artifacts/storage-contracts");
  const storageConfig = join(storageState, "tsconfig.storage.json");
  const storageServerConfig = join(storageState, "tsconfig.server.json");
  const storageBuildInfo = join(storageState, "storage.tsbuildinfo");

  function writeConfig(file: string, value: unknown) {
    const content = JSON.stringify(value, null, 2) + "\n";
    if (existsSync(file) && readFileSync(file, "utf8") === content) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  /** One ownership roster drives roots, consumer exclusions and exact contract paths. */
  function configureStoragePrograms(): void {
    const paths = {
      "~/*": [join(app, "src/*")],
      "tooling/*": [join(app, "tooling/*")],
    };
    writeConfig(storageConfig, {
      extends: join(app, "tsconfig.json"),
      include: [],
      exclude: [],
      files: [...owners, ...globSync("src/**/*.d.ts", { cwd: app })].map(
        (file) => join(app, file),
      ),
      compilerOptions: {
        types: ["vite/client"],
        rootDir: repository,
        outDir: storageCache,
        tsBuildInfoFile: storageBuildInfo,
        incremental: true,
        noEmit: false,
        noCheck: false,
        isolatedDeclarations: false,
        declaration: true,
        emitDeclarationOnly: true,
        noEmitOnError: true,
        paths: {
          ...paths,
          "~/server/db/repository-access.boundary": [
            join(
              app,
              "artifacts/server-contracts/server/db/repository-access.boundary.d.ts",
            ),
          ],
        },
      },
    });
    const server = JSON.parse(
      readFileSync(join(app, "tsconfig.server.json"), "utf8"),
    );
    writeConfig(storageServerConfig, {
      extends: join(app, "tsconfig.server.json"),
      exclude: [...server.exclude, ...owners].map((file: string) =>
        join(app, file),
      ),
      compilerOptions: {
        tsBuildInfoFile: join(storageState, "server.tsbuildinfo"),
        paths: {
          ...paths,
          ...Object.fromEntries(
            owners.map((file) => [
              `~/${file.slice(4, -3)}`,
              [join(storageOutput, "apps/web", file.slice(0, -3) + ".d.ts")],
            ]),
          ),
        },
      },
    });
  }

  const inventoryFile = join(storageState, "outputs.json");
  const outputFor = (file: string) =>
    join("apps/web", file.slice(0, -3) + ".d.ts");
  const revision = () =>
    existsSync(storageBuildInfo)
      ? statSync(storageBuildInfo, { bigint: true }).mtimeNs.toString()
      : "";

  /** The checked emitter's cache and build-info survive no-op and partial emits. */
  function buildStorage(
    compiler: string,
    compile: (args: string[]) => void,
    args: string[],
  ): void {
    let inventory: { revision: string; files: string[] } | undefined =
      existsSync(inventoryFile)
        ? JSON.parse(readFileSync(inventoryFile, "utf8"))
        : undefined;
    const expected = [...owners.map(outputFor), ...(inventory?.files ?? [])];
    if (
      !inventory?.revision ||
      expected.some((file) => !existsSync(join(storageCache, file)))
    )
      rmSync(storageBuildInfo, { force: true });
    compile(["--build", storageConfig, "--checkers", "1", ...args]);
    // A stopped process may have committed compiler state before this inventory.
    if (inventory?.revision !== revision()) {
      const graph = new Set(
        execFileSync(
          process.execPath,
          [compiler, "-p", storageConfig, "--listFilesOnly"],
          { cwd: app, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        ).split(/\r?\n/u),
      );
      const files = globSync("**/*.d.ts", { cwd: storageCache })
        .filter((file) => {
          const stem = resolve(repository, file.slice(0, -5));
          return graph.has(stem + ".ts") || graph.has(stem + ".tsx");
        })
        .sort();
      for (const file of owners.map(outputFor))
        if (!files.includes(file))
          throw new Error(`Missing checked storage declaration: ${file}`);
      const current = new Set(files);
      for (const file of globSync("**/*.d.ts", { cwd: storageCache }))
        if (!current.has(file)) rmSync(join(storageCache, file));
      inventory = { revision: revision(), files };
      writeConfig(inventoryFile, inventory);
    }
    if (!inventory)
      throw new Error("Storage declaration inventory was not produced");
    validateStorageDeclarations(inventory.files);
    publishStorage(inventory.files);
  }

  /** Publish a complete checked set; unchanged declarations retain their inodes/mtimes. */
  function publishStorage(files: readonly string[]): void {
    const pending = join(storageState, "publish.pending");
    const backup = join(storageState, "publish.previous");
    if (!existsSync(storageOutput) && existsSync(backup))
      renameSync(backup, storageOutput);
    const previous = globSync("**/*.d.ts", { cwd: storageOutput }).sort();
    const equal = (file: string) =>
      existsSync(join(storageOutput, file)) &&
      readFileSync(join(storageCache, file)).equals(
        readFileSync(join(storageOutput, file)),
      );
    if (
      previous.length === files.length &&
      files.every((file, index) => previous[index] === file && equal(file))
    )
      return;
    rmSync(pending, { recursive: true, force: true });
    mkdirSync(pending, { recursive: true });
    for (const file of files) {
      const target = join(pending, file);
      mkdirSync(dirname(target), { recursive: true });
      if (equal(file)) linkSync(join(storageOutput, file), target);
      else copyFileSync(join(storageCache, file), target);
    }
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(storageOutput)) renameSync(storageOutput, backup);
    try {
      renameSync(pending, storageOutput);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, storageOutput);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
  }

  function validateStorageDeclarations(files: readonly string[]): void {
    const complete = new Set(files.map((file) => resolve(storageCache, file)));
    for (const file of files) {
      const content = readFileSync(join(storageCache, file), "utf8");
      for (const match of content.matchAll(
        /\b(?:from\s+|import\s*\(\s*)["']([^"']+)["']/gu,
      )) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".")) continue;
        const path = resolve(storageCache, dirname(file), specifier).replace(
          /\.(?:[cm]?js|tsx?)$/u,
          "",
        );
        if (
          !complete.has(path + ".d.ts") &&
          !complete.has(join(path, "index.d.ts"))
        )
          throw new Error(
            `Incomplete storage declaration ${file}: ${specifier} (${relative(storageCache, path)})`,
          );
      }
    }
  }

  return {
    configure: configureStoragePrograms,
    build: buildStorage,
    config: storageConfig,
    serverConfig: storageServerConfig,
    output: storageOutput,
    cache: storageCache,
    state: storageState,
  };
}

export const storagePrograms = createStoragePrograms(
  resolve(import.meta.dirname, ".."),
  storageOwners,
);
