import { z } from "zod";

import type { LoadedContract } from "../start-operations/collect.ts";
import {
  discriminatorOf,
  toWire,
  wireProjection,
  wireRegistry,
} from "../../src/lib/operation-wire.ts";

export interface NativeOperation {
  id: string;
  input: "none" | "null" | "body";
  body?: string;
  output: string;
}

/** JSON Schema components used by the Apple client generator. */
export interface NativeContract {
  operations: readonly NativeOperation[];
  models: Readonly<Record<string, z.core.JSONSchema.JSONSchema>>;
  records: readonly string[];
}

const hasNoInput = (schema: z.ZodType): boolean => {
  let current = schema;
  while (
    [
      "optional",
      "default",
      "prefault",
      "catch",
      "readonly",
      "nonoptional",
    ].includes(current._zod.def.type)
  ) {
    // SAFETY: the wrapper kinds accepted here all expose their child schema as innerType.
    const inner = (current._zod.def as { innerType?: z.ZodType }).innerType;
    if (!inner) return false;
    current = inner;
  }
  return current._zod.def.type === "undefined";
};

const isNullInput = (schema: z.ZodType): boolean =>
  schema._zod.def.type === "null";

const createRegistries = () => ({
  input: z.registry<{ id: string }>(),
  output: z.registry<{ id: string }>(),
});

type NativeRegistries = ReturnType<typeof createRegistries>;

const projectContractSchemas = (
  contracts: readonly LoadedContract[],
  operationIds?: ReadonlySet<string>,
) => {
  for (const { contract } of contracts) {
    for (const [member, definition] of Object.entries(contract.ops)) {
      if (definition.kind === "subscription") continue;
      const id = `${contract.domain}.${member}`;
      if (operationIds && !operationIds.has(id)) continue;
      const sourceInput = definition.operationWire?.input ?? definition.input;
      const sourceOutput =
        definition.operationWire?.output ?? definition.output;
      if (
        !(sourceInput instanceof z.ZodType) ||
        !(sourceOutput instanceof z.ZodType)
      )
        throw new Error(
          `${id}: operation input and output must be Zod schemas`,
        );
      const input =
        definition.nativeModels?.input === "json" ? z.json() : sourceInput;
      if (!hasNoInput(input)) {
        try {
          toWire(input, "input");
        } catch (error) {
          throw new Error(`${id}: unsupported input wire shape`, {
            cause: error,
          });
        }
      }
      let output =
        definition.nativeModels?.output === "json" ? z.json() : sourceOutput;
      if (definition.operationWire?.nullable) output = output.nullable();
      try {
        toWire(output, "output");
      } catch (error) {
        throw new Error(`${id}: unsupported output wire shape`, {
          cause: error,
        });
      }
    }
  }
};

const registerNamedSchemas = (
  named: ReadonlyMap<string, z.ZodType>,
  registries: NativeRegistries,
) => {
  for (const [name, schema] of named) {
    // This row's `missing` child and a nested union's missing arm both claim
    // RowDiagnosticMissing; leave the row's child names operation-scoped.
    if (name === "RowDiagnostic") continue;
    const input = wireProjection(schema, "input");
    const output = wireProjection(schema, "output");
    for (const io of ["input", "output"] as const) {
      const projected = io === "input" ? input : output;
      if (projected === undefined || registries[io].has(projected)) continue;
      const id =
        io === "input" && output !== undefined && input !== output
          ? `${name}${name.endsWith("Input") ? "Request" : "Input"}`
          : name;
      registries[io].add(projected, { id });
    }
  }
};

const registerRecordSchemas = (
  records: ReadonlyMap<string, z.ZodType>,
  registry: NativeRegistries["output"],
) => {
  for (const [id, schema] of records) {
    const projected = toWire(schema, "output");
    if (!registry.has(projected)) registry.add(projected, { id });
  }
};

/**
 * Collect every query and mutation from the operation contracts. The model
 * registry follows the same `toWire` projection used by JSON-facing tools:
 * dates become ISO strings and unsupported shapes fail with their operation id.
 */
export function collectNativeContract(
  contracts: readonly LoadedContract[],
  records: ReadonlyMap<string, z.ZodType> = new Map(),
  named: ReadonlyMap<string, z.ZodType> = new Map(),
  operationIds?: readonly string[],
): NativeContract {
  const registries = createRegistries();
  const allowedOperations =
    operationIds === undefined ? undefined : new Set(operationIds);
  const register = (
    schema: z.ZodType,
    io: "input" | "output",
    fallback: string,
  ): string => {
    const registry = registries[io];
    const id =
      registry.get(schema)?.id ??
      wireRegistry.get(schema)?.id ??
      z.globalRegistry.get(schema)?.id ??
      fallback;
    if (!registry.has(schema)) registry.add(schema, { id });
    return `${io}/${id}`;
  };

  projectContractSchemas(contracts, allowedOperations);
  // Record-only children need wire projections before their exported names are registered.
  registerRecordSchemas(records, registries.output);
  registerNamedSchemas(named, registries);

  const operations: NativeOperation[] = [];
  for (const { contract } of contracts) {
    for (const [member, definition] of Object.entries(contract.ops)) {
      if (definition.kind === "subscription") continue;
      const id = `${contract.domain}.${member}`;
      if (allowedOperations && !allowedOperations.has(id)) continue;
      const name = id
        .split(".")
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join("");
      const sourceInput = definition.operationWire?.input ?? definition.input;
      const sourceOutput =
        definition.operationWire?.output ?? definition.output;
      if (
        !(sourceInput instanceof z.ZodType) ||
        !(sourceOutput instanceof z.ZodType)
      )
        throw new Error(
          `${id}: operation input and output must be Zod schemas`,
        );

      const inputSchema =
        definition.nativeModels?.input === "json" ? z.json() : sourceInput;
      let input: NativeOperation["input"] = "body";
      let body: string | undefined;
      if (hasNoInput(inputSchema)) input = "none";
      else if (isNullInput(inputSchema)) input = "null";
      else {
        try {
          body = register(
            toWire(inputSchema, "input"),
            "input",
            `${name}Input`,
          );
        } catch (error) {
          throw new Error(`${id}: unsupported input wire shape`, {
            cause: error,
          });
        }
      }

      let outputSchema =
        definition.nativeModels?.output === "json" ? z.json() : sourceOutput;
      if (definition.operationWire?.nullable)
        outputSchema = outputSchema.nullable();
      let output: string;
      try {
        output = register(
          toWire(outputSchema, "output"),
          "output",
          `${name}Output`,
        );
      } catch (error) {
        throw new Error(`${id}: unsupported output wire shape`, {
          cause: error,
        });
      }
      operations.push({ id, input, ...(body ? { body } : {}), output });
    }
  }
  operations.sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(operations.map(({ id }) => id)).size !== operations.length)
    throw new Error("Operation identities must be unique");

  const models: Record<string, z.core.JSONSchema.JSONSchema> = {};
  for (const io of ["input", "output"] as const) {
    const emitted = z.toJSONSchema(registries[io], {
      target: "draft-2020-12",
      io,
      reused: "ref",
      uri: (id) => `native://${io}/${id}`,
      override: ({ zodSchema, jsonSchema }) => {
        const discriminator = discriminatorOf(zodSchema);
        if (discriminator !== undefined)
          jsonSchema["x-native-discriminator"] = discriminator;
      },
    });
    for (const [id, schema] of Object.entries(emitted.schemas))
      models[`${io}/${id}`] = schema;
  }
  return {
    operations,
    models,
    records: [...records].map(([id, schema]) => {
      const projected = toWire(schema, "output");
      return `output/${registries.output.get(projected)?.id ?? id}`;
    }),
  };
}
