import type { z } from "zod";
import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { NativeContract } from "./native-contract.ts";
import { pascal } from "./schema-names.ts";
import { swiftWireMatcher } from "./swift-wire-match.ts";
import { TYPE_OVERRIDES } from "./type-overrides.ts";

type Schema = z.core.JSONSchema.JSONSchema;
interface NullableSchema {
  schema: Schema;
  nullable: boolean;
}
export interface SwiftModels {
  artifacts: EntityArtifacts[];
  types: ReadonlyMap<string, string>;
  names: readonly string[];
}
const literal = (value: string) => JSON.stringify(value);
const caseName = (value: string) => {
  const words = /^[A-Z0-9_]+$/u.test(value) ? value.toLowerCase() : value;
  return words
    .replace(/[^A-Za-z0-9]+([A-Za-z0-9])/gu, (_, letter: string) =>
      letter.toUpperCase(),
    )
    .replace(/^[A-Z]/u, (letter) => letter.toLowerCase());
};
const identifier = (value: string) =>
  `\`${value.replace(/[^A-Za-z0-9_]/gu, "_")}\``;

/** A constrained Swift model emitter: unsupported wire shapes fail generation. */
export function renderSwiftModels(contract: NativeContract): SwiftModels {
  const declarations = new Map<string, string>();
  const declarationSchemas = new Map<string, string>();
  const claimDeclaration = (name: string, schema: Schema) => {
    const fingerprint = JSON.stringify({
      ...schema,
      $id: undefined,
      $schema: undefined,
    });
    const claimed = declarationSchemas.get(name);
    if (claimed !== undefined && claimed !== fingerprint)
      throw new Error(
        `${name}: incompatible structural model name collision (${claimed.slice(0, 180)} != ${fingerprint.slice(0, 180)})`,
      );
    declarationSchemas.set(name, fingerprint);
    return declarations.has(name);
  };
  const references = new Map<string, string>();
  const owners = new Map<string, string>();
  const stack: string[] = [];
  const dependencies = new Map<string, Set<string>>();
  const depend = (name: string) => {
    const parent = stack.at(-1);
    if (parent === undefined || parent === name) return;
    const children = dependencies.get(parent) ?? new Set<string>();
    children.add(name);
    dependencies.set(parent, children);
  };
  const resolve = (raw: Schema | boolean): Schema => {
    if (typeof raw !== "object")
      throw new Error("Expected a native model schema");
    let schema = raw;
    const visited = new Set<string>();
    while (schema.$ref) {
      const ref = schema.$ref;
      if (visited.has(ref))
        throw new Error(`Native reference alias cycle: ${ref}`);
      visited.add(ref);
      const [key, pointer] = ref.replace(/^native:\/\//u, "").split("#");
      let target: Schema | boolean | undefined = contract.models[key!];
      if (pointer) {
        const [empty, definitions, definition, ...rest] = pointer.split("/");
        if (
          empty !== "" ||
          definitions !== "$defs" ||
          !definition ||
          rest.length > 0
        )
          throw new Error(`Unsupported native reference ${ref}`);
        target = target?.$defs?.[definition];
      }
      if (typeof target !== "object")
        throw new Error(`Missing native model ${ref}`);
      schema = target;
    }
    return schema;
  };
  const matcher = swiftWireMatcher(resolve);
  const modelName = (key: string) => {
    const [io, ...parts] = key.split("/");
    const base = parts.map(pascal).join("");
    const name = base;
    const existing = owners.get(name);
    if (existing !== undefined && existing !== key) {
      const clean = (schema: Schema | undefined) =>
        schema === undefined
          ? undefined
          : JSON.stringify({ ...schema, $id: undefined, $schema: undefined });
      const left = clean(contract.models[existing]);
      if (left !== undefined && left === clean(contract.models[key]))
        return name;
    }
    const resolved =
      existing === undefined || existing === key
        ? name
        : `${pascal(io!)}${name}`;
    if (owners.has(resolved) && owners.get(resolved) !== key)
      throw new Error(`Native model name collision: ${key}`);
    owners.set(resolved, key);
    return resolved;
  };
  const refType = (ref: string): string => {
    const cached = references.get(ref);
    if (cached !== undefined) {
      depend(cached);
      return cached;
    }
    const [key, pointer] = ref.replace(/^native:\/\//u, "").split("#");
    let schema: Schema | boolean | undefined = contract.models[key!];
    if (pointer) {
      const [empty, definitions, definition, ...rest] = pointer.split("/");
      if (
        empty !== "" ||
        definitions !== "$defs" ||
        !definition ||
        rest.length > 0
      )
        throw new Error(`Unsupported native reference ${ref}`);
      schema = schema?.$defs?.[definition];
    }
    if (schema === undefined || typeof schema !== "object")
      throw new Error(`Missing native model ${ref}`);
    const base = key!.split("/").at(-1)!;
    const override = Object.entries(TYPE_OVERRIDES).find(
      ([name]) => name === base,
    )?.[1];
    if (override !== undefined && !pointer) {
      references.set(ref, override);
      return override;
    }
    const name = modelName(
      `${key}${pointer ? pointer.replaceAll("/$defs/", "/") : ""}`,
    );
    references.set(ref, name);
    depend(name);
    const result = emit(schema, name);
    if (result !== name) {
      claimDeclaration(name, schema);
      declarations.set(name, `public typealias ${name} = ${result}`);
    }
    return name;
  };
  const withoutNull = (schema: Schema): NullableSchema => {
    if (Array.isArray(schema.type) && schema.type.includes("null")) {
      const types = schema.type.filter((type) => type !== "null");
      if (types.length === 0)
        return { schema: { ...schema, type: "null" }, nullable: false };
      if (types.length === 1)
        return { schema: { ...schema, type: types[0] }, nullable: true };
      return {
        schema: {
          ...schema,
          type: undefined,
          anyOf: types.map((type) => ({ type })),
        },
        nullable: true,
      };
    }
    const arms = schema.anyOf ?? schema.oneOf;
    if (arms?.some((arm) => typeof arm === "object" && arm.type === "null")) {
      const remaining = arms.filter(
        (arm) => !(typeof arm === "object" && arm.type === "null"),
      );
      if (remaining.length === 1 && typeof remaining[0] === "object")
        return { schema: remaining[0], nullable: true };
      return {
        schema: { ...schema, anyOf: remaining, oneOf: undefined },
        nullable: true,
      };
    }
    return { schema, nullable: false };
  };
  const emit = (raw: Schema | boolean, name: string): string => {
    depend(name);
    stack.push(name);
    try {
      return emitNode(raw, name);
    } finally {
      stack.pop();
    }
  };
  const isJSONValue = (schema: Schema): boolean => {
    const jsonArms = schema.anyOf;
    if (
      jsonArms?.length === 6 &&
      jsonArms.every((arm) => typeof arm === "object") &&
      ["string", "number", "boolean", "null", "array", "object"].every((type) =>
        jsonArms.some((arm) => typeof arm === "object" && arm.type === type),
      )
    ) {
      const array = jsonArms.find(
        (arm) => typeof arm === "object" && arm.type === "array",
      );
      const object = jsonArms.find(
        (arm) => typeof arm === "object" && arm.type === "object",
      );
      if (
        typeof array === "object" &&
        typeof array.items === "object" &&
        !Array.isArray(array.items) &&
        typeof object === "object" &&
        typeof object.additionalProperties === "object" &&
        array.items.$ref !== undefined &&
        array.items.$ref === object.additionalProperties.$ref
      )
        return true;
    }
    return false;
  };
  const emitEnum = (schema: Schema, name: string): string => {
    if (claimDeclaration(name, schema)) return name;
    const values = schema.const !== undefined ? [schema.const] : schema.enum!;
    const scalar = typeof values[0];
    if (
      !["string", "number", "boolean"].includes(scalar) ||
      !values.every((value) => typeof value === scalar)
    )
      throw new Error(`${name}: mixed scalar enum requires a projection`);
    const rawType =
      scalar === "number" ? "Double" : scalar === "boolean" ? "Bool" : "String";
    const raw = (value: unknown) =>
      scalar === "string" ? literal(String(value)) : JSON.stringify(value);
    const enumCase = (value: unknown) =>
      scalar === "number"
        ? `_${String(value).replaceAll("-", "negative").replaceAll(".", "_")}`
        : scalar === "boolean"
          ? `${value}Value`
          : caseName(String(value));
    if (
      values.some((value) => enumCase(value) === "unrecognized") ||
      new Set(values.map((value) => enumCase(value))).size !== values.length
    )
      throw new Error(`${name}: native enum case collision`);
    const cases = values
      .map((value) => `    case ${identifier(enumCase(value))}`)
      .join("\n");
    declarations.set(
      name,
      `public enum ${name}: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {\n${cases}\n    case unrecognized(${rawType})\n    public static var allCases: [Self] { [${values.map((value) => `.${identifier(enumCase(value))}`).join(", ")}] }\n\n    public init(from decoder: any Decoder) throws {\n        let value = try decoder.singleValueContainer().decode(${rawType}.self)\n        switch value {\n${values.map((value) => `        case ${raw(value)}: self = .${identifier(enumCase(value))}`).join("\n")}\n        default: self = .unrecognized(value)\n        }\n    }\n    public var rawValue: ${rawType} {\n        switch self {\n${values.map((value) => `        case .${identifier(enumCase(value))}: ${raw(value)}`).join("\n")}\n        case .unrecognized(let value): value\n        }\n    }\n    public init(rawValue: ${rawType}) {\n        switch rawValue {\n${values.map((value) => `        case ${raw(value)}: self = .${identifier(enumCase(value))}`).join("\n")}\n        default: self = .unrecognized(rawValue)\n        }\n    }\n    public func encode(to encoder: any Encoder) throws {\n        var container = encoder.singleValueContainer()\n        try container.encode(rawValue)\n    }\n}`,
    );
    return name;
  };
  const emitArray = (schema: Schema, name: string): string => {
    if (schema.maxItems === 0) return "NativeEmptyArray";
    if (!Array.isArray(schema.prefixItems)) {
      if (!schema.items || Array.isArray(schema.items))
        throw new Error(
          `${name}: tuple requires an explicit native projection`,
        );
      return `[${emit(schema.items, `${name}Item`)}]`;
    }
    if (
      schema.items !== false &&
      (typeof schema.items !== "object" || Array.isArray(schema.items))
    )
      throw new Error(`${name}: unsupported tuple item schema`);
    const fixed = schema.prefixItems.map((item, index) => ({
      key: `element${index + 1}`,
      type: emit(item, `${name}Element${index + 1}`),
    }));
    const rest =
      schema.items === false
        ? undefined
        : emit(schema.items, `${name}RestItem`);
    if (fixed.length === 0 && rest !== undefined) return `[${rest}]`;
    if (claimDeclaration(name, schema)) return name;
    const fields = [
      ...fixed,
      ...(rest === undefined ? [] : [{ key: "rest", type: `[${rest}]` }]),
    ];
    const decodeFixed = fixed.map(
      ({ key, type }) =>
        `        self.${identifier(key)} = try container.decode(${type}.self)`,
    );
    const encodeFixed = fixed.map(
      ({ key }) => `        try container.encode(self.${identifier(key)})`,
    );
    declarations.set(
      name,
      `public struct ${name}: Codable, Hashable, Sendable {\n${fields.map(({ key, type }) => `    public var ${identifier(key)}: ${type}`).join("\n")}\n    public init(${fields.map(({ key, type }) => `${identifier(key)}: ${type}`).join(", ")}) {\n${fields.map(({ key }) => `        self.${identifier(key)} = ${identifier(key)}`).join("\n")}\n    }\n    public init(from decoder: any Decoder) throws {\n        var container = try decoder.unkeyedContainer()\n${decodeFixed.join("\n")}\n${rest === undefined ? `        guard container.isAtEnd else { throw DecodingError.dataCorrupted(.init(codingPath: container.codingPath, debugDescription: ${literal(`Expected exactly ${fixed.length} tuple elements`)})) }\n` : `        var values: [${rest}] = []\n        while !container.isAtEnd { values.append(try container.decode(${rest}.self)) }\n        self.rest = values\n`}    }\n    public func encode(to encoder: any Encoder) throws {\n        var container = encoder.unkeyedContainer()\n${encodeFixed.join("\n")}\n${rest === undefined ? "" : "        for value in self.rest { try container.encode(value) }\n"}    }\n}`,
    );
    return name;
  };
  const emitNode = (raw: Schema | boolean, name: string): string => {
    if (raw === true) return "JSONValue";
    if (raw === false) throw new Error(`${name}: impossible schema`);
    if (isJSONValue(raw)) return "JSONValue";
    const { schema, nullable } = withoutNull(raw);
    if (nullable) return `${emit(schema, `${name}Value`)}?`;
    if (schema.$ref) return refType(schema.$ref);
    if (Array.isArray(schema.type))
      return emit(
        {
          ...schema,
          type: undefined,
          anyOf: schema.type.map((type) => ({ type })),
        },
        name,
      );
    if (schema.const === null) return "JSONNull";
    const literalArms = schema.oneOf ?? schema.anyOf;
    if (literalArms) {
      const values = literalArms.map((arm) => resolve(arm).const);
      const scalar = typeof values[0];
      if (
        values.every((value) => value !== undefined) &&
        ["string", "number", "boolean"].includes(scalar) &&
        values.every((value) => typeof value === scalar)
      ) {
        return emit({ enum: values }, name);
      }
    }
    if (schema.enum || schema.const !== undefined)
      return emitEnum(schema, name);
    if (schema.type === "string")
      return schema.format === "date-time" ? "Date" : "String";
    if (schema.type === "integer") return "Int";
    if (schema.type === "number") return "Double";
    if (schema.type === "boolean") return "Bool";
    if (schema.type === "null") return "JSONNull";
    if (schema.type === "array") return emitArray(schema, name);
    const variants = schema.oneOf ?? schema.anyOf;
    if (variants) {
      if (claimDeclaration(name, schema)) return name;
      const types = variants.map((variant, index) =>
        emit(variant, `${name}Variant${index + 1}`),
      );
      const tagFor = (
        variant: Schema | boolean,
        key: string,
      ): readonly unknown[] | undefined => {
        const model = resolve(variant);
        const members = model.oneOf ?? model.anyOf;
        if (members) {
          const tags = members.map((member) => tagFor(member, key));
          return tags.every((tag) => tag !== undefined)
            ? [...new Set(tags.flatMap((tag) => tag))]
            : undefined;
        }
        if (!model.required?.includes(key)) return undefined;
        const property = model.properties?.[key];
        if (typeof property !== "object") return undefined;
        const tag = resolve(property);
        return tag.const !== undefined ? [tag.const] : tag.enum;
      };
      const keysFor = (variant: Schema | boolean): string[] => {
        const model = resolve(variant);
        const members = model.oneOf ?? model.anyOf;
        if (!members) return Object.keys(model.properties ?? {});
        const keys = members.map(keysFor);
        return (
          keys[0]?.filter((key) =>
            keys.every((member) => member.includes(key)),
          ) ?? []
        );
      };
      const disjointTags = (key: string) => {
        const tags = variants.map((variant) => tagFor(variant, key));
        if (tags.some((tag) => tag === undefined)) return false;
        const owners = new Map<string, number>();
        return tags.every((tag, index) =>
          tag!.every((value) => {
            const encoded = JSON.stringify(value);
            const owner = owners.get(encoded);
            owners.set(encoded, index);
            return owner === undefined || owner === index;
          }),
        );
      };
      const explicit = schema["x-native-discriminator"];
      const discriminator =
        typeof explicit === "string" && disjointTags(explicit)
          ? explicit
          : keysFor(variants[0]!).find(disjointTags);
      const values = variants.map((variant) =>
        typeof discriminator === "string"
          ? tagFor(variant, discriminator)
          : undefined,
      );
      const discriminated =
        typeof discriminator === "string" &&
        values.every((value) => value !== undefined);
      const semanticCases =
        discriminated &&
        values.every(
          (value) => value?.length === 1 && typeof value[0] === "string",
        );
      const pattern = (value: unknown) => {
        if (typeof value === "string")
          return `.some(.string(${literal(value)}))`;
        if (typeof value === "boolean") return `.some(.bool(${value}))`;
        if (typeof value === "number") return `.some(.number(${value}))`;
        if (value === null) return ".some(.null)";
        throw new Error(`${name}: unsupported discriminator literal`);
      };
      const cases = types.map((_, index) =>
        semanticCases
          ? caseName(String(values[index]![0]))
          : `value${index + 1}`,
      );
      if (
        cases.includes("unrecognized") ||
        new Set(cases).size !== cases.length
      )
        throw new Error(`${name}: native union case collision`);
      declarations.set(
        name,
        `public indirect enum ${name}: Codable, Hashable, Sendable {\n${types.map((type, index) => `    case ${identifier(cases[index]!)}(${type})`).join("\n")}\n    case unrecognized(JSONValue)\n    public init(from decoder: any Decoder) throws {\n${discriminated ? `        let raw = try JSONValue(from: decoder)\n        switch raw[${literal(discriminator)}] {\n${types.map((type, index) => `        case ${values[index]!.map(pattern).join(", ")}: self = .${identifier(cases[index]!)}(try decoder.singleValueContainer().decode(${type}.self))`).join("\n")}\n        default: self = .unrecognized(raw)\n        }` : `        let raw = try JSONValue(from: decoder)\n        let matches = [${variants.map((variant) => `${matcher.reference(variant)}(raw)`).join(", ")}]\n        guard matches.filter({ $0 }).count == 1 else { self = .unrecognized(raw); return }\n${types.map((type, index) => `        if matches[${index}] { self = .${identifier(cases[index]!)}(try decoder.singleValueContainer().decode(${type}.self)); return }`).join("\n")}\n        self = .unrecognized(raw)`}\n    }\n    public func encode(to encoder: any Encoder) throws {\n        var container = encoder.singleValueContainer()\n        switch self {\n${types.map((_, index) => `        case .${identifier(cases[index]!)}(let value): try container.encode(value)`).join("\n")}\n        case .unrecognized(let value): try container.encode(value)\n        }\n    }\n}`,
      );
      return name;
    }
    if (schema.allOf)
      throw new Error(
        `${name}: intersection requires an explicit native projection`,
      );
    if (schema.type === "object" || schema.properties) {
      const entries = Object.entries(schema.properties ?? {});
      if (entries.length === 0) {
        if (typeof schema.additionalProperties === "object")
          return `[String: ${emit(schema.additionalProperties, `${name}Value`)}]`;
        return "JSONValue";
      }
      if (claimDeclaration(name, schema)) return name;
      const required = new Set(schema.required ?? []);
      const fields = entries.map(([key, child]) => {
        if (typeof child !== "object")
          throw new Error(`${name}.${key}: boolean property schema`);
        const { schema: concrete, nullable } = withoutNull(child);
        const nullableAlias = !nullable && withoutNull(resolve(child)).nullable;
        const allowsNull = nullable || nullableAlias;
        const value = emit(concrete, `${name}${pascal(key)}`);
        const optional = !required.has(key);
        const wireType = `${value}${nullable ? "?" : ""}`;
        const type =
          optional && allowsNull
            ? `NativeField<${wireType}>`
            : `${wireType}${optional ? "?" : ""}`;
        return {
          key,
          value,
          wireType,
          type,
          optional,
          allowsNull,
          // A named alias may hide the same stored-value cycle as a direct self reference.
          recursive: value === name || resolve(concrete) === schema,
        };
      });
      declarations.set(
        name,
        `public struct ${name}: Codable, Hashable, Sendable {\n${fields.map(({ key, type, recursive }) => `    ${recursive ? "@NativeIndirect " : ""}public var ${identifier(key)}: ${type}`).join("\n")}\n    public init(${fields.map(({ key, type, optional, allowsNull }) => `${identifier(key)}: ${type}${optional ? (allowsNull ? " = .absent" : " = nil") : ""}`).join(", ")}) {\n${fields.map(({ key, recursive }) => `        self.${identifier(recursive ? `_${key}` : key)} = ${recursive ? `.init(wrappedValue: ${identifier(key)})` : identifier(key)}`).join("\n")}\n    }\n    private enum CodingKeys: String, CodingKey { ${fields.map(({ key }) => `case ${identifier(key)} = ${literal(key)}`).join("; ")} }\n    public init(from decoder: any Decoder) throws {\n        let container = try decoder.container(keyedBy: CodingKeys.self)\n${fields
          .map(({ key, wireType, optional, allowsNull, recursive }) => {
            const decode = `try container.decode(${wireType}.self, forKey: .${identifier(key)})`;
            const expression = `${optional ? `container.contains(.${identifier(key)}) ? ${allowsNull ? `.value(${decode})` : decode} : ${allowsNull ? ".absent" : "nil"}` : decode}`;
            return `        self.${identifier(recursive ? `_${key}` : key)} = ${recursive ? `.init(wrappedValue: ${expression})` : expression}`;
          })
          .join(
            "\n",
          )}\n    }\n    public func encode(to encoder: any Encoder) throws {\n        var container = encoder.container(keyedBy: CodingKeys.self)\n${fields.map(({ key, optional, allowsNull }) => (optional ? (allowsNull ? `        if case .value(let value) = self.${identifier(key)} { try container.encode(value, forKey: .${identifier(key)}) }` : `        if let value = self.${identifier(key)} { try container.encode(value, forKey: .${identifier(key)}) }`) : `        try container.encode(self.${identifier(key)}, forKey: .${identifier(key)})`)).join("\n")}\n    }\n}`,
      );
      return name;
    }
    if (
      Object.keys(schema).every((key) =>
        [
          "$id",
          "$schema",
          "description",
          "title",
          "default",
          "mock",
          "mockValue",
          "opaque",
          "createOnly",
          "notice",
        ].includes(key),
      )
    )
      return "JSONValue";
    throw new Error(
      `${name}: unsupported native schema ${JSON.stringify(schema)}`,
    );
  };
  for (const operation of contract.operations) {
    for (const key of [operation.body, operation.output])
      if (key) refType(`native://${key}`);
  }
  for (const key of contract.records) refType(`native://${key}`);
  const domains = new Map<string, Set<string>>();
  const mark = (name: string, domain: string) => {
    const used = domains.get(name) ?? new Set<string>();
    if (used.has(domain)) return;
    used.add(domain);
    domains.set(name, used);
    for (const child of dependencies.get(name) ?? []) mark(child, domain);
  };
  for (const operation of contract.operations) {
    for (const key of [operation.body, operation.output]) {
      if (key) mark(refType(`native://${key}`), operation.id.split(".")[0]!);
    }
  }
  for (const key of contract.records)
    mark(refType(`native://${key}`), "shared");
  const groups = new Map<string, string[]>();
  for (const [name, source] of [...declarations].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const uses = domains.get(name);
    const domain = uses?.size === 1 ? [...uses][0]! : "shared";
    const group = groups.get(domain) ?? [];
    group.push(source);
    groups.set(domain, group);
  }
  const artifacts = [...groups].map(([domain, sources]) => ({
    relativePath: `apps/apple/CubbyKit/Sources/CubbyAPI/Models/${domain}.gen.swift`,
    source: `${generatedHeader}// swift-format-ignore-file\nimport Foundation\nimport CubbyAPISupport\n\n${sources.join("\n\n")}\n`,
  }));
  artifacts.push({
    relativePath:
      "apps/apple/CubbyKit/Sources/CubbyAPI/Models/native-wire.gen.swift",
    source: `${generatedHeader}// swift-format-ignore-file\nimport Foundation\nimport CubbyAPISupport\n\n${matcher.source()}\n`,
  });
  return {
    artifacts,
    types: references,
    names: [...declarations.keys()].sort(),
  };
}
