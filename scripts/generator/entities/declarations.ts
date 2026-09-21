import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileEntity, validateEntityIdentities } from "./compile.ts";
import { validateDataQualityDeclarations } from "./data-quality.ts";
import { validateRelationSections } from "./presentation.ts";
import { browserRoutes } from "./render/routes.ts";
import type {
  CompiledEntityPresentation,
  EntityDeclarationMetadata,
  EntityFieldControlKind,
  EntityFieldKind,
  EntityStorageDefaultKind,
} from "../../../packages/schemas/src/entity-definitions/definition.ts";
import { z } from "zod";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SPEC_DIRECTORY = resolve(ROOT, "packages/schemas/src/entity-definitions");

export type DeclarationValue =
  | string
  | number
  | boolean
  | null
  | DeclarationObject
  | z.ZodType
  | DeclarationValue[];
export interface DeclarationObject {
  [key: string]: DeclarationValue;
}

export type SourceRef = Readonly<{ module: string; export: string }>;
type ParsedEntityRoute = {
  basePath: string;
  detailParam?: string;
  create?: "dialog" | "page";
  list: true | null;
  detail: true | Readonly<{ query: SourceRef }> | null;
};
/** The list-route query parameter(s) a filter descriptor binds to. */
type FilterWire =
  | Readonly<{ kind: "param"; name: string }>
  | Readonly<{ kind: "range"; from: string; to: string; presence?: string }>;
/** Public entity filter values are always shortcodes. */
type IdentifierRef = Readonly<{ entity: string }>;
export type FilterDescriptor = Readonly<{
  columnId: string;
  field: string | null;
  urlKey: string;
  kind:
    | "text"
    | "select"
    | "multiselect"
    | "presence"
    | "boolean"
    | "id"
    | "idMulti"
    | "range";
  placeholder: string;
  options:
    | readonly Readonly<{
        value: string;
        label: string;
        meta?: boolean;
        color?: string;
      }>[]
    | null;
  optionsRef: SourceRef | null;
  optionsKey: string | null;
  label: string | null;
  schemaDescription: string | null;
  deriveSchema: boolean;
  schemaFromRead: boolean;
  brandRef: IdentifierRef | null;
  expandRef: SourceRef | null;
  schemaRef: SourceRef | null;
  stored: Readonly<{ columns: readonly string[]; array: boolean }> | null;
  range: Readonly<{
    kind: "number" | "date";
    int: boolean;
    nonnegative: boolean;
    finite: boolean;
    describe: Readonly<{ lower: string; upper: string }> | null;
  }> | null;
  urlOnly: boolean;
  nullable: Readonly<{ field: string; label: string }> | null;
  wire: FilterWire;
}>;
export type EntityPorts = Readonly<{
  repository: SourceRef | null;
  references: Readonly<{ label: SourceRef | null; resolver: SourceRef | null }>;
  filters: SourceRef | null;
  search: Readonly<{
    projection: SourceRef | null;
    semanticText: SourceRef | null;
    dependentRefresh: SourceRef | null;
  }>;
  timeline: SourceRef | null;
}>;
export type RelationMutation = Readonly<{
  entity: string;
  relation: string;
  target: string;
  source: string;
  itemSchema: SourceRef;
  adapter: SourceRef;
  audiences: readonly ("browser" | "mcp")[];
}>;
type OperationOwner = "kernel" | "workflow" | null;
type EntityFieldControl = Readonly<{
  kind: EntityFieldControlKind;
  renderer: string | null;
  options: readonly Readonly<{ value: string; label: string }>[] | null;
  section: string;
  /** Pairs with the next consecutive `"half"` field on one row. */
  width: "half" | null;
  placeholder: string | null;
  initial: "today" | null;
  suggest: Readonly<{ basis: readonly string[] }> | null;
}>;
type EntityFieldProvenance = Readonly<{
  kind: "reference" | "relation" | "derived";
  sources: readonly Readonly<{
    entity: string | null;
    label: string | null;
    relation: string | null;
  }>[];
}>;
type EntityFieldResolutionValue =
  | string
  | number
  | boolean
  | null
  | readonly EntityFieldResolutionValue[]
  | EntityFieldResolutionObject;
interface EntityFieldResolutionObject {
  readonly [key: string]: EntityFieldResolutionValue;
}
export type EntityField = Readonly<{
  key: string;
  kind: EntityFieldKind;
  nullable: boolean;
  label: string;
  description: string | null;
  readKey: string | null;
  reference: Readonly<{
    entity: string;
    multiple: boolean;
    scope: readonly Readonly<{
      sourceField: string;
      targetField: string;
    }>[];
    filters: readonly Readonly<{ field: string; values: readonly string[] }>[];
  }> | null;
  provenance: EntityFieldProvenance | null;
  explanation: Readonly<{
    ruleId: string;
    version: number;
    description: string;
    readPath?: string;
    resolver:
      | "field"
      | "inventoryOwnership"
      | "productValuation"
      | "imageRepresentation"
      | "productQuantity"
      | "recipeTotals"
      | "locationValuation"
      | "merchantVendorInference"
      | "expenseAttribution";
    projections?: Readonly<{
      list?: string;
      detail?: string;
      summary?: string;
    }>;
    sourceDependencies?: readonly Readonly<{ path: string; label: string }>[];
    actions?: readonly ("confirmOwner" | "inheritOwner" | "editSource")[];
  }> | null;
  resolution: Readonly<{
    reset: Readonly<Record<string, EntityFieldResolutionValue>>;
    none: Readonly<Record<string, EntityFieldResolutionValue>> | null;
    redundancy: "eligible" | "intentional";
  }> | null;
  control: EntityFieldControl | null;
  display: Readonly<{
    list: boolean;
    detail: boolean;
    columnId: string | null;
    standard: "name" | "image" | null;
    detailOrder: number | null;
    listOrder: number | null;
    width: "xs" | "sm" | "md" | "lg" | null;
    format:
      | "currency"
      | "signedCurrency"
      | "plainDate"
      | "timestamp"
      | "external-link"
      | "amount"
      | null;
    renderer: Readonly<{
      list: string | null;
      detail: string | null;
    }> | null;
    mobile: Readonly<{
      slot: string;
      priority: number;
      interactive?: boolean;
    }> | null;
    listHidden: boolean;
  }>;
  validation: Readonly<{
    read: z.ZodType | null;
    create: z.ZodType | null;
    update: z.ZodType | null;
  }>;
}>;
export type EntityStorageField = Readonly<{
  key: string;
  column: string;
  kind: EntityFieldKind;
  nullable: boolean;
  default: EntityStorageDefaultKind;
  defaultValue: DeclarationValue;
  reference: string | null;
  specialized: string | null;
}>;
type EntityFieldModelSort = Readonly<{
  fields: readonly [string, ...string[]];
  default: string;
  computed: readonly string[];
  groupable: readonly string[];
  direction: "asc" | "desc";
}>;
type EntityEditIntents = Readonly<{
  fields: Readonly<Record<string, readonly string[]>>;
  create: readonly string[];
  update: readonly string[];
  editorFields: readonly string[];
}>;
export type EntityFieldModel = Readonly<{
  fields: readonly EntityField[];
  storage: readonly EntityStorageField[];
  create: readonly string[];
  update: readonly string[];
  bulk: readonly string[];
  audit: readonly string[];
  output: readonly string[];
  sort: EntityFieldModelSort | null;
  intents: EntityEditIntents | null;
}>;
export type CompiledPresentation = CompiledEntityPresentation;
export type CompiledEntity = Readonly<{
  key: string;
  shortcode: string | null;
  /** Names plus the declaration's `presentation` block, passed through as one unit. */
  inspector: Readonly<
    { singular: string; plural: string | null } & CompiledPresentation
  >;
  /** `capabilities.timeline`: how `resources.<entity>.timeline` is served. */
  timeline: "default" | "custom" | null;
  descriptor: DeclarationObject;
  contract: Readonly<{
    create: SourceRef | null;
    update: SourceRef | null;
    output: SourceRef;
    list: SourceRef;
    detail: SourceRef;
    mcpOutput: SourceRef;
    mcpList: SourceRef;
    mcpDetail: SourceRef;
  }> | null;
  route: Readonly<ParsedEntityRoute> | null;
  filterAudit: boolean;
  filterUrlKeys: readonly string[];
  filterSchema: SourceRef | null;
  filterDescriptors: readonly FilterDescriptor[];
  /** Fields a `bulkUpdate` command may patch; null means the capability is undeclared. */
  bulkUpdateFields: readonly string[] | null;
  ports: EntityPorts;
  /** The manifest-owned image storage, display, ingress and routing policy. */
  imagePolicy: EntityDeclarationMetadata["capabilities"]["images"];
  relations: EntityDeclarationMetadata["relations"];
  relationMutations: readonly RelationMutation[];
  lifecycle: Readonly<{
    softDelete: boolean;
    delete: DeclarationValue | null;
    merge: boolean;
  }>;
  mcpActions: readonly string[];
  operationOwners: Readonly<{
    delete: OperationOwner;
    merge: OperationOwner;
  }>;
  fieldModel: EntityFieldModel;
  /** `capabilities.dataQuality`, or null for an unscored entity. */
  dataQuality: Readonly<{
    checks: readonly Readonly<{
      id: string;
      facet: string;
      kind: "missing" | "defect";
      weight: number;
      label: string;
      message: string;
    }>[];
    exceptions: boolean;
    related: readonly string[];
  }> | null;
}>;

export type EntityArtifacts = Readonly<{
  relativePath: string;
  source: string;
}>;

export class EntityDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityDeclarationError";
  }
}

const isDeclarationObject = (value: unknown): value is DeclarationObject =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof z.ZodType);

const isNonEmptyString = (value: DeclarationValue): value is string =>
  typeof value === "string" && value.length > 0;

const isBoolean = (value: DeclarationValue): value is boolean =>
  typeof value === "boolean";

export const objectValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This compiler boundary validates imported declaration values before consuming them.
  value: unknown,
  context: string,
): DeclarationObject => {
  if (!isDeclarationObject(value)) {
    throw new EntityDeclarationError(`${context} must be an object.`);
  }
  return value;
};

export const required = (
  object: DeclarationObject,
  key: string,
  context: string,
) => {
  if (!(key in object)) {
    throw new EntityDeclarationError(`${context}.${key} is required.`);
  }
  const value = object[key];
  if (value === undefined) {
    throw new EntityDeclarationError(
      `${context}.${key} must not be undefined.`,
    );
  }
  return value;
};

export const stringValue = (
  value: DeclarationValue,
  context: string,
): string => {
  if (!isNonEmptyString(value)) {
    throw new EntityDeclarationError(`${context} must be a non-empty string.`);
  }
  return value;
};

export const booleanValue = (
  value: DeclarationValue,
  context: string,
): boolean => {
  if (!isBoolean(value)) {
    throw new EntityDeclarationError(`${context} must be a boolean.`);
  }
  return value;
};

export const declarationModules = new Map<
  string,
  { path: string; enumExports: string[] }
>();

export const loadEntityDeclarations = async (): Promise<CompiledEntity[]> => {
  const entries = (await readdir(SPEC_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".entity.ts"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0)
    throw new EntityDeclarationError(
      `${SPEC_DIRECTORY} has no entity declarations.`,
    );
  const compiled = await Promise.all(
    entries.map(async (entry) => {
      const module = await import(
        pathToFileURL(resolve(SPEC_DIRECTORY, entry.name)).href
      );
      const raw = objectValue(module.default, entry.name);
      // Filter schemas are generated from descriptors (`deriveSchema`); a
      // hand-written map would silently shadow them.
      if (module.filterSchemas !== undefined || "filterSchemas" in raw)
        throw new EntityDeclarationError(
          `${entry.name} exports filterSchemas; declare filters as descriptors with deriveSchema instead.`,
        );
      const entity = compileEntity(raw, 0);
      declarationModules.set(entity.key, {
        path: `../entity-definitions/${entry.name.replace(/\.ts$/, "")}`,
        enumExports: Object.keys(module).filter((key) =>
          key.startsWith("generated"),
        ),
      });
      return entity;
    }),
  );
  const entities = validateDataQualityDeclarations(compiled);
  const routes = new Set<string>();
  validateEntityIdentities(entities);
  validateRelationSections(entities);
  for (const entity of entities) {
    if (entity.descriptor.browserRoutes === false) continue;
    for (const [routeName, route] of Object.entries(
      browserRoutes(entity).routes,
    )) {
      if (routeName === "create") continue;
      if (routes.has(route))
        throw new EntityDeclarationError(`Duplicate browser route ${route}.`);
      routes.add(route);
    }
  }
  return entities;
};
