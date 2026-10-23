import { modulesChildren } from "@cubby/schemas/compiler/child-tables/modules";
import { retainedTableExports } from "@cubby/schemas/compiler/child-tables/retained";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  connectedViews,
  derivedConnectedRelationship,
} from "@cubby/schemas/compiler/connected-view-definitions";
import type {
  CompiledEntity,
  EntityArtifacts,
} from "./entities/declarations.ts";
import {
  ARTIFACT_MANIFEST,
  removeExtraArtifacts,
  writeArtifacts,
} from "./artifacts.ts";
import { EntityDeclarationError } from "./entities/source.ts";
import { renderShortcodeRegistryArtifacts } from "./entities/shortcode-registry.ts";

// `relationshipProvenanceSchema`'s local-path member; the schema module itself
// imports generated files, which do not exist yet when this validation runs.
const localPathProvenance = z.object({ kind: z.literal("local-path") });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const validateConnectedViews = (entities: readonly CompiledEntity[]) => {
  const byKey = new Map(entities.map((entity) => [entity.key, entity]));
  for (const [source, views] of Object.entries(connectedViews)) {
    if (!byKey.has(source))
      throw new EntityDeclarationError(
        `Unknown connected-view source ${source}`,
      );
    const keys = new Set<string>();
    for (const view of views) {
      if (keys.has(view.key))
        throw new EntityDeclarationError(
          `Duplicate connected view ${source}.${view.key}`,
        );
      keys.add(view.key);
      for (const route of view.routes) {
        if (route.length < ("evidence" in view && view.evidence ? 1 : 2))
          throw new EntityDeclarationError(
            `Connected view ${source}.${view.key} has too few relations for its presentation`,
          );
        let current = source;
        for (const [index, key] of route.entries()) {
          const relation = byKey
            .get(current)
            ?.relations.find((candidate) => candidate.key === key);
          if (
            !relation ||
            (!localPathProvenance.safeParse(relation.provenance).success &&
              !(
                derivedConnectedRelationship(current, key)?.target ===
                  relation.target && index === route.length - 1
              ))
          ) {
            throw new EntityDeclarationError(
              `Connected view ${source}.${view.key} has no local ${current}.${key} relation`,
            );
          }
          current = relation.target;
        }
        if (current !== view.target)
          throw new EntityDeclarationError(
            `Connected view ${source}.${view.key} reaches ${current}, expected ${view.target}`,
          );
      }
    }
  }
};

/**
 * `pnpm generate` writes every generated output; none is committed. The
 * stages run in order because each later stage imports the earlier stages'
 * files from disk (declarations import the shortcode registry; contracts
 * runtime-import `~/entity/generated/*.gen.ts`; the native contract stage imports
 * `http-contract.gen.ts`), so the later stages load only after the earlier
 * ones are written.
 */
const main = async () => {
  const unknownArguments = process.argv.slice(2);
  if (unknownArguments.length > 0) {
    throw new EntityDeclarationError(
      `Unknown arguments: ${unknownArguments.join(", ")}.`,
    );
  }

  const written: EntityArtifacts[] = [];
  const changed: string[] = [];
  const settle = async (artifacts: readonly EntityArtifacts[]) => {
    changed.push(...(await writeArtifacts(ROOT, artifacts)));
    written.push(...artifacts);
  };

  // Raw schema constructors consume shortcode schemas. Bootstrap their registry
  // before loading any compiler or renderer that can reach those constructors.
  await settle(await renderShortcodeRegistryArtifacts());
  const { validateEntityDeclarationImportBoundary } =
    await import("./entities/import-boundary.ts");
  const { validateRetainedTableBoundary } =
    await import("./entities/child-table-boundary.ts");
  const { loadEntityDeclarationBundle } =
    await import("./entities/declarations.ts");
  const { renderOverrideComparisonArtifact } =
    await import("./entities/override-comparisons.ts");
  const { renderAgentPromptArtifact } = await import("./agent-prompts.ts");
  const { renderPlaybookArtifact } = await import("./playbooks.ts");
  const { renderBrowserRouteArtifacts } =
    await import("./entities/render/browser-routes.ts");
  const { renderFilterArtifacts } =
    await import("./entities/render/filters.ts");
  const { entityOutputsFor, kernelHttpActionsFor, renderEntityArtifacts } =
    await import("./entities/render/index.ts");
  const { renderKernelBindingsArtifacts } =
    await import("./entities/render/kernel-bindings.ts");
  const { renderRelationArtifacts } =
    await import("./entities/render/relations.ts");
  const { missingBrowserRouteFiles } =
    await import("./entities/render/routes.ts");
  const { writeRouteTree } = await import("./route-tree.ts");
  const { renderSearchArtifacts } = await import("./entities/render/search.ts");
  const { renderTimelineArtifacts } =
    await import("./entities/render/entity-timelines.ts");
  validateEntityDeclarationImportBoundary();
  validateRetainedTableBoundary(
    await readFile(resolve(ROOT, "apps/web/src/server/db/schema.ts"), "utf8"),
    new Set(retainedTableExports),
  );
  const { entities, declarations } = await loadEntityDeclarationBundle();
  validateConnectedViews(entities);
  await settle([
    await renderAgentPromptArtifact(ROOT),
    await renderPlaybookArtifact(ROOT),
  ]);
  await settle([
    ...renderEntityArtifacts(entities, modulesChildren),
    renderOverrideComparisonArtifact(declarations, entities),
    ...renderRelationArtifacts(entities),
    ...renderKernelBindingsArtifacts(entities),
    ...renderFilterArtifacts(entities),
    ...renderSearchArtifacts(entities),
    ...renderTimelineArtifacts(entities),
    ...renderBrowserRouteArtifacts(entities),
  ]);
  const missingRoutes = missingBrowserRouteFiles(entities);
  if (missingRoutes.length > 0) {
    throw new EntityDeclarationError(
      `Declared browser routes are missing hand-written route modules:\n${missingRoutes.map((path) => `- ${path}`).join("\n")}`,
    );
  }

  // The later stages import the earlier stages' artifacts, so they load only
  // after those are on disk: a fresh checkout has no generated files at all.
  const { renderStartOperationArtifacts } =
    await import("./start-operations/render.ts");
  const { renderDirectNativeArtifacts } =
    await import("./http-api/native-artifacts.ts");
  const { renderApplePreviewFixtures } =
    await import("../tooling/checks/apple-preview-fixtures.ts");
  const { renderMcpToolArtifacts } =
    await import("./start-operations/mcp-tools.ts");
  const startOperations = await renderStartOperationArtifacts();
  await settle(startOperations.artifacts);
  await settle(await renderMcpToolArtifacts());
  await settle(
    await renderDirectNativeArtifacts(
      kernelHttpActionsFor(entities),
      startOperations.nativeOperations,
      entityOutputsFor(entities),
    ),
  );
  await settle(renderApplePreviewFixtures());

  // Extraneous files are judged once, over every stage: the stages share
  // output directories, so a per-stage scan would remove the others' files.
  const removed = await removeExtraArtifacts(ROOT, written);
  await writeFile(
    resolve(ROOT, ARTIFACT_MANIFEST),
    `${JSON.stringify(written.map(({ relativePath }) => relativePath).sort(), null, 2)}\n`,
  );
  await writeRouteTree(ROOT);
  console.log(
    changed.length === 0 && removed.length === 0
      ? "Generated artifacts are unchanged."
      : [
          `Generated ${changed.length} changed artifacts.`,
          ...removed.map((path) => `Removed ${path}`),
        ].join("\n"),
  );
};

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
