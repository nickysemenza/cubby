import { z } from "zod";
import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import {
  isObjectSchema,
  type JsonSchema,
  mapSchemas,
} from "./document-passes.ts";
import type { OpenApiDocument } from "./openapi.ts";
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

const COMPONENT_PREFIX = "#/components/schemas/";
const componentName = (ref: string) => ref.replace(COMPONENT_PREFIX, "");

/**
 * Every component a schema references through the keywords the generator
 * renders (`mapSchemas` walks exactly those; a `propertyNames` ref on a keyed
 * map has no Swift type behind it).
 */
const collectSchemaRefs = (schema: JsonSchema, into: Set<string>): void => {
  mapSchemas(schema, (node) => {
    if (node.$ref !== undefined) into.add(componentName(node.$ref));
    return node;
  });
};

/** A body or response content map: every route-level schema is a `$ref`. */
const contentObject = z.object({
  content: z
    .record(
      z.string(),
      z.object({ schema: z.object({ $ref: z.string() }).optional() }),
    )
    .optional(),
});
const routedOperation = z.looseObject({
  operationId: z.string(),
  requestBody: contentObject.optional(),
  responses: z.record(z.string(), z.looseObject(contentObject.shape)),
});
const contentRefs = (
  carrier: z.infer<typeof contentObject> | undefined,
  into: Set<string>,
) => {
  for (const media of Object.values(carrier?.content ?? {}))
    if (media.schema) into.add(componentName(media.schema.$ref));
};

const httpVerbs = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
]);
/**
 * The components the filtered native client carries: everything reachable
 * from a native operation's request body or responses, transitively. This is
 * the same closure swift-openapi-generator computes for `filter.operations`,
 * so an alias here always has a generated type behind it.
 */
const reachableComponents = (
  document: OpenApiDocument,
  components: Readonly<Record<string, JsonSchema>>,
  nativeOperationIds: ReadonlySet<string>,
  additionalRoots: readonly string[] = [],
): Set<string> => {
  const roots = new Set<string>(additionalRoots);
  for (const item of Object.values(document.paths)) {
    for (const [method, raw] of Object.entries(item)) {
      if (!httpVerbs.has(method)) continue;
      const operation = routedOperation.parse(raw);
      if (!nativeOperationIds.has(operation.operationId)) continue;
      contentRefs(operation.requestBody, roots);
      for (const response of Object.values(operation.responses))
        contentRefs(response, roots);
    }
  }
  const reachable = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    // SAFETY: the loop condition guarantees a remaining element.
    const name = pending.pop() as string;
    if (reachable.has(name)) continue;
    const schema = components[name];
    if (schema === undefined)
      throw new Error(
        `APITypes.swift: #/components/schemas/${name} is referenced by a native operation but is not in the document`,
      );
    reachable.add(name);
    const nested = new Set<string>();
    collectSchemaRefs(schema, nested);
    for (const next of nested) if (!reachable.has(next)) pending.push(next);
  }
  return reachable;
};

const hasIdProperty = (schema: JsonSchema | undefined) =>
  schema !== undefined &&
  isObjectSchema(schema) &&
  schema.type === "object" &&
  schema.properties?.id !== undefined;

export type EntityOutputs = ReadonlyMap<string, string | null>;

/**
 * `CubbyKit/Generated/APITypes.swift`: one `public typealias` per named
 * component the native client carries, so hand-written Swift never spells
 * `Components.Schemas.*`; `<Entity>`, `<Entity>ListItem` and `<Entity>Detail`
 * for every entity with HTTP resources; and `Identifiable` (same package, so not retroactive) for
 * every aliased object that carries an `id`.
 *
 * `entityOutputs` maps an entity key to its output schema's export name
 * (`product` → `productTopLevelOut`), from the entity declarations.
 */
export const renderApiTypes = (
  document: OpenApiDocument,
  components: Readonly<Record<string, JsonSchema>>,
  nativeOperationIds: ReadonlySet<string>,
  entityOutputs: EntityOutputs,
  additionalRoots: readonly string[] = [],
): EntityArtifacts => {
  const reachable = reachableComponents(
    document,
    components,
    nativeOperationIds,
    additionalRoots,
  );
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

  const resourceEntities = [...nativeOperationIds]
    .flatMap((id) => {
      const match = /^resources\.([^.]+)\.(?:list|get)$/u.exec(id);
      return match ? [match[1]!] : [];
    })
    .filter((entity, index, all) => all.indexOf(entity) === index)
    .sort((a, b) => a.localeCompare(b));
  const entityAliases: string[] = [];
  for (const entity of resourceEntities) {
    const base = pascal(entity);
    const aliasBase = SHADOWED_ENTITY_NAMES.has(base) ? `${base}Record` : base;
    const output = entityOutputs.get(entity);
    const outputComponent =
      output === null || output === undefined ? undefined : pascal(output);
    if (outputComponent !== undefined && reachable.has(outputComponent))
      entityAliases.push(
        `public typealias ${aliasBase} = Components.Schemas.${outputComponent}`,
      );
    // `<Entity>ListItem` / `<Entity>Detail` are the components' own names, so
    // the component aliases below cover them; here they only have to exist.
    for (const [suffix, operation] of [
      ["ListItem", "list"],
      ["Detail", "get"],
    ] as const) {
      if (!nativeOperationIds.has(`resources.${entity}.${operation}`)) continue;
      const component = `${base}${suffix}`;
      if (!reachable.has(component))
        throw new Error(
          `APITypes.swift: resources.${entity}.${operation} is native but #/components/schemas/${component} is not reachable from it`,
        );
    }
  }

  return {
    relativePath:
      "apps/apple/CubbyKit/Sources/CubbyKit/Generated/APITypes.swift",
    source:
      `${generatedHeader}// swift-format-ignore-file\n` +
      "// Every named component the filtered CubbyAPI client carries, aliased so hand-written\n" +
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
