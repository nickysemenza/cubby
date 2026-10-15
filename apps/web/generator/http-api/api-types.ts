import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import { isObjectSchema, type JsonSchema } from "./document-passes.ts";
import { pascal } from "./schema-names.ts";

/**
 * Component names swift-openapi-generator would have rendered anyway but
 * that name nothing a person should write: anonymous shared definitions.
 */
const ANONYMOUS_COMPONENT =
  /^(?:(?:input|output)_|(?:Input|Output)Shared[0-9A-F]{16}$)/u;

/**
 * Entity aliases that would shadow a Swift or SwiftUI type at every use site
 * (`Task` is `_Concurrency.Task`; `Image` is `SwiftUI.Image`). These take a
 * `Record` suffix instead so the alias stays usable without qualification.
 */
const SHADOWED_ENTITY_NAMES = new Set(["Task", "Image"]);

const hasIdProperty = (schema: JsonSchema | undefined) =>
  schema !== undefined &&
  isObjectSchema(schema) &&
  schema.type === "object" &&
  schema.properties?.id !== undefined;

export type EntityOutputs = ReadonlyMap<string, string | null>;

/**
 * `CubbyKit/Generated/APITypes.swift`: one `public typealias` per named
 * component in the (already pruned) native document, so hand-written Swift
 * never spells `Components.Schemas.*`; `<Entity>` for every entity whose
 * output component the document carries; and `Identifiable` (same package,
 * so not retroactive) for every aliased object that carries an `id`.
 *
 * `entityOutputs` maps an entity key to its output schema's export name
 * (`product` → `productTopLevelOut`), from the entity declarations.
 */
export const renderApiTypes = (
  components: Readonly<Record<string, JsonSchema>>,
  entityOutputs: EntityOutputs,
): EntityArtifacts => {
  const reachable = new Set(Object.keys(components));
  const aliased = [...reachable]
    .filter(
      (name) =>
        !ANONYMOUS_COMPONENT.test(name) && /^[A-Z][A-Za-z0-9]*$/u.test(name),
    )
    .sort((a, b) => a.localeCompare(b));
  const identifiable = aliased.filter((name) =>
    hasIdProperty(components[name]),
  );

  const photoImportAliases = reachable.has("PhotoImportCommitInput")
    ? [
        "public typealias PhotoImportStageItem = Components.Schemas.PhotoImportStageInput.ItemsPayloadPayload",
        "public typealias PhotoImportStageResult = Components.Schemas.PhotoImportStageOutput.ItemsPayloadPayload",
        "public typealias PhotoImportStageExisting = Components.Schemas.PhotoImportStageOutput.ItemsPayloadPayload.Value1Payload",
        "public typealias PhotoImportStageUpload = Components.Schemas.PhotoImportStageOutput.ItemsPayloadPayload.Value2Payload",
        "public typealias PhotoImportCommitImage = Components.Schemas.PhotoImportCommitInput.ImagesPayloadPayload",
        "public typealias PhotoImportSourcePayload = Components.Schemas.PhotoImportCommitInput.ImagesPayloadPayload.SourcePayload",
        "public typealias PhotoImportDuplicateDecisionPayload = Components.Schemas.PhotoImportCommitInput.ImagesPayloadPayload.DuplicateDecisionPayload",
        "public typealias PhotoImportCommitDestination = Components.Schemas.PhotoImportCommitInput.ImagesPayloadPayload.DestinationPayload",
        "public typealias PhotoImportExistingDestination = Components.Schemas.PhotoImportCommitInput.ImagesPayloadPayload.DestinationPayload.Value1Payload",
        "public typealias PhotoImportCreateDestination = Components.Schemas.PhotoImportCommitInput.ImagesPayloadPayload.DestinationPayload.Value2Payload",
        "public typealias PhotoImportAnalysisPayload = Components.Schemas.PhotoImportCommitInput.ImagesPayloadPayload.AnalysisPayload",
        "public typealias PhotoImportClassificationPayload = Components.Schemas.PhotoImportCommitInput.ImagesPayloadPayload.AnalysisPayload.ClassificationsPayloadPayload",
        "public typealias PhotoImportRecognizedTextPayload = Components.Schemas.PhotoImportCommitInput.ImagesPayloadPayload.AnalysisPayload.RecognizedTextPayloadPayload",
        "public typealias PhotoImportFeaturePrintPayload = Components.Schemas.PhotoImportCommitInput.ImagesPayloadPayload.AnalysisPayload.FeaturePrintPayload",
        "public typealias PhotoImportProvenancePayload = Components.Schemas.PhotoImportCommitInput.ImagesPayloadPayload.AnalysisPayload.ProvenancePayload",
        "public typealias PhotoImportCreatePayload = Components.Schemas.PhotoImportCommitInput.CreatesPayloadPayload",
        "public typealias PhotoImportCreateBody = Components.Schemas.PhotoImportCommitInput.CreatesPayloadPayload.BodyPayload",
      ]
    : [];

  const entityAliases = [...entityOutputs]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([entity, output]) => {
      const base = pascal(entity);
      const aliasBase = SHADOWED_ENTITY_NAMES.has(base)
        ? `${base}Record`
        : base;
      const component = output === null ? undefined : pascal(output);
      return component !== undefined && reachable.has(component)
        ? [`public typealias ${aliasBase} = Components.Schemas.${component}`]
        : [];
    });
  return {
    relativePath:
      "apps/apple/CubbyKit/Sources/CubbyKit/Generated/APITypes.swift",
    source:
      `${generatedHeader}// swift-format-ignore-file\n` +
      "// Every named component the CubbyAPI client carries, aliased so hand-written\n" +
      "// Swift names generated types without spelling `Components.Schemas`. Anonymous\n" +
      "// `InputShared…`/`OutputShared…` components are never aliased. Entity aliases follow the\n" +
      "// entity key; `Task` and `Image` would shadow Swift/SwiftUI types, so those take a `Record` suffix.\n\n" +
      "import CubbyAPI\n\n" +
      "// MARK: - Entities\n\n" +
      `${entityAliases.join("\n")}\n\n` +
      "// MARK: - Components\n\n" +
      `${aliased.map((name) => `public typealias ${name} = Components.Schemas.${name}`).join("\n")}\n\n` +
      "// MARK: - Photo import payloads\n\n" +
      `${photoImportAliases.join("\n")}\n\n` +
      "// MARK: - Identifiable\n\n" +
      `${identifiable.map((name) => `extension Components.Schemas.${name}: Identifiable {}`).join("\n")}\n`,
  };
};
