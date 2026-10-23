import type { z } from "zod";

type Schema = z.core.JSONSchema.JSONSchema;
const quoted = (value: string) => JSON.stringify(value);
const jsonLiteral = (value: unknown): string => {
  if (value === null) return ".null";
  if (typeof value === "string") return `.string(${quoted(value)})`;
  if (typeof value === "boolean") return `.bool(${value})`;
  if (typeof value === "number") return `.number(${value})`;
  throw new Error("A native literal must be a JSON scalar");
};

/** Branch membership is stricter than forward-compatible model decoding. */
export function swiftWireMatcher(
  resolve: (schema: Schema | boolean) => Schema,
) {
  const names = new Map<Schema | boolean, string>();
  const functions: string[] = [];
  const reference = (raw: Schema | boolean): string => {
    const schema = typeof raw === "object" ? resolve(raw) : raw;
    const existing = names.get(schema);
    if (existing) return existing;
    const name = `matches${names.size}`;
    names.set(schema, name);
    const call = (child: Schema | boolean, value = "value") =>
      `${reference(child)}(${value})`;
    const lines: string[] = [];
    const addGuard = (expression: string) =>
      lines.push(`        guard (${expression}) else { return false }`);
    if (schema === false) addGuard("false");
    else if (schema !== true) {
      if (schema.const !== undefined)
        addGuard(`value == ${jsonLiteral(schema.const)}`);
      else if (schema.enum)
        addGuard(
          `[${schema.enum.map(jsonLiteral).join(", ")}].contains(value)`,
        );
      else if (schema.oneOf ?? schema.anyOf)
        addGuard(
          (schema.oneOf ?? schema.anyOf)!
            .map((child) => call(child))
            .join(" || "),
        );
      else if (Array.isArray(schema.type))
        addGuard(
          schema.type.map((type) => call({ ...schema, type })).join(" || "),
        );
      else if (schema.type === "null") addGuard("value == .null");
      else if (schema.type === "boolean") addGuard("value.boolValue != nil");
      else if (schema.type === "number" || schema.type === "integer") {
        lines.push(
          "        guard let number = value.doubleValue else { return false }",
        );
        if (schema.type === "integer") addGuard("number.rounded() == number");
        for (const [key, comparison] of [
          ["minimum", ">="],
          ["maximum", "<="],
          ["exclusiveMinimum", ">"],
          ["exclusiveMaximum", "<"],
        ] as const) {
          const bound = schema[key];
          if (typeof bound === "number")
            addGuard(`number ${comparison} ${bound}`);
        }
      } else if (schema.type === "string") {
        addGuard(
          `NativeWireMatch.string(value, format: ${schema.format ? quoted(schema.format) : "nil"}, pattern: ${schema.pattern ? quoted(schema.pattern) : "nil"}, minimum: ${schema.minLength ?? "nil"}, maximum: ${schema.maxLength ?? "nil"})`,
        );
      } else if (schema.type === "array") {
        lines.push(
          "        guard let array = value.arrayValue else { return false }",
        );
        if (schema.minItems !== undefined)
          addGuard(`array.count >= ${schema.minItems}`);
        if (schema.maxItems !== undefined)
          addGuard(`array.count <= ${schema.maxItems}`);
        for (const [index, child] of (schema.prefixItems ?? []).entries())
          addGuard(
            `array.count <= ${index} || ${call(child, `array[${index}]`)}`,
          );
        if (schema.items === false)
          addGuard(`array.count <= ${schema.prefixItems?.length ?? 0}`);
        else if (schema.items !== undefined && !Array.isArray(schema.items))
          addGuard(
            `array.dropFirst(${schema.prefixItems?.length ?? 0}).allSatisfy { ${call(schema.items, "$0")} }`,
          );
      } else if (schema.type === "object" || schema.properties) {
        addGuard("value.objectValue != nil");
        const required = new Set(schema.required ?? []);
        const properties = Object.entries(schema.properties ?? {});
        for (const [key, child] of properties)
          addGuard(
            `value[${quoted(key)}].map { ${call(child, "$0")} } ?? ${required.has(key) ? "false" : "true"}`,
          );
        if (typeof schema.additionalProperties === "object") {
          const keys = `[${properties.map(([key]) => quoted(key)).join(", ")}]`;
          addGuard(
            `value.objectValue!.allSatisfy { ${keys}.contains($0.key) || ${call(schema.additionalProperties, "$0.value")} }`,
          );
        }
      }
    }
    functions.push(
      `    static func ${name}(_ value: JSONValue) -> Bool {\n${lines.join("\n")}\n        return true\n    }`,
    );
    return name;
  };
  return {
    reference: (schema: Schema | boolean) =>
      `NativeWireShapes.${reference(schema)}`,
    source: () => `enum NativeWireShapes {\n${functions.join("\n\n")}\n}`,
  };
}
