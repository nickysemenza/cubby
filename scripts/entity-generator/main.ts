import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sealArtifact,
  checkSealedEntityArtifacts,
  writeEntityArtifacts,
} from "./artifacts.ts";
import {
  EntityDeclarationError,
  loadEntityDeclarations,
} from "./declarations.ts";
import type { CompiledEntity } from "./declarations.ts";
import { renderEntityArtifacts } from "./render/index.ts";
import { renderFilterArtifacts } from "./render/filters.ts";
import { renderKernelBindingsArtifacts } from "./render/kernel-bindings.ts";
import { renderRelationArtifacts } from "./render/relations.ts";
import { missingBrowserRouteFiles } from "./render/routes.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const renderAllArtifacts = (entities: readonly CompiledEntity[]) => [
  ...renderEntityArtifacts(entities),
  ...renderRelationArtifacts(entities),
  ...renderKernelBindingsArtifacts(entities),
  ...renderFilterArtifacts(entities),
];

const generateEntityArtifacts = async (root = ROOT) => {
  const entities = await loadEntityDeclarations();
  const artifacts = renderAllArtifacts(entities).map((artifact) =>
    sealArtifact(root, artifact),
  );
  return { entities, artifacts };
};

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
  if (check) {
    const entities = await loadEntityDeclarations();
    const artifacts = renderAllArtifacts(entities);
    const problems = await checkSealedEntityArtifacts(ROOT, artifacts);
    if (problems.length > 0) {
      throw new EntityDeclarationError(
        `Generated entity artifacts are out of date:\n${problems.join("\n")}`,
      );
    }
    const missingRoutes = missingBrowserRouteFiles(entities);
    if (missingRoutes.length > 0) {
      throw new EntityDeclarationError(
        `Generated browser routes are missing route modules:\n${missingRoutes.map((path) => `- ${path}`).join("\n")}`,
      );
    }
    return;
  }
  const { artifacts } = await generateEntityArtifacts();
  await writeEntityArtifacts(ROOT, artifacts);
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
