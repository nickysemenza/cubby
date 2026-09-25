import { z } from "zod";
import { generatedEntityFieldModels } from "../../../packages/schemas/src/generated/entity-field-model.gen.ts";
import { entityInspectorMetadata } from "../../../packages/schemas/src/generated/entity-inspector.gen.ts";
import { entityKeys } from "../../../packages/schemas/src/generated/entity-summary.gen.ts";
import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { JsonSchema } from "./document-passes.ts";
import type { OpenApiDocument } from "./openapi.ts";
import {
  type SwiftRoute,
  swiftList,
  swiftString,
  updateBodyHas,
} from "./swift-routes.ts";

// The generic Browse screens run over every catalog entity through one typed
// bridge: a switch per action over the generated per-entity operations,
// re-encoding each typed row into the JSONValue projection EntityRow reads.
export const resourceEntitiesFor = (
  swiftRoutes: readonly SwiftRoute[],
): Map<string, Set<string>> => {
  const resourceEntities = new Map<string, Set<string>>();
  for (const entry of swiftRoutes) {
    const match =
      /^resources\.([^.]+)\.(list|timeline|get|create|update|delete)$/u.exec(
        entry.id,
      );
    if (!match) continue;
    const actions = resourceEntities.get(match[1]!) ?? new Set<string>();
    actions.add(match[2]!);
    resourceEntities.set(match[1]!, actions);
  }
  return resourceEntities;
};
const swiftCase = (entity: string) =>
  entity.replace(/-([a-z])/gu, (_match, letter: string) =>
    letter.toUpperCase(),
  );
const swiftMethod = (entity: string, action: string) =>
  `resources_${entity.replace(/-/gu, "_")}_${action}`;
const swiftOperation = (entity: string, action: string) =>
  `Operations.Resources_${entity.replace(/-/gu, "_")}_${action}`;

// Every query parameter of a list/timeline route is one of these wire kinds;
// the generated arm converts the wire string(s) into the typed query property.
// Any other schema fails generation (extend the table, never guess).
type ParameterKind =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "integer" }
  | { kind: "boolean" }
  | { kind: "stringEnum"; values: string[] }
  | { kind: "stringArray" }
  | { kind: "enumArray"; values: string[] }
  | { kind: "anyOfString" }
  | { kind: "anyOfStringArray" }
  | { kind: "anyOfEnumArray"; values: string[] };

/** The parts of a parameter schema the classifier branches on. */
const schemaNode = z.looseObject({
  type: z.union([z.string(), z.array(z.string())]).optional(),
  enum: z.array(z.string()).optional(),
  const: z.string().optional(),
  anyOf: z.array(z.unknown()).optional(),
  items: z.unknown().optional(),
});
type SchemaNode = z.output<typeof schemaNode>;

const isType = (node: SchemaNode, type: string) => node.type === type;

const stringEnumValues = (node: SchemaNode): string[] | null =>
  isType(node, "string") && node.enum !== undefined ? node.enum : null;

const isPlainString = (node: SchemaNode) =>
  isType(node, "string") &&
  node.enum === undefined &&
  node.const === undefined &&
  node.anyOf === undefined;

const anyOfArms = (node: SchemaNode): SchemaNode[] | null => {
  if (node.anyOf === undefined || node.anyOf.length === 0) return null;
  const arms = node.anyOf.map((arm) => schemaNode.safeParse(arm));
  return arms.every((arm) => arm.success)
    ? arms.flatMap((arm) => (arm.success ? [arm.data] : []))
    : null;
};

/** `anyOf: [{type: string, pattern}, {type: string, const: <sentinel>}]` — a
 * branded id or the unresolvable-entity sentinel; sent as the plain string. */
const isAnyOfStringConst = (node: SchemaNode) => {
  const arms = anyOfArms(node);
  return (
    arms !== null &&
    arms.length === 2 &&
    arms.every((arm) => isType(arm, "string")) &&
    arms.some((arm) => arm.const !== undefined) &&
    arms.some((arm) => arm.const === undefined)
  );
};

const anyOfEnumValues = (node: SchemaNode): string[] | null => {
  const arms = anyOfArms(node);
  if (arms === null) return null;
  const values = arms.map(stringEnumValues);
  return values.every((arm) => arm !== null) ? values.flat() : null;
};

const classifyParameter = (raw: unknown): ParameterKind | null => {
  const parsed = schemaNode.safeParse(raw);
  if (!parsed.success) return null;
  const node = parsed.data;
  const enumValues = stringEnumValues(node);
  if (enumValues !== null) return { kind: "stringEnum", values: enumValues };
  if (isAnyOfStringConst(node)) return { kind: "anyOfString" };
  if (isPlainString(node)) return { kind: "string" };
  if (isType(node, "number")) return { kind: "number" };
  if (isType(node, "integer")) return { kind: "integer" };
  if (isType(node, "boolean")) return { kind: "boolean" };
  if (isType(node, "array")) {
    const items = schemaNode.safeParse(node.items);
    if (!items.success) return null;
    const itemEnum = stringEnumValues(items.data);
    if (itemEnum !== null) return { kind: "enumArray", values: itemEnum };
    if (isAnyOfStringConst(items.data)) return { kind: "anyOfStringArray" };
    const itemAnyOfEnum = anyOfEnumValues(items.data);
    if (itemAnyOfEnum !== null)
      return { kind: "anyOfEnumArray", values: itemAnyOfEnum };
    if (isPlainString(items.data)) return { kind: "stringArray" };
  }
  return null;
};

const queryParameterSchema = z.object({
  name: z.string(),
  in: z.string(),
  schema: z.unknown(),
});

type ClassifiedParameter = Readonly<{ name: string; wire: ParameterKind }>;
type FilterWire =
  | { kind: "param"; name: string }
  | { kind: "range"; from: string; to: string; presence?: string };

/** The query parameters of one GET route, classified; throws naming the
 * entity and parameter when a schema is outside the table. */
const classifyRouteParameters = (
  document: OpenApiDocument,
  route: string,
  context: string,
): ClassifiedParameter[] => {
  const operation = document.paths[route]?.get;
  const parameters = z
    .array(z.unknown())
    .parse(operation?.parameters ?? [])
    .flatMap((raw) => {
      const parsed = queryParameterSchema.safeParse(raw);
      return parsed.success && parsed.data.in === "query" ? [parsed.data] : [];
    });
  return parameters.map((parameter) => {
    // swift-openapi-generator's idiomatic naming keeps a camelCase name as
    // the property name; anything else would need the renamed form.
    if (!/^[a-z][A-Za-z0-9]*$/u.test(parameter.name))
      throw new Error(
        `${context}: query parameter ${parameter.name} is not a camelCase identifier; the generated property name cannot be derived.`,
      );
    const wire = classifyParameter(parameter.schema);
    if (wire === null)
      throw new Error(
        `${context}: query parameter ${parameter.name} has a schema the native filter classifier does not cover: ${JSON.stringify(parameter.schema)}`,
      );
    return { name: parameter.name, wire };
  });
};

const PAGING_PARAMETERS = new Set(["page", "pageSize", "sort"]);

/** One `case "<name>": query.<name> = …` arm converting an `EntityFilterValue`. */
const ARM = " ".repeat(16);
const renderFilterArm = ({ name, wire }: ClassifiedParameter): string => {
  const target = `query.${name}`;
  const head = `${ARM}case ${swiftString(name)}: ${target} = `;
  switch (wire.kind) {
    case "string":
      return `${head}try value.string(name)`;
    case "number":
      return `${head}try value.double(name)`;
    case "integer":
      return `${head}try value.int(name)`;
    case "boolean":
      return `${head}try value.bool(name)`;
    case "stringEnum":
      return `${head}try value.enumCase(name)`;
    case "stringArray":
      return `${head}value.strings`;
    case "enumArray":
      return `${head}try value.enumCases(name)`;
    case "anyOfString":
      return `${head}.init(value1: try value.string(name))`;
    case "anyOfStringArray":
      return `${head}value.strings.map { .init(value1: $0) }`;
    case "anyOfEnumArray":
      return (
        `${head}try value.strings.map { raw in\n` +
        `${ARM}    try EntityFilterValue.anyOfCase(name, raw, .init(value1: .init(rawValue: raw), value2: .init(rawValue: raw))) {\n` +
        `${ARM}        $0.value1 != nil || $0.value2 != nil\n` +
        `${ARM}    }\n` +
        `${ARM}}`
      );
  }
};

const enumValuesOf = (wire: ParameterKind): string[] | null =>
  wire.kind === "stringEnum" ||
  wire.kind === "enumArray" ||
  wire.kind === "anyOfEnumArray"
    ? wire.values
    : null;

const renderFilterSwitch = (
  parameters: readonly ClassifiedParameter[],
  entity: string,
): string =>
  `            for name in filters.names {\n` +
  `                guard let value = filters[name] else { continue }\n` +
  `                switch name {\n` +
  `${parameters.map(renderFilterArm).join("\n")}\n` +
  `${ARM}default: throw EntityFilterError.unknownParameter(.${swiftCase(entity)}, name)\n` +
  `                }\n` +
  `            }`;

/**
 * Generate-time checks that tie the stage-1 catalog facts to the document:
 * every declared filter wire name is a query parameter of the entity's list
 * route (and of its timeline route, which shares the filter state), a
 * declared timeline section or view has a timeline route, and an entity
 * with a create/update field roster has the matching generated operation.
 */
const checkCatalogAgainstDocument = (
  listParameters: ReadonlyMap<string, readonly ClassifiedParameter[]>,
  timelineParameters: ReadonlyMap<string, readonly ClassifiedParameter[]>,
  generatedOperationIds: ReadonlySet<string>,
) => {
  const problems: string[] = [];
  for (const [entity, metadata] of Object.entries(entityInspectorMetadata)) {
    const wires = metadata.filterDescriptors.flatMap((descriptor) => {
      // SAFETY: the artifact is `as const`; the declared type is the wire union.
      const wire: FilterWire = descriptor.wire;
      return wire.kind === "param"
        ? [wire.name]
        : [
            wire.from,
            wire.to,
            ...(wire.presence === undefined ? [] : [wire.presence]),
          ];
    });
    for (const [label, routes] of [
      ["list", listParameters],
      ["timeline", timelineParameters],
    ] as const) {
      const parameters = routes.get(entity);
      if (parameters === undefined) continue;
      const names = new Set(parameters.map((parameter) => parameter.name));
      for (const wire of wires)
        if (!names.has(wire))
          problems.push(
            `${entity}: filter wire ${wire} is not a query parameter of resources.${entity}.${label}`,
          );
    }
    // SAFETY: `views` is an `as const` tuple of view ids and slot objects; a
    // widened membership test is the only read.
    const views: readonly unknown[] = metadata.list.views;
    const declaresTimeline =
      metadata.detail.sections.some((section) => section.kind === "timeline") ||
      views.includes("timeline");
    if (
      declaresTimeline &&
      !generatedOperationIds.has(`resources.${entity}.timeline`)
    )
      problems.push(
        `${entity}: declares a timeline section or view but resources.${entity}.timeline is not generated`,
      );
    // SAFETY: `entity` iterates the inspector metadata's own keys; an entity
    // absent from the field-model map is skipped on the next line.
    const fieldModel =
      generatedEntityFieldModels[
        entity as keyof typeof generatedEntityFieldModels
      ];
    if (fieldModel === undefined) continue;
    for (const action of ["create", "update"] as const) {
      if (
        fieldModel[action].length > 0 &&
        !generatedOperationIds.has(`resources.${entity}.${action}`)
      )
        problems.push(
          `${entity}: has ${action} fields but resources.${entity}.${action} is not generated`,
        );
    }
  }
  if (problems.length > 0)
    throw new Error(
      `Swift catalog and HTTP document disagree:\n${problems.join("\n")}`,
    );
};

export const renderEntityOperations = (
  document: OpenApiDocument,
  components: Record<string, JsonSchema>,
  swiftRoutes: readonly SwiftRoute[],
  resourceEntities: ReadonlyMap<string, ReadonlySet<string>>,
  generatedOperationIds: ReadonlySet<string>,
  nativeOperations: readonly string[],
): EntityArtifacts => {
  const bodyHas = (entity: string, property: string) =>
    updateBodyHas(document, components, swiftRoutes, entity, property);
  const routeOf = (id: string) =>
    swiftRoutes.find((entry) => entry.id === id)?.route;
  const entities = [...resourceEntities].sort(([a], [b]) => a.localeCompare(b));
  const generated = (entity: string, action: string) =>
    generatedOperationIds.has(`resources.${entity}.${action}`);
  const withGenerated = (action: string) =>
    entities.filter(([entity]) => generated(entity, action));

  // Resource routes use the generic bridge below. A small set of explicitly
  // flagged read RPCs are represented separately so Browse can choose their
  // typed adapters without pretending they are resources.
  const nativeActionsByEntity = new Map<string, Set<string>>();
  for (const [entity, actions] of entities) {
    nativeActionsByEntity.set(
      entity,
      new Set([...actions].filter((action) => generated(entity, action))),
    );
  }
  for (const id of nativeOperations) {
    const match = /^([^.]+)\.(list|detail)$/u.exec(id);
    if (!match || !entityKeys.some((key) => key === match[1])) continue;
    const actions = nativeActionsByEntity.get(match[1]!) ?? new Set<string>();
    actions.add(match[2] === "detail" ? "get" : "list");
    nativeActionsByEntity.set(match[1]!, actions);
  }

  const listParameters = new Map(
    withGenerated("list").map(([entity]) => {
      const route = routeOf(`resources.${entity}.list`);
      if (route === undefined)
        throw new Error(`resources.${entity}.list has no route`);
      return [
        entity,
        classifyRouteParameters(document, route, `resources.${entity}.list`),
      ] as const;
    }),
  );
  const timelineParameters = new Map(
    withGenerated("timeline").map(([entity]) => {
      const route = routeOf(`resources.${entity}.timeline`);
      if (route === undefined)
        throw new Error(`resources.${entity}.timeline has no route`);
      return [
        entity,
        classifyRouteParameters(
          document,
          route,
          `resources.${entity}.timeline`,
        ),
      ] as const;
    }),
  );
  checkCatalogAgainstDocument(
    listParameters,
    timelineParameters,
    generatedOperationIds,
  );

  const fallback = (covered: (key: string) => boolean, value: string) =>
    entityKeys.every(covered) ? "" : `\n        default: ${value}`;
  const actionCases = entities
    .map(
      ([entity, actions]) =>
        `        case .${swiftCase(entity)}: [${[...actions]
          .sort()
          .map((action) => `.${action}`)
          .join(", ")}]`,
    )
    .join("\n");
  const nativeActionCases = [...nativeActionsByEntity]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entity, actions]) => {
      const native = [...actions].sort();
      return native.length === 0
        ? null
        : `        case .${swiftCase(entity)}: [${native.map((action) => `.${action}`).join(", ")}]`;
    })
    .filter((line) => line !== null)
    .join("\n");
  const nativeReadCases = [...nativeActionsByEntity]
    .filter(([, actions]) => actions.has("list"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entity]) => {
      const kind =
        entity === "cookbook"
          ? "cookbook"
          : entity === "image"
            ? "image"
            : entity === "usda-food"
              ? "usdaFood"
              : "resource";
      return `        case .${swiftCase(entity)}: .${kind}`;
    })
    .join("\n");
  const listCases = [...listParameters]
    .map(
      ([entity, parameters]) => `        case .${swiftCase(entity)}:
            var query = ${swiftOperation(entity, "list")}.Input.Query(page: page, pageSize: pageSize, sort: sort)
${renderFilterSwitch(
  parameters.filter((parameter) => !PAGING_PARAMETERS.has(parameter.name)),
  entity,
)}
            let page = try await client.${swiftMethod(entity, "list")}(query: query).ok.body.json
            return ListPage(
                items: try page.items.map(JSONValue.init(encoding:)),
                meta: page.meta
            )`,
    )
    .join("\n");
  const filterValueCases = [...listParameters]
    .map(([entity, parameters]) => {
      const arms = parameters.flatMap((parameter) => {
        const values = enumValuesOf(parameter.wire);
        return values === null
          ? []
          : [`${ARM}case ${swiftString(parameter.name)}: ${swiftList(values)}`];
      });
      return arms.length === 0
        ? null
        : `        case .${swiftCase(entity)}:
            switch wireKey {
${arms.join("\n")}
${ARM}default: nil
            }`;
    })
    .filter((line) => line !== null)
    .join("\n");
  const timelineCases = [...timelineParameters]
    .map(
      ([entity, parameters]) => `        case .${swiftCase(entity)}:
            var query = ${swiftOperation(entity, "timeline")}.Input.Query()
${renderFilterSwitch(parameters, entity)}
            return try await client.${swiftMethod(entity, "timeline")}(query: query).ok.body.json`,
    )
    .join("\n");
  const getCases = withGenerated("get")
    .map(
      ([entity]) => `        case .${swiftCase(entity)}:
            return try JSONValue(encoding: try await client.${swiftMethod(entity, "get")}(path: .init(id: id)).ok.body.json)`,
    )
    .join("\n");
  const createCases = withGenerated("create")
    .map(
      ([entity]) => `        case .${swiftCase(entity)}:
            let created = try await client.${swiftMethod(entity, "create")}(body: .json(try body.decoded())).created.body.json
            return try createdID(created.item)`,
    )
    .join("\n");
  const updateCases = withGenerated("update")
    .map(
      ([entity]) => `        case .${swiftCase(entity)}:
            _ = try await client.${swiftMethod(entity, "update")}(path: .init(id: id), body: .json(try body.decoded())).ok`,
    )
    .join("\n");
  const attachCases = withGenerated("update")
    .filter(([entity]) => bodyHas(entity, "pendingImageIds"))
    .map(
      ([entity]) => `        case .${swiftCase(entity)}:
            _ = try await client.${swiftMethod(entity, "update")}(
                path: .init(id: id), body: .json(.init(pendingImageIds: imageIds))
            ).ok`,
    )
    .join("\n");
  const orderCases = withGenerated("update")
    .filter(([entity]) => bodyHas(entity, "imageOrder"))
    .map(
      ([entity]) => `        case .${swiftCase(entity)}:
            _ = try await client.${swiftMethod(entity, "update")}(
                path: .init(id: id), body: .json(.init(imageOrder: imageIds))
            ).ok`,
    )
    .join("\n");
  const switchBody = (cases: string, action: string) =>
    `        switch key {\n${cases.length === 0 ? "" : `${cases}\n`}        default: throw EntityOperationError.unsupported(key, .${action})\n        }`;
  return {
    relativePath:
      "apps/apple/CubbyKit/Sources/CubbyKit/Generated/EntityOperations.swift",
    source: `${generatedHeader}import CubbyAPI
import Foundation

/// Thrown when a catalog entity has no HTTP route for the requested action.
public enum EntityOperationError: Error, Sendable, Hashable {
    case unsupported(EntityKey, EntityAction)
    /// A create response whose item carries no string \`id\`.
    case missingCreatedID(EntityKey)
}

/// The generated client may read an entity through a resource route or one
/// declared exceptional RPC adapter. This stays separate from \`httpActions\`:
/// native read support does not claim a resource capability the server lacks.
public enum NativeReadKind: Sendable, Hashable {
    case unavailable, resource, cookbook, image, usdaFood
}

extension EntityKey {
    /// The resource actions the HTTP document exposes for this entity, whether or not the
    /// generated client carries them (\`delete\` is exposed but not generated).
    public var httpActions: Set<EntityAction> {
        switch self {
${actionCases}${fallback((key) => resourceEntities.has(key), "[]")}
        }
    }

    /// The resource actions the generated client carries: the verbs \`EntityDescriptor\`'s
    /// operations below can perform (create/update/timeline gate the generic editor and views).
    public var nativeActions: Set<EntityAction> {
        switch self {
${nativeActionCases}${fallback((key) => (nativeActionsByEntity.get(key)?.size ?? 0) > 0, "[]")}
        }
    }

    public var nativeReadKind: NativeReadKind {
        switch self {
${nativeReadCases}${fallback((key) => nativeActionsByEntity.get(key)?.has("list") ?? false, ".unavailable")}
        }
    }
}

extension EntityDescriptor {
    /// One page of rows as the dynamic projection \`EntityRow\` reads. Typed on the wire; the
    /// \`JSONValue\` is produced from the decoded value, never from the response bytes. Filters
    /// are keyed by the list route's query parameter names (\`FilterDescriptor.wire\`).
    func listPage(
        client: Client, page: Int, pageSize: Int, sort: String?, filters: EntityFilterState
    ) async throws -> ListPage<JSONValue> {
${switchBody(listCases, "list")}
    }

    /// The values a list-route enum parameter accepts, for a filter whose catalog \`options\` are
    /// nil (the server supplies them); nil when \`wireKey\` is not an enum parameter.
    public func filterValues(for wireKey: String) -> [String]? {
        switch key {
${filterValueCases}
        default: nil
        }
    }

    /// \`resources.<key>.timeline\`: the same filter state as \`listPage\`, plus \`ids\`, \`from\`,
    /// \`to\` and \`order\` under their own wire names.
    func timeline(client: Client, filters: EntityFilterState) async throws -> EntityTimelineOut {
${switchBody(timelineCases, "timeline")}
    }

    /// One row by id, as the dynamic projection \`EntityRow\` reads.
    func getRow(client: Client, id: String) async throws -> JSONValue {
${switchBody(getCases, "get")}
    }

    /// \`resources.<key>.create\` with \`body\` decoded into the typed create payload, returning the
    /// new record's id. A value the schema rejects (an unknown key, a malformed date) fails here,
    /// before any request is sent.
    func create(_ body: JSONValue, client: Client) async throws -> String {
${switchBody(createCases, "create")}
    }

    /// \`resources.<key>.update\` with \`body\` decoded into the typed update payload.
    func update(_ body: JSONValue, id: String, client: Client) async throws {
${switchBody(updateCases, "update")}
    }

    /// \`resources.<key>.update\` with only \`pendingImageIds\` set, for the entities whose update
    /// body declares it (the same set \`OperationRoute.imageAttachableEntities\` lists).
    func attachImages(_ imageIds: [ImageCode], to id: String, client: Client) async throws {
${switchBody(attachCases, "update")}
    }

    /// \`resources.<key>.update\` with only \`imageOrder\` set.
    func setImageOrder(_ imageIds: [ImageCode], on id: String, client: Client) async throws {
${switchBody(orderCases, "update")}
    }

    private func createdID<Item: Encodable>(_ item: Item) throws -> String {
        guard let id = try JSONValue(encoding: item)["id"]?.stringValue else {
            throw EntityOperationError.missingCreatedID(key)
        }
        return id
    }
}

extension JSONValue {
    fileprivate func decoded<T: Decodable>() throws -> T {
        try JSONDecoder.cubby().decode(T.self, from: JSONEncoder.cubby().encode(self))
    }
}
`,
  };
};

/**
 * `CubbyClient` methods that are exactly one generated call: the operation
 * takes no path or query parameters, its JSON body (if any) is the method's
 * only argument, and its 200 body is the result. Keyed by operation id; the
 * value is the public method name call sites use and an optional doc line.
 * Anything that maps, converts, branches or unwraps stays hand-written in
 * `CubbyClient.swift`.
 */
const CLIENT_PASSTHROUGH_METHODS: Readonly<
  Record<string, Readonly<{ method: string; doc?: string }>>
> = {
  "activity.devices": { method: "activityDevices" },
  "dashboard.counts": { method: "dashboardCounts" },
  "inventory.confirmOwnership": {
    method: "confirmInventoryOwnership",
    doc: "Pins the currently inferred owner using the evidence fingerprint returned with the detail. The server rejects stale evidence so native cannot confirm a different acquisition than the one the person reviewed.",
  },
  "inventory.setOwnership": {
    method: "setInventoryOwnership",
    doc: "Applies a stored ownership choice to all or part of one inventory row. A partial quantity may split the row; callers must refresh the returned entry ids rather than assuming the original row is the only record changed.",
  },
  "photoImport.commit": { method: "commitPhotoImport" },
  "photoImport.createRun": {
    method: "createPhotoImportRun",
    doc: "Starts a native-tagged photo-inventory run (`PhotoImportRunUploader`'s bulk-upload entry point). Distinct from the manifest-based `stage`/`commit` pair: a run has no per-photo destination, only ordered positions finalized in chunks.",
  },
  "photoImport.finalize": {
    method: "finalizePhotoImportRun",
    doc: "Finalizes one chunk (≤100 images) of a bulk upload into `input.runId`. Idempotent: a retry after a transport error replays safely, since a previously finalized image comes back in `alreadyFinalized` rather than erroring.",
  },
  "photoImport.stage": { method: "stagePhotoImport" },
  "photoImport.updateDraft": { method: "updatePhotoGroupDraft" },
  "problems.getCounts": { method: "problemCounts" },
  "purchaseImport.initiateRunEvidenceUpload": {
    method: "initiateRunEvidenceUpload",
    doc: "Stages immutable browser/manual evidence for one explicit targeted-import scope. The server allocates R2 directly; this must never use the shared Image/Document pathways.",
  },
  "statementRow.commitCsv": { method: "commitStatementCsv" },
  "statementRow.previewCsv": { method: "previewStatementCsv" },
  "task.todayBriefing": {
    method: "todayBriefing",
    doc: "The complete ranked task briefing, including summary counts outside the visible prefix.",
  },
};

const jsonRef = z
  .object({
    content: z.object({
      "application/json": z.object({ schema: z.object({ $ref: z.string() }) }),
    }),
  })
  .transform(({ content }) =>
    content["application/json"].schema.$ref.replace(
      "#/components/schemas/",
      "",
    ),
  );
const passthroughOperation = z.looseObject({
  requestBody: jsonRef.optional(),
  responses: z.looseObject({ "200": jsonRef }),
});

/** Wraps `text` into `///` lines that fit swift-format's 110 columns at `indent`. */
const swiftDocLines = (text: string, indent: string): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (`${indent}/// ${next}`.length > 110 && line !== "") {
      lines.push(`${indent}/// ${line}`);
      line = word;
    } else line = next;
  }
  if (line !== "") lines.push(`${indent}/// ${line}`);
  return lines;
};

/**
 * `Generated/ClientOperations.swift`: the `CubbyClient` extension holding
 * every `CLIENT_PASSTHROUGH_METHODS` wrapper, typed from the document (the
 * body and 200 components, spelled by their `APITypes.swift` alias names).
 */
export const renderClientOperations = (
  document: OpenApiDocument,
  swiftRoutes: readonly SwiftRoute[],
  generatedOperationIds: ReadonlySet<string>,
): EntityArtifacts => {
  const aliasName = (component: string, id: string) => {
    if (!/^[A-Z][A-Za-z0-9]*$/u.test(component))
      throw new Error(
        `${id}: #/components/schemas/${component} has no APITypes.swift alias, so its CubbyClient method must be hand-written`,
      );
    return component;
  };
  const methods = Object.entries(CLIENT_PASSTHROUGH_METHODS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, { method, doc }]) => {
      const route = swiftRoutes.find((entry) => entry.id === id);
      if (route === undefined || !generatedOperationIds.has(id))
        throw new Error(
          `${id} is a CubbyClient pass-through but not a native operation`,
        );
      if (route.pathParameters.length > 0 || route.queryParameters.length > 0)
        throw new Error(
          `${id} takes path or query parameters; its CubbyClient method must be hand-written`,
        );
      const item = Object.entries(document.paths).find(
        ([path]) => path === route.route,
      )?.[1];
      const operation = passthroughOperation.parse(
        Object.entries(item ?? {}).find(
          ([method]) => `.${method}` === route.method,
        )?.[1],
      );
      const output = aliasName(operation.responses["200"], id);
      const input =
        operation.requestBody === undefined
          ? null
          : aliasName(operation.requestBody, id);
      const call = `api.${id.replaceAll(".", "_")}(${input === null ? "" : "body: .json(input)"})`;
      return [
        ...(doc === undefined ? [] : swiftDocLines(doc, "    ")),
        `    public func ${method}(${input === null ? "" : `_ input: ${input}`}) async throws -> ${output} {`,
        `        try await perform { try await ${call}.ok.body.json }`,
        "    }",
      ].join("\n");
    });
  return {
    relativePath:
      "apps/apple/CubbyKit/Sources/CubbyKit/Generated/ClientOperations.swift",
    source:
      `${generatedHeader}// swift-format-ignore-file\n\n` +
      "import CubbyAPI\n\n" +
      "/// The `CubbyClient` methods that are one generated call and nothing else, from\n" +
      "/// `CLIENT_PASSTHROUGH_METHODS` in `scripts/generator/http-api/swift-operations.ts`.\n" +
      `extension CubbyClient {\n${methods.join("\n\n")}\n}\n`,
  };
};
