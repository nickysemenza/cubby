import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkArtifacts,
  findExtraArtifacts,
  sealArtifacts,
  writeArtifacts,
} from "./artifacts.ts";
import {
  EntityDeclarationError,
  loadEntityDeclarations,
} from "./entities/declarations.ts";
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
import { missingBrowserRouteFiles } from "./entities/render/routes.ts";
import { renderSearchArtifacts } from "./entities/render/search.ts";
import { renderTimelineArtifacts } from "./entities/render/entity-timelines.ts";
import { renderHttpApiArtifacts } from "./http-api/openapi.ts";
import { renderStartOperationArtifacts } from "./start-operations/render.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `pnpm generate` runs three stages in order. Each later stage imports the
 * previous stage's files from disk (contracts runtime-import
 * `~/entities/generated/*.gen.ts`; the OpenAPI stage imports
 * `http-contract.gen.ts`), so every stage's artifacts are written before the
 * next stage renders. With `--check` nothing is written: each stage renders
 * against the committed files and the problems are reported together.
 */
const main = async () => {
  const check = process.argv.slice(2).includes("--check");
  const unknownArguments = process.argv
    .slice(2)
    .filter((argument) => argument !== "--check");
  if (unknownArguments.length > 0) {
    throw new EntityDeclarationError(
      `Unknown arguments: ${unknownArguments.join(", ")}.`,
    );
  }

  const problems: string[] = [];
  const written: EntityArtifacts[] = [];
  const settle = async (artifacts: readonly EntityArtifacts[]) => {
    if (check) {
      problems.push(...(await checkArtifacts(ROOT, artifacts)));
    } else {
      await writeArtifacts(ROOT, await sealArtifacts(ROOT, artifacts));
    }
    written.push(...artifacts);
  };

  const entities = await loadEntityDeclarations();
  await settle([
    ...renderEntityArtifacts(entities),
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

  // Extraneous files are judged once, over every stage: the stages share
  // output directories, so a per-stage scan would flag the others' files.
  problems.push(
    ...(await findExtraArtifacts(ROOT, written)).map(
      (path) => `extraneous: ${path}`,
    ),
  );
  if (problems.length > 0) {
    throw new EntityDeclarationError(
      check
        ? `Generated artifacts are out of date; run pnpm generate:\n${problems.join("\n")}`
        : `Generated artifacts left files nothing generates; delete them:\n${problems.join("\n")}`,
    );
  }
};

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
