import { z } from "zod";
import {
  manifestWire,
  structuredTextFormats,
  type ManifestWireName,
  type ManifestWire,
} from "../../../../packages/schemas/src/manifest-wire.ts";
import { generatedHeader } from "../../artifacts.ts";

const swiftType = (type: string): string => {
  if (type.endsWith("?") || type.endsWith("~"))
    return `${swiftType(type.slice(0, -1))}?`;
  if (type.startsWith("[string:"))
    return `[String: ${swiftType(type.slice(8, -1))}]`;
  if (type.startsWith("[")) return `[${swiftType(type.slice(1, -1))}]`;
  return (
    {
      string: "String",
      integer: "Int",
      boolean: "Bool",
      Json: "JSONValue",
      StructuredTextFormat: "String",
    }[type] ?? type
  );
};
const identifier = (name: string) =>
  ["enum", "default"].includes(name) ? `\`${name}\`` : name;

export const renderManifestWire = (): string => {
  const render = (name: string, indent = ""): string => {
    // SAFETY: names are enumerated from this same declaration dictionary, including nested types.
    const definition = manifestWire[name as ManifestWireName];
    const localName = name.split(".").at(-1);
    const raw = definition.kind === "raw";
    const conformances = [
      ...(raw ? ["String"] : []),
      ...definition.conformances,
    ].join(", ");
    const indirect =
      "indirect" in definition && definition.indirect ? "indirect " : "";
    const lines = [
      `${indent}public ${indirect}${raw ? "enum" : definition.kind} ${localName}: ${conformances} {`,
    ];
    const prefix = `${indent}    `;
    if (definition.kind === "struct") {
      for (const [key, type] of Object.entries(definition.fields))
        lines.push(`${prefix}public let ${key}: ${swiftType(type)}`);
      if (definition.defaults !== undefined) {
        const defaults: Readonly<Record<string, string>> = definition.defaults;
        const args = Object.entries(definition.fields).map(
          ([key, type]) =>
            `${key}: ${swiftType(type)}${key in defaults ? ` = ${defaults[key]}` : ""}`,
        );
        lines.push("", `${prefix}public init(${args.join(", ")}) {`);
        for (const key of Object.keys(definition.fields))
          lines.push(`${prefix}    self.${key} = ${key}`);
        lines.push(`${prefix}}`);
      }
    } else if (definition.kind === "raw") {
      for (const [key, value] of Object.entries(definition.cases))
        lines.push(
          `${prefix}case ${identifier(key)} = ${JSON.stringify(value)}`,
        );
    } else {
      for (const [key, fields] of Object.entries(definition.cases)) {
        const payload = Object.entries(fields)
          .map(
            ([label, type]) =>
              `${label.startsWith("_") ? "" : `${label}: `}${swiftType(type)}`,
          )
          .join(", ");
        lines.push(
          `${prefix}case ${identifier(key)}${payload ? `(${payload})` : ""}`,
        );
      }
    }
    for (const child of Object.keys(manifestWire).filter(
      (key) =>
        key.startsWith(`${name}.`) && !key.slice(name.length + 1).includes("."),
    ))
      lines.push("", render(child, prefix));
    lines.push(`${indent}}`);
    return lines.join("\n");
  };
  return (
    generatedHeader +
    "// swift-format-ignore-file\n\nimport CubbyAPISupport\nimport Foundation\n\n" +
    Object.keys(manifestWire)
      .filter((name) => !name.includes("."))
      .map((name) => render(name))
      .join("\n\n") +
    "\n"
  );
};

/** Validate the same descriptor storage that Swift decodes. */
const wireSchema = (type: string): z.ZodType =>
  z.lazy(() => {
    if (type.endsWith("?")) return wireSchema(type.slice(0, -1)).nullish();
    if (type.endsWith("~")) return wireSchema(type.slice(0, -1)).nullable();
    if (type.startsWith("[string:"))
      return z.record(z.string(), wireSchema(type.slice(8, -1)));
    if (type.startsWith("[")) return z.array(wireSchema(type.slice(1, -1)));
    const object = (fields: Readonly<Record<string, string>>) =>
      z.strictObject(
        Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [
            key,
            wireSchema(value),
          ]),
        ),
      );
    if (type in manifestWire) {
      // SAFETY: guarded by metadata dictionary membership, not a domain identifier.
      const definition = manifestWire[type as ManifestWireName];
      if (definition.kind === "struct")
        return object({
          ...definition.fields,
          ...definition.wireOnly,
        });
      if (definition.kind === "raw")
        return z.enum(Object.values(definition.cases));
      return z.union(
        Object.entries(definition.cases).map(([key, fields]) =>
          z.strictObject({ [key]: object(fields) }),
        ),
      );
    }
    if (type === "Json") return z.json();
    if (type === "integer") return z.int();
    if (type === "boolean") return z.boolean();
    if (type === "StructuredTextFormat") return z.enum(structuredTextFormats);
    if (
      [
        "string",
        "EntityKey",
        "EntityFieldKind",
        "EntityControlKind",
        "ControlRendererID",
        "ListRendererID",
        "DetailRendererID",
        "EntityFilterKind",
        "EntityHeroActionID",
        "WayfindingDomain",
      ].includes(type)
    )
      return z.string();
    throw new Error(`Undeclared manifest wire type: ${type}`);
  });

/** Reject wire drift without stripping properties or supplying decode defaults. */
export const assertManifestWire: <N extends ManifestWireName>(
  name: N,
  value: unknown,
) => asserts value is ManifestWire<N> = (name, value) => {
  wireSchema(name).parse(value);
};
