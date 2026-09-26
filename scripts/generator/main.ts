import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { connectedViews } from "../../packages/schemas/src/connected-view-definitions.ts";
import type { CompiledEntity } from "./entities/declarations.ts";
import { removeExtraArtifacts, writeArtifacts } from "./artifacts.ts";
import {
  EntityDeclarationError,
  loadEntityDeclarationBundle,
} from "./entities/declarations.ts";
import { renderOverrideComparisonArtifact } from "./entities/override-comparisons.ts";
import { renderAgentPromptArtifact } from "./agent-prompts.ts";
import type { EntityArtifacts } from "./entities/declarations.ts";
import { renderBrowserRouteArtifacts } from "./entities/render/browser-routes.ts";
import { renderFilterArtifacts } from "./entities/render/filters.ts";
import {
  entityOutputsFor,
  httpResourcesFor,
  renderEntityArtifacts,
} from "./entities/render/index.ts";
import { renderKernelBindingsArtifacts } from "./entities/render/kernel-bindings.ts";
import { renderRelationArtifacts } from "./entities/render/relations.ts";
import {
  missingBrowserRouteFiles,
  missingListSources,
} from "./entities/render/routes.ts";
import { writeRouteTree } from "./route-tree.ts";
import { renderShortcodeRegistryArtifact } from "./entities/shortcode-registry.ts";
import { renderSearchArtifacts } from "./entities/render/search.ts";
import { renderTimelineArtifacts } from "./entities/render/entity-timelines.ts";
import { validateEntityDeclarationImportBoundary } from "./entities/import-boundary.ts";

// `relationshipProvenanceSchema`'s local-path member; the schema module itself
// imports generated files, which do not exist yet when this validation runs.
const localPathProvenance = z.object({ kind: z.literal("local-path") });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
        if (route.length < 2)
          throw new EntityDeclarationError(
            `Connected view ${source}.${view.key} needs at least two relations`,
          );
        let current = source;
        for (const key of route) {
          const relation = byKey
            .get(current)
            ?.relations.find((candidate) => candidate.key === key);
          if (
            !relation ||
            !localPathProvenance.safeParse(relation.provenance).success
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
 * runtime-import `~/entities/generated/*.gen.ts`; the OpenAPI stage imports
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

  validateEntityDeclarationImportBoundary();
  await settle([await renderShortcodeRegistryArtifact()]);
  const { entities, declarations } = await loadEntityDeclarationBundle();
  validateConnectedViews(entities);
  await settle([await renderAgentPromptArtifact(ROOT)]);
  await settle([
    ...renderEntityArtifacts(entities),
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
  const missingSources = missingListSources(entities);
  if (missingSources.length > 0) {
    throw new EntityDeclarationError(
      `route.list is true, but these entities have no kernel list read (no create+update contract) and no list override in apps/web/src/entities/list-columns/index.ts to supply rows. Add one with a \`source\`, or declare list: null:\n${missingSources.map((key) => `- ${key}`).join("\n")}`,
    );
  }

  // The later stages import the earlier stages' artifacts, so they load only
  // after those are on disk: a fresh checkout has no generated files at all.
  const { renderStartOperationArtifacts } =
    await import("./start-operations/render.ts");
  const { renderHttpApiArtifacts } = await import("./http-api/openapi.ts");
  const { renderApplePreviewFixtures } =
    await import("../../apps/web/scripts/apple-preview-fixtures.ts");
  const resources = httpResourcesFor(entities);
  const startOperations = await renderStartOperationArtifacts(resources);
  await settle(startOperations.artifacts);
  await settle(
    await renderHttpApiArtifacts(
      resources,
      startOperations.nativeOperations,
      entityOutputsFor(entities),
      entities,
    ),
  );
  await settle(renderApplePreviewFixtures());

  // Extraneous files are judged once, over every stage: the stages share
  // output directories, so a per-stage scan would remove the others' files.
  const removed = await removeExtraArtifacts(ROOT, written);
  await writeRouteTree(ROOT);
  // ensure.ts reruns generation when any of these is missing.
  const outputs = resolve(ROOT, "node_modules/.cache/cubby-generate.outputs");
  await mkdir(dirname(outputs), { recursive: true });
  await writeFile(
    outputs,
    [
      ...written.map(({ relativePath }) => relativePath),
      "apps/web/src/routeTree.gen.ts",
    ]
      .sort()
      .join("\n") + "\n",
  );
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
