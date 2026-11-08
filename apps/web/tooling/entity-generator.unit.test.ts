import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChildTableDeclaration } from "@cubby/schemas/compiler/entity-definitions/child-definition";
import type { EntityDeclaration } from "@cubby/schemas/entity-definitions/definition";
import { storedDateRangeSchema } from "@cubby/schemas/date-range";
import { typeChecker } from "cubby/tooling/type-checker";
import { generatedHeader, removeExtraArtifacts } from "../generator/artifacts";
import { compileEntityDeclarations as compileDeclarations } from "../generator/entities/compile";
import type { DeclarationObject } from "../generator/entities/declarations";
import {
  renderEntityTableArtifacts,
  renderIdentityStorageTablesArtifact,
  tableDependencyClosure,
} from "../generator/entities/render/tables";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true, maxRetries: 5 })),
  );
});

// Fixtures that do not exercise detail presentation keep this empty roster;
// the compile helper below authors one section for the fields they display.
const unauthoredSections: never[] = [];

const presentation = {
  titleField: "name",
  domain: null,
  description: "Alpha records.",
  emptyState: { title: "No alphas", description: "Add one." },
  icons: { phosphor: "Cube", sfSymbol: "cube", emoji: "🧊" },
  detail: { sections: unauthoredSections },
} as const;

/**
 * Compiles fixtures, giving each one still on `unauthoredSections` a Record
 * section for the detail fields the compiler reports unplaced. Fixtures that
 * author sections keep the strict placement check.
 */
const compileEntityDeclarations = (
  declarations: Parameters<typeof compileDeclarations>[0],
  ...rest: Parameters<typeof compileDeclarations> extends [unknown, ...infer R]
    ? R
    : never
): ReturnType<typeof compileDeclarations> => {
  let current = declarations;
  for (;;) {
    try {
      return compileDeclarations(current, ...rest);
    } catch (error) {
      const unplaced =
        /ENTITY_DECLARATIONS\[(\d+)\]\.presentation\.detail\.sections leave display\.detail fields unplaced: (.+)\.$/u.exec(
          error instanceof Error ? error.message : "",
        );
      const index = Number(unplaced?.[1]);
      // SAFETY: fixtures are plain declaration objects.
      const declaration = current[index] as DeclarationObject | undefined;
      // SAFETY: as above; `presentation` is an object on every fixture.
      const declared = declaration?.presentation as
        | { detail?: { sections?: unknown } }
        | undefined;
      if (
        unplaced === null ||
        declaration === undefined ||
        declared?.detail?.sections !== unauthoredSections
      )
        throw error;
      current = current.map((entry, at) =>
        at === index
          ? {
              ...declaration,
              presentation: {
                ...declared,
                detail: {
                  ...declared.detail,
                  sections: [
                    {
                      kind: "fields",
                      id: "overview",
                      title: "Record",
                      fields: unplaced[2]!.split(", "),
                    },
                  ],
                },
              },
            }
          : entry,
      );
    }
  }
};

const base = {
  key: "alpha",
  names: { singular: "Alpha", plural: "Alphas" },
  route: null,
  table: null,
  identifiers: { brand: null, shortcode: null },
  presentation,
  fields: null,
  filters: { descriptors: [] },
  relations: [],
  search: false as const,
  capabilities: {
    auditable: false,
    images: { storage: false as const },
    countable: false,
    softDelete: false,
    delete: null,
    merge: false,
    operationOwners: { delete: null, merge: null },
    mcp: [],
  },
  extensions: {
    relatednessSignals: [],
    ports: {
      repository: null,
      references: { label: null, resolver: null },
      filters: null,
      search: { projection: null },
    },
  },
};
const model = {
  fields: [
    {
      key: "name",
      kind: "text" as const,
      validation: {
        read: z.string(),
        create: z.string().trim().min(1).default("Example"),
        update: z.string().trim().min(1).optional(),
      },
    },
  ],
  storage: ["name"],
};

describe("typed entity compiler", () => {
  it("retains actual schemas and explicit policies while defaulting presentation and storage", () => {
    const entity = compileEntityDeclarations([{ ...base, model }])[0]!;
    const field = entity.fieldModel.fields[0]!;
    expect(field).toMatchObject({
      key: "name",
      label: "Name",
      readKey: "name",
      nullable: false,
      control: null,
      display: { list: true, detail: true },
    });
    expect(field.validation.create).toBe(model.fields[0]!.validation.create);
    expect(field.validation.create!.parse(undefined)).toBe("Example");
    expect(field.validation.update!.parse(undefined)).toBeUndefined();
    expect(field.validation.read!.parse(" Example ")).toBe(" Example ");
    expect(field.validation.create!.parse(" Example ")).toBe("Example");
    expect(field.validation.update!.safeParse(null).success).toBe(false);
    expect(entity.fieldModel.storage[0]).toMatchObject({
      key: "name",
      column: "name",
      kind: "text",
      nullable: false,
      default: "none",
    });
    expect(entity.fieldModel.bulk).toEqual([]);
  });

  it("preserves null read projections and explicit storage exceptions; rejects undeclared storage", () => {
    const entity = compileEntityDeclarations([
      {
        ...base,
        presentation: { ...presentation, titleField: "heading" },
        model: {
          ...model,
          fields: [
            {
              output: false,
              key: "name",
              kind: "text",
              label: "Title",
              nullable: true,
            },
            {
              output: false,
              key: "internalAt",
              kind: "timestamp",
              nullable: true,
            },
            {
              key: "heading",
              kind: "text",
              validation: { read: z.string(), create: null, update: null },
            },
            { output: false, key: "startsOn", kind: "date", nullable: true },
            { output: false, key: "endsOn", kind: "date", nullable: true },
            {
              output: false,
              key: "uses",
              kind: "number",
              reference: { entity: "alpha", multiple: true },
              display: { format: "count" },
              validation: {
                read: z.number().int(),
                create: null,
                update: null,
              },
            },
            {
              key: "period",
              kind: "dateRange",
              nullable: true,
              dateRange: {
                start: "startsOn",
                end: "endsOn",
                semantics: "period",
              },
              control: { kind: "dateRange" },
              validation: {
                read: storedDateRangeSchema.nullable(),
                create: null,
                update: null,
              },
            },
          ],

          derived: { uses: { type: "boolean" } },
          storage: [
            {
              key: "name",
              nullableOverride: false,
              defaultOverride: "literal",
              defaultValue: "Example",
            },
            "heading",
            "internalAt",
            "startsOn",
            "endsOn",
          ],
        },
      },
    ])[0]!;
    expect(entity.fieldModel.fields[0]).toMatchObject({
      readKey: null,
      nullable: true,
      validation: { read: null, create: null, update: null },
    });
    expect(entity.fieldModel.storage[0]).toMatchObject({
      column: "name",
      nullable: false,
      defaultValue: "Example",
    });
    expect(
      entity.listFields.grouping.find(({ key }) => key === "internalAt"),
    ).toMatchObject({ listed: false });
    for (const key of ["startsOn", "endsOn"])
      expect(
        entity.listFields.grouping.find((choice) => choice.key === key),
      ).toMatchObject({ listed: true });
    expect(
      entity.listFields.grouping.find(({ key }) => key === "uses"),
    ).toMatchObject({ value: { kind: "derived" }, multiple: false });
    expect(entity.listFields.presentation.uses).toMatchObject({
      target: "alpha",
      valueType: "count",
      cardinality: "one",
      group: { valueType: "boolean", target: null },
    });
    expect(() =>
      compileEntityDeclarations([
        { ...base, model: { ...model, storage: ["missing"] } },
      ]),
    ).toThrow("references undeclared field missing");
  });

  it("rejects duplicate entity and shortcode identities", () => {
    expect(() => compileEntityDeclarations([base, base])).toThrow(
      "Duplicate entity key alpha",
    );
    const named = (key: string, shortcode: string) => ({
      ...base,
      key,
      identifiers: { ...base.identifiers, shortcode },
    });
    expect(() =>
      compileEntityDeclarations([
        named("alpha", "ALP-"),
        named("beta", "ALP-"),
      ]),
    ).toThrow("conflicts");
  });

  it("requires inverse paths for local relationships and rejects deletion policy on views", async () => {
    const raw = (
      await import("@cubby/schemas/compiler/entity-definitions/02-ingredient.entity")
    ).default;
    const relation = {
      key: "child",
      label: "Child",
      target: "ingredient",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Ingredient.recipeId", direction: "outgoing" }],
      },
    };
    // The loaded declaration is checked by the same compiler as every production entity.
    const metadata = raw;
    expect(() =>
      compileEntityDeclarations([{ ...metadata, relations: [relation] }]),
    ).toThrow("requires inverse");
    expect(() =>
      compileEntityDeclarations([
        {
          ...metadata,
          relations: [
            {
              ...relation,
              inverse: {
                steps: [{ edge: "Ingredient.recipeId", direction: "incoming" }],
              },
              deletionPolicy: "restrict",
            },
          ],
        },
      ]),
    ).toThrow("deletionPolicy is not allowed");
  });

  it("removes only header-carrying files that no artifact claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "cubby-entities-"));
    temporaryRoots.push(root);
    const artifacts = [
      {
        relativePath: "generated/entity-literal-alpha.gen.ts",
        source: `${generatedHeader}export const alpha = 1;\n`,
      },
    ];
    await mkdir(join(root, "generated"));
    await writeFile(
      join(root, "generated/entity-literal-alpha.gen.ts"),
      artifacts[0]!.source,
    );
    // Extraneous detection reads the generator ownership header, not the
    // filename, so a retired artifact name is caught too.
    await writeFile(
      join(root, "generated/entity-retired-name.gen.ts"),
      `${generatedHeader}export const retired = 1;\n`,
    );
    // A file with no generator header is not ours to delete.
    await writeFile(join(root, "generated/notes.gen.ts"), "// just a note\n");
    expect(await removeExtraArtifacts(root, artifacts)).toEqual([
      "generated/entity-retired-name.gen.ts",
    ]);
    expect((await readdir(join(root, "generated"))).sort()).toEqual([
      "entity-literal-alpha.gen.ts",
      "notes.gen.ts",
    ]);
  });
});

type TableStorage = NonNullable<EntityDeclaration["storage"]>;

describe("entity table storage", () => {
  const status = {
    key: "status",
    kind: "enum",
    validation: { read: z.enum(["open", "done"]), create: null, update: null },
    display: {
      optionRole: "category",
      optionColor: "neutral-status",
      optionGlyph: { phosphor: "Shapes", sfSymbol: "square.on.circle" },
      valueOptions: [
        { value: "open", label: "open" },
        { value: "done", label: "done" },
      ],
    },
  };
  const loose = {
    key: "note",
    kind: "text",
    nullable: true,
    validation: { read: z.string().nullable(), create: null, update: null },
  };
  const betaId = {
    output: false,
    key: "betaId",
    kind: "identifier",
    nullable: true,
    validation: { read: null, create: null, update: null },
  };
  const deletedAt = {
    output: false,
    key: "deletedAt",
    kind: "timestamp",
    nullable: true,
    validation: { read: null, create: null, update: null },
  };
  const beta = { ...base, key: "beta", table: "Beta", model };
  const alpha = (storage: TableStorage) => ({
    ...base,
    table: "Alpha",
    model: {
      ...model,
      fields: [...model.fields, status, loose, betaId, deletedAt],
      storage: [
        "name",
        "status",
        "note",
        { key: "betaId", reference: "beta" },
        "deletedAt",
      ],
    },
    storage,
  });
  const table = (storage: TableStorage) =>
    compileEntityDeclarations([alpha(storage), beta])[0]?.table;
  const indexNames = (storage: TableStorage) =>
    table(storage)?.indexes.map(({ name }) => name);

  it("closes storage groups over real foreign keys and keeps cycles in one owner", () => {
    const entities = compileEntityDeclarations([
      alpha({}),
      {
        ...beta,
        storage: {
          columns: [
            {
              key: "alphaId",
              kind: "identifier",
              reference: "alpha",
            },
          ],
        },
      },
      { ...base, key: "gamma", table: "Gamma", model },
    ]);
    expect(
      tableDependencyClosure(entities, ["alpha"]).map((entity) => entity.key),
    ).toEqual(["alpha", "beta"]);
  });

  it("compiles declared custom column types in a generated storage group", async () => {
    const root = await mkdtemp(join(tmpdir(), "cubby-table-types-"));
    temporaryRoots.push(root);
    const app = resolve(import.meta.dirname, "..");
    await symlink(join(app, "node_modules"), join(root, "node_modules"), "dir");
    const entities = compileEntityDeclarations([
      {
        ...base,
        key: "product",
        table: "Product",
        model,
        storage: {
          columns: [
            {
              key: "payload",
              kind: "json",
              notNull: true,
              type: { module: "./payload", export: "Payload" },
            },
            {
              key: "nutrition",
              kind: "json",
              type: {
                module: "@cubby/schemas/nutrition",
                export: "ProductLabelNutrition",
              },
            },
          ],
        },
      },
    ]);
    await writeFile(
      join(root, "tables.ts"),
      renderIdentityStorageTablesArtifact(entities),
    );
    await writeFile(
      join(root, "payload.ts"),
      "export interface Payload { code: string }\n",
    );
    await writeFile(
      join(root, "consumer.ts"),
      'import { product } from "./tables"; const row: Pick<typeof product.$inferSelect, "payload"> = { payload: { code: "synthetic" } }; const code: string = row.payload.code;\n',
    );
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        extends: join(app, "tsconfig.json"),
        include: [],
        files: ["consumer.ts"],
        compilerOptions: {
          incremental: false,
          noEmit: true,
          types: [],
          noUnusedLocals: false,
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [typeChecker, "-p", join(root, "tsconfig.json")],
      { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    expect({
      status: result.status,
      diagnostics: result.stdout + result.stderr,
    }).toEqual({ status: 0, diagnostics: "" });
  });

  // A reference column with no full index makes every FK check and join on
  // it a sequential scan; a partial index cannot serve rows it excludes.
  it("derives an index for each reference column unless a full index leads with it", () => {
    expect(indexNames({})).toEqual(["Alpha_betaId_idx"]);
    expect(
      indexNames({
        indexes: [
          { on: ["betaId"], unique: true, where: "{deletedAt} IS NULL" },
        ],
      }),
    ).toEqual(["Alpha_betaId_key", "Alpha_betaId_idx"]);
    expect(
      indexNames({
        indexes: [{ name: "Alpha_beta_idx", on: ["betaId", "name"] }],
      }),
    ).toEqual(["Alpha_beta_idx"]);
    expect(
      indexNames({ unindexedReferences: { betaId: "never joined" } }),
    ).toEqual([]);
  });

  it("rejects an opt-out that is not a reference or is already indexed", () => {
    expect(() => table({ unindexedReferences: { name: "why" } })).toThrow(
      "unindexedReferences.name is not a reference column",
    );
    expect(() =>
      table({
        indexes: [{ on: ["betaId"] }],
        unindexedReferences: { betaId: "why" },
      }),
    ).toThrow("is stale: a declared full index already leads with it");
  });

  it("rejects SQL, index columns, and relations naming a column the table lacks", () => {
    expect(() =>
      table({ checks: [{ name: "Alpha_x_check", sql: "{missing} > 0" }] }),
    ).toThrow("names missing, which is not a column of Alpha");
    expect(() => table({ indexes: [{ on: ["missing"] }] })).toThrow(
      "names missing, which is not a column of Alpha",
    );
    expect(() => table({ relations: { owner: "name" } })).toThrow(
      "names name, which does not reference an entity",
    );
  });

  it("builds a value-set check from the field's read enum and requires values otherwise", () => {
    expect(table({ checks: [{ column: "status" }] })?.checks).toEqual([
      {
        name: "Alpha_status_check",
        sql: "{status} IN ('open', 'done')",
        bare: false,
      },
    ]);
    expect(
      table({
        checks: [
          { column: "note", values: ["a"], nullClause: true, bare: true },
        ],
      })?.checks,
    ).toEqual([
      {
        name: "Alpha_note_check",
        sql: `"note" IS NULL OR "note" IN ('a')`,
        bare: true,
      },
    ]);
    expect(() => table({ checks: [{ column: "note" }] })).toThrow(
      "needs explicit values: note has no declared read enum",
    );
  });

  it("preserves an entity foreign key to a declared content child and rejects an unknown target", () => {
    const children = [
      {
        name: "SyntheticContent",
        exportName: "syntheticContent",
        columns: [{ key: "id", kind: "uuid", primaryKey: true }],
      },
    ] satisfies ChildTableDeclaration[];
    const declaration = alpha({
      columns: [
        {
          key: "contentId",
          kind: "identifier",
          reference: "syntheticContent",
        },
      ],
    });
    const entities = compileEntityDeclarations([declaration, beta], children);
    const source = renderEntityTableArtifacts(entities, children).definitions;
    expect(source).toContain(
      "columns:[table.contentId], foreignColumns:[syntheticContent.id]",
    );
    expect(() => compileEntityDeclarations([declaration, beta])).toThrow(
      "syntheticContent",
    );
  });
});
