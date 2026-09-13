import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

type IdentifierViolationKind =
  | "unsafe-helper-declaration"
  | "unsafe-helper-import"
  | "unsafe-helper-call"
  | "branded-assertion";

export type IdentifierViolation = Readonly<{
  file: string;
  kind: IdentifierViolationKind;
  message: string;
  start: number;
  end: number;
  line: number;
  column: number;
}>;

type AstValue =
  | AstNode
  | readonly AstValue[]
  | boolean
  | null
  | number
  | string
  | undefined;
type AstNode = {
  type: string;
  name?: string;
  value?: AstValue;
  start?: number;
  end?: number;
  operator?: string;
  computed?: boolean;
  object?: AstValue;
  property?: AstValue;
  left?: AstValue;
  right?: AstValue;
  key?: AstValue;
  id?: AstValue;
  init?: AstValue;
  expression?: AstValue;
  callee?: AstValue;
  source?: AstValue;
  typeAnnotation?: AstValue;
  typeName?: AstValue;
  typeParameters?: AstValue;
  typeArguments?: AstValue;
  constraint?: AstValue;
  exprName?: AstValue;
  imported?: AstValue;
  local?: AstValue;
  exported?: AstValue;
  params?: readonly AstValue[];
  specifiers?: readonly AstValue[];
  elements?: readonly AstValue[];
  arguments?: readonly AstValue[];
  properties?: readonly AstValue[];
};
type Unit = Readonly<{ file: string; source: string; program: AstNode }>;
type Link = Readonly<{ source: string; name: string }>;
type ModuleInfo = {
  types: Map<string, AstNode>;
  values: Map<string, AstNode>;
  imports: Map<string, Link | { source: string; namespace: true }>;
  reexports: Map<string, Link>;
  stars: string[];
  constants: Map<string, string>;
};

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
// Xcode/SwiftPM build output lives in-tree (`apps/apple/DerivedData`, `.build`) and
// contains package checkouts with dangling symlinks that `statSync` cannot follow.
const IGNORED_DIRECTORIES = new Set([
  ".build",
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "DerivedData",
  "dist",
  "node_modules",
]);
const UNSAFE_HELPER = /^unsafe(?:[A-Z][A-Za-z0-9]*)?(?:Id|Shortcode)$/u;
const TESTING_MODULE = "@cubby/schemas/testing";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const isNode = <TValue>(value: TValue): value is TValue & AstNode =>
  typeof value === "object" && value !== null && "type" in value;
const isNumberValue = (value: number | undefined): value is number =>
  typeof value === "number";
const isStringValue = <TValue>(value: TValue): value is TValue & string =>
  typeof value === "string";
const children = (node: AstNode): AstNode[] =>
  Object.values(node).flatMap((value) =>
    Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
  );
const walk = (node: AstNode, visit: (node: AstNode) => void): void => {
  visit(node);
  for (const child of children(node)) walk(child, visit);
};
const nameOf = (node: AstNode | undefined): string | undefined =>
  node?.type === "Identifier" || node?.type === "PrivateIdentifier"
    ? node.name
    : undefined;
const qualified = (node: AstNode | undefined): string[] => {
  if (!node) return [];
  if (node.type === "TSQualifiedName") {
    return [
      ...qualified(isNode(node.left) ? node.left : undefined),
      ...qualified(isNode(node.right) ? node.right : undefined),
    ];
  }
  const name = nameOf(node);
  return name ? [name] : [];
};
const literal = <TValue>(node: TValue): string | undefined =>
  isNode(node) && node.type === "Literal" && isStringValue(node.value)
    ? node.value
    : undefined;
const unsafeName = (name: string | undefined): name is string =>
  name !== undefined &&
  (UNSAFE_HELPER.test(name) || name === "unsafeIdForEntity");
const rangeOf = (node: AstNode) => ({
  start: isNumberValue(node.start) ? node.start : 0,
  end: isNumberValue(node.end) ? node.end : 0,
});
const positionAt = (source: string, offset: number) => {
  const prefix = source.slice(0, offset);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  return { line: prefix.split("\n").length, column: offset - lineStart + 1 };
};

const parseUnit = (file: string, source: string): Unit => {
  const parsed = parseSync(file, source, {
    lang: extname(file) === ".tsx" ? "tsx" : "ts",
    range: true,
  });
  const error = parsed.errors.at(0);
  if (error) throw new Error(`${file}: ${error.message}`);
  return {
    file: resolve(file),
    source,
    program: parsed.program,
  };
};

type JsonValue =
  | JsonObject
  | readonly JsonValue[]
  | boolean
  | null
  | number
  | string;
type JsonObject = {
  [key: string]: JsonValue | undefined;
  name?: JsonValue;
  exports?: JsonValue;
  main?: JsonValue;
};
type PackageExports = string | ReadonlyMap<string, string> | undefined;
type PackageManifest = {
  name?: string;
  exports?: PackageExports;
  main?: string;
};
const isJsonObject = <TValue>(value: TValue): value is TValue & JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringExport = <TValue>(value: TValue): value is TValue & string =>
  isStringValue(value);
const parsePackageManifest = (value: JsonValue): PackageManifest => {
  if (!isJsonObject(value)) throw new Error("package.json must be an object");
  const name = isStringValue(value.name) ? value.name : undefined;
  const main = isStringValue(value.main) ? value.main : undefined;
  if (value.exports === undefined || isStringExport(value.exports))
    return { name, main, exports: value.exports };
  if (!isJsonObject(value.exports))
    throw new Error("package.json exports must be a string or object");
  const entries = Object.entries(value.exports);
  const exportsMap = new Map<string, string>();
  for (const [key, target] of entries) {
    if (!isStringValue(target))
      throw new Error("package.json export targets must be strings");
    exportsMap.set(key, target);
  }
  return { name, main, exports: exportsMap };
};

const workspaceExports = (): Map<string, string> => {
  const result = new Map<string, string>();
  const directory = resolve(root, "packages");
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const packageFile = join(directory, entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(packageFile)) continue;
    const manifest = parsePackageManifest(
      JSON.parse(readFileSync(packageFile, "utf8")),
    );
    if (!manifest.name) continue;
    if (isStringExport(manifest.exports)) {
      result.set(
        manifest.name,
        resolve(dirname(packageFile), manifest.exports),
      );
    } else if (manifest.exports) {
      for (const [key, target] of manifest.exports) {
        result.set(
          key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`,
          resolve(dirname(packageFile), target),
        );
      }
    } else if (manifest.main) {
      result.set(manifest.name, resolve(dirname(packageFile), manifest.main));
    }
  }
  return result;
};
const PACKAGE_EXPORTS = workspaceExports();

const collectModuleNode = (node: AstNode, info: ModuleInfo): void => {
  collectModuleDeclarations(node, info);
  collectModuleImport(node, info);
  collectModuleReexport(node, info);
};

const collectModuleDeclarations = (node: AstNode, info: ModuleInfo): void => {
  if (
    node.type === "TSTypeAliasDeclaration" ||
    node.type === "TSInterfaceDeclaration"
  ) {
    const name = nameOf(isNode(node.id) ? node.id : undefined);
    if (name) info.types.set(name, node);
    return;
  }
  if (node.type === "FunctionDeclaration") {
    const name = nameOf(isNode(node.id) ? node.id : undefined);
    if (name) info.values.set(name, node);
    return;
  }
  if (node.type === "VariableDeclarator") {
    const name = nameOf(isNode(node.id) ? node.id : undefined);
    if (name && isNode(node.init)) info.values.set(name, node.init);
  }
};

const collectModuleImport = (node: AstNode, info: ModuleInfo): void => {
  if (node.type !== "ImportDeclaration") return;
  const source = literal(node.source);
  if (!source) return;
  for (const item of Array.isArray(node.specifiers) ? node.specifiers : []) {
    if (!isNode(item)) continue;
    const local = nameOf(isNode(item.local) ? item.local : undefined);
    if (!local) continue;
    if (item.type === "ImportNamespaceSpecifier") {
      info.imports.set(local, { source, namespace: true });
      continue;
    }
    const imported = nameOf(isNode(item.imported) ? item.imported : undefined);
    if (imported) info.imports.set(local, { source, name: imported });
  }
};

const collectModuleReexport = (node: AstNode, info: ModuleInfo): void => {
  if (node.type === "ExportAllDeclaration") {
    const source = literal(node.source);
    if (source) info.stars.push(source);
    return;
  }
  if (node.type !== "ExportNamedDeclaration") return;
  const source = literal(node.source);
  if (!source) return;
  for (const item of Array.isArray(node.specifiers) ? node.specifiers : []) {
    if (!isNode(item)) continue;
    const local = nameOf(isNode(item.local) ? item.local : undefined);
    const exported = nameOf(isNode(item.exported) ? item.exported : undefined);
    if (local && exported)
      info.reexports.set(exported, { source, name: local });
  }
};

class Provenance {
  private readonly modules = new Map<string, ModuleInfo>();
  private readonly files: ReadonlySet<string>;
  private readonly typeMemo = new Map<string, boolean>();
  private readonly valueMemo = new Map<string, boolean>();
  private readonly resolvingTypes = new Set<string>();
  private readonly resolvingValues = new Set<string>();

  constructor(units: readonly Unit[]) {
    this.files = new Set(units.map((unit) => unit.file));
    for (const unit of units) this.modules.set(unit.file, this.collect(unit));
  }

  private collect(unit: Unit): ModuleInfo {
    const info: ModuleInfo = {
      types: new Map(),
      values: new Map(),
      imports: new Map(),
      reexports: new Map(),
      stars: [],
      constants: new Map(),
    };
    walk(unit.program, (node) => collectModuleNode(node, info));
    let changed = true;
    while (changed) {
      changed = false;
      walk(unit.program, (node) => {
        if (node.type !== "VariableDeclarator") return;
        const name = nameOf(isNode(node.id) ? node.id : undefined);
        const init = isNode(node.init) ? node.init : undefined;
        if (!name || !init || info.constants.has(name)) return;
        const value =
          literal(init) ??
          (nameOf(init) ? info.constants.get(nameOf(init) ?? "") : undefined);
        if (value !== undefined) {
          info.constants.set(name, value);
          changed = true;
        }
      });
    }
    return info;
  }

  constant(file: string, node: AstNode | undefined): string | undefined {
    return (
      literal(node) ??
      (nameOf(node)
        ? this.modules.get(file)?.constants.get(nameOf(node) ?? "")
        : undefined)
    );
  }

  private candidate(path: string): string | undefined {
    const candidates = extname(path)
      ? [path]
      : [".ts", ".tsx", ".mts", ".cts"].flatMap((extension) => [
          `${path}${extension}`,
          join(path, `index${extension}`),
        ]);
    return candidates
      .map((candidate) => resolve(candidate))
      .find((candidate) => this.files.has(candidate));
  }

  private module(file: string, source: string): string | undefined {
    const packagePath = PACKAGE_EXPORTS.get(source);
    if (packagePath) return this.candidate(packagePath);
    if (source.startsWith("~/")) {
      return this.candidate(resolve(root, "apps/web/src", source.slice(2)));
    }
    if (source.startsWith("."))
      return this.candidate(resolve(dirname(file), source));
    return undefined;
  }

  private exported(
    file: string,
    name: string,
    kind: "type" | "value",
    seen = new Set<string>(),
  ): { file: string; name: string } | undefined {
    const key = `${kind}:${file}:${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const info = this.modules.get(file);
    const definitions = kind === "type" ? info?.types : info?.values;
    if (definitions?.has(name)) return { file, name };
    const direct = info?.reexports.get(name);
    if (direct) {
      const target = this.module(file, direct.source);
      if (target) return this.exported(target, direct.name, kind, seen);
    }
    for (const star of info?.stars ?? []) {
      const target = this.module(file, star);
      if (!target) continue;
      const resolved = this.exported(target, name, kind, seen);
      if (resolved) return resolved;
    }
    return undefined;
  }

  private symbol(
    file: string,
    parts: readonly string[],
    kind: "type" | "value",
  ): { file: string; name: string } | undefined {
    const info = this.modules.get(file);
    if (parts.length === 1 && parts[0]) {
      const definitions = kind === "type" ? info?.types : info?.values;
      if (definitions?.has(parts[0])) return { file, name: parts[0] };
      const imported = info?.imports.get(parts[0]);
      if (imported && "name" in imported) {
        const target = this.module(file, imported.source);
        if (target) return this.exported(target, imported.name, kind);
      }
    }
    if (parts.length === 2 && parts[0] && parts[1]) {
      const imported = info?.imports.get(parts[0]);
      if (imported && "namespace" in imported) {
        const target = this.module(file, imported.source);
        if (target) return this.exported(target, parts[1], kind);
      }
    }
    return undefined;
  }

  private schemaType(
    node: AstNode | undefined,
    file: string,
    schemaTypes: ReadonlySet<string>,
  ): boolean {
    if (!node) return false;
    if (node.type === "TSTypeQuery") {
      const ref = this.symbol(
        file,
        qualified(isNode(node.exprName) ? node.exprName : undefined),
        "value",
      );
      return ref ? this.value(ref.file, ref.name) : false;
    }
    if (node.type === "TSTypeReference") {
      const name = qualified(
        isNode(node.typeName) ? node.typeName : undefined,
      ).at(-1);
      if (name && schemaTypes.has(name)) return true;
    }
    return children(node).some((child) =>
      this.schemaType(child, file, schemaTypes),
    );
  }

  brandedType(
    node: AstNode | undefined,
    file: string,
    generics: ReadonlySet<string> = new Set(),
    schemaTypes: ReadonlySet<string> = new Set(),
  ): boolean {
    if (!node) return false;
    if (node.type === "TSTypeOperator" && node.operator === "keyof")
      return false;
    if (node.type === "TSTypeReference")
      return this.brandedReference(node, file, generics, schemaTypes);
    if (node.type === "TSInterfaceHeritage") {
      const ref = this.symbol(
        file,
        qualified(isNode(node.expression) ? node.expression : undefined),
        "type",
      );
      if (ref && this.type(ref.file, ref.name)) return true;
    }
    return children(node).some((child) =>
      this.brandedType(child, file, generics, schemaTypes),
    );
  }

  private brandedReference(
    node: AstNode,
    file: string,
    generics: ReadonlySet<string>,
    schemaTypes: ReadonlySet<string>,
  ): boolean {
    const parts = qualified(isNode(node.typeName) ? node.typeName : undefined);
    const tail = parts.at(-1);
    if (
      tail === "$brand" ||
      (tail !== undefined && (generics.has(tail) || schemaTypes.has(tail)))
    )
      return true;
    const args = this.typeArguments(node);
    if ((tail === "infer" || tail === "output") && parts[0] === "z")
      return args.some((arg) => this.schemaType(arg, file, schemaTypes));
    const ref = this.symbol(file, parts, "type");
    if (ref && this.type(ref.file, ref.name)) return true;
    return args.some((arg) =>
      this.brandedType(arg, file, generics, schemaTypes),
    );
  }

  private typeArguments(node: AstNode): AstNode[] {
    return isNode(node.typeArguments) &&
      Array.isArray(node.typeArguments.params)
      ? node.typeArguments.params.filter(isNode)
      : [];
  }

  private type(file: string, name: string): boolean {
    const key = `${file}:${name}`;
    const memo = this.typeMemo.get(key);
    if (memo !== undefined) return memo;
    if (this.resolvingTypes.has(key)) return false;
    this.resolvingTypes.add(key);
    const node = this.modules.get(file)?.types.get(name);
    const result = node ? this.brandedType(node, file) : false;
    this.resolvingTypes.delete(key);
    this.typeMemo.set(key, result);
    return result;
  }

  private expression(node: AstNode | undefined, file: string): boolean {
    if (!node) return false;
    if (node.type === "MemberExpression") {
      const property =
        nameOf(isNode(node.property) ? node.property : undefined) ??
        this.constant(file, isNode(node.property) ? node.property : undefined);
      if (property === "brand") return true;
    }
    if (node.type === "Identifier") {
      const ref = this.symbol(file, [nameOf(node) ?? ""], "value");
      if (ref && this.value(ref.file, ref.name)) return true;
    }
    return children(node).some((child) => this.expression(child, file));
  }

  private value(file: string, name: string): boolean {
    const key = `${file}:${name}`;
    const memo = this.valueMemo.get(key);
    if (memo !== undefined) return memo;
    if (this.resolvingValues.has(key)) return false;
    this.resolvingValues.add(key);
    const node = this.modules.get(file)?.values.get(name);
    const result = node ? this.expression(node, file) : false;
    this.resolvingValues.delete(key);
    this.valueMemo.set(key, result);
    return result;
  }
}

const expressionNames = (
  node: AstNode | undefined,
  constant: (node: AstNode | undefined) => string | undefined,
): string[] => {
  if (!node) return [];
  if (node.type === "MemberExpression") {
    const property =
      nameOf(isNode(node.property) ? node.property : undefined) ??
      constant(isNode(node.property) ? node.property : undefined);
    return [
      ...(property ? [property] : []),
      ...expressionNames(
        isNode(node.object) ? node.object : undefined,
        constant,
      ),
    ];
  }
  const name = nameOf(node);
  return name ? [name] : [];
};

const collectUnsafeAliases = (
  program: AstNode,
  constant: (node: AstNode | undefined) => string | undefined,
): Set<string> => {
  const aliases = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    walk(program, (node) => {
      changed = collectImportedUnsafeAliases(node, aliases) || changed;
      changed =
        collectAssignedUnsafeAliases(node, aliases, constant) || changed;
    });
  }
  return aliases;
};

const collectImportedUnsafeAliases = (
  node: AstNode,
  aliases: Set<string>,
): boolean => {
  if (node.type !== "ImportDeclaration") return false;
  let changed = false;
  for (const item of Array.isArray(node.specifiers) ? node.specifiers : []) {
    if (!isNode(item)) continue;
    const imported = nameOf(isNode(item.imported) ? item.imported : undefined);
    const local = nameOf(isNode(item.local) ? item.local : undefined);
    if (
      !local ||
      (!unsafeName(imported) && !unsafeName(local)) ||
      aliases.has(local)
    )
      continue;
    aliases.add(local);
    changed = true;
  }
  return changed;
};

const collectAssignedUnsafeAliases = (
  node: AstNode,
  aliases: Set<string>,
  constant: (node: AstNode | undefined) => string | undefined,
): boolean => {
  if (node.type !== "VariableDeclarator") return false;
  const id = isNode(node.id) ? node.id : undefined;
  const init = isNode(node.init) ? node.init : undefined;
  const local = nameOf(id);
  if (
    local &&
    expressionNames(init, constant).some(
      (name) => unsafeName(name) || aliases.has(name),
    ) &&
    !aliases.has(local)
  ) {
    aliases.add(local);
    return true;
  }
  return collectDestructuredUnsafeAliases(id, aliases, constant);
};

const collectDestructuredUnsafeAliases = (
  id: AstNode | undefined,
  aliases: Set<string>,
  constant: (node: AstNode | undefined) => string | undefined,
): boolean => {
  if (id?.type !== "ObjectPattern") return false;
  let changed = false;
  for (const property of Array.isArray(id.properties) ? id.properties : []) {
    if (!isNode(property) || property.type !== "Property") continue;
    const key =
      nameOf(isNode(property.key) ? property.key : undefined) ??
      constant(isNode(property.key) ? property.key : undefined);
    const target = nameOf(isNode(property.value) ? property.value : undefined);
    if (target && unsafeName(key) && !aliases.has(target)) {
      aliases.add(target);
      changed = true;
    }
  }
  return changed;
};

type AddViolation = (
  kind: IdentifierViolationKind,
  node: AstNode,
  message: string,
) => void;

const scanTestingModuleBoundary = (
  node: AstNode,
  file: string,
  constant: (node: AstNode | undefined) => string | undefined,
  add: AddViolation,
): void => {
  const source =
    node.type === "ImportExpression"
      ? constant(isNode(node.source) ? node.source : undefined)
      : literal(node.source);
  if (isTestPath(file) || source !== TESTING_MODULE) return;
  if (node.type === "ImportDeclaration")
    add(
      "unsafe-helper-import",
      node,
      `imports test-only identifier helpers from ${TESTING_MODULE}`,
    );
  if (
    node.type === "ExportNamedDeclaration" ||
    node.type === "ExportAllDeclaration"
  )
    add(
      "unsafe-helper-import",
      node,
      `re-exports test-only identifier helpers from ${TESTING_MODULE}`,
    );
  if (node.type === "ImportExpression")
    add(
      "unsafe-helper-import",
      node,
      `dynamically imports test-only identifier helpers from ${TESTING_MODULE}`,
    );
};

const scanUnsafeImports = (node: AstNode, add: AddViolation): void => {
  if (
    node.type !== "ImportDeclaration" &&
    node.type !== "ExportNamedDeclaration"
  )
    return;
  for (const item of Array.isArray(node.specifiers) ? node.specifiers : []) {
    if (!isNode(item)) continue;
    const imported = nameOf(
      isNode(item.imported)
        ? item.imported
        : isNode(item.local)
          ? item.local
          : undefined,
    );
    const local = nameOf(
      isNode(item.local)
        ? item.local
        : isNode(item.exported)
          ? item.exported
          : undefined,
    );
    const forbidden = unsafeName(imported)
      ? imported
      : unsafeName(local)
        ? local
        : undefined;
    if (forbidden)
      add(
        "unsafe-helper-import",
        item,
        `imports or re-exports forbidden unsafe identifier helper ${forbidden}`,
      );
  }
};

const scanUnsafeDeclaration = (
  node: AstNode,
  constant: (node: AstNode | undefined) => string | undefined,
  add: AddViolation,
): void => {
  const direct = [
    "FunctionDeclaration",
    "ClassDeclaration",
    "VariableDeclarator",
  ].includes(node.type);
  const keyLike = [
    "Property",
    "MethodDefinition",
    "PropertyDefinition",
  ].includes(node.type);
  if (!direct && !keyLike) return;
  const name = direct
    ? nameOf(isNode(node.id) ? node.id : undefined)
    : (nameOf(isNode(node.key) ? node.key : undefined) ??
      constant(isNode(node.key) ? node.key : undefined));
  if (unsafeName(name))
    add(
      "unsafe-helper-declaration",
      node,
      `declares forbidden unsafe identifier helper ${name}`,
    );
};

const scanUnsafeCall = (
  node: AstNode,
  file: string,
  aliases: ReadonlySet<string>,
  constant: (node: AstNode | undefined) => string | undefined,
  add: AddViolation,
): void => {
  if (node.type !== "CallExpression" && node.type !== "NewExpression") return;
  const called = expressionNames(
    isNode(node.callee) ? node.callee : undefined,
    constant,
  );
  const args = Array.isArray(node.arguments) ? node.arguments : [];
  if (
    called.length === 1 &&
    called[0] === "require" &&
    constant(isNode(args[0]) ? args[0] : undefined) === TESTING_MODULE &&
    !isTestPath(file)
  )
    add(
      "unsafe-helper-import",
      node,
      `requires test-only identifier helpers from ${TESTING_MODULE}`,
    );
  const forbidden = called.find(
    (name) => unsafeName(name) || aliases.has(name),
  );
  if (forbidden)
    add(
      "unsafe-helper-call",
      node,
      `calls forbidden unsafe identifier helper ${forbidden}`,
    );
};

const scanBrandedAssertion = (
  node: AstNode,
  file: string,
  scopes: readonly {
    start: number;
    end: number;
    brands: Set<string>;
    schemas: Set<string>;
  }[],
  provenance: Provenance,
  add: AddViolation,
): void => {
  if (node.type !== "TSAsExpression" && node.type !== "TSTypeAssertion") return;
  const { start, end } = rangeOf(node);
  const scope = scopes.find((item) => start >= item.start && end <= item.end);
  if (
    provenance.brandedType(
      isNode(node.typeAnnotation) ? node.typeAnnotation : undefined,
      file,
      scope?.brands,
      scope?.schemas,
    )
  )
    add(
      "branded-assertion",
      node,
      "asserts a value as a branded identifier type",
    );
};

const scanUnit = (
  unit: Unit,
  provenance: Provenance,
): IdentifierViolation[] => {
  const { file, source, program } = unit;
  const violations: IdentifierViolation[] = [];
  const constant = (node: AstNode | undefined) =>
    provenance.constant(file, node);
  const aliases = collectUnsafeAliases(program, constant);

  const scopes: Array<{
    start: number;
    end: number;
    brands: Set<string>;
    schemas: Set<string>;
  }> = [];
  walk(program, (node) => {
    if (
      ![
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(node.type)
    )
      return;
    const brands = new Set<string>();
    const schemas = new Set<string>();
    const typeParameters =
      isNode(node.typeParameters) && Array.isArray(node.typeParameters.params)
        ? node.typeParameters.params
        : [];
    for (const parameter of typeParameters) {
      if (!isNode(parameter)) continue;
      const name = nameOf(isNode(parameter.name) ? parameter.name : undefined);
      if (
        name &&
        provenance.brandedType(
          isNode(parameter.constraint) ? parameter.constraint : undefined,
          file,
        )
      )
        brands.add(name);
    }
    for (const parameter of Array.isArray(node.params) ? node.params : []) {
      if (!isNode(parameter)) continue;
      walk(parameter, (part) => {
        if (part.type !== "TSTypeReference") return;
        const schema = qualified(
          isNode(part.typeName) ? part.typeName : undefined,
        ).at(-1);
        if (schema !== "ZodType" && schema !== "ZodSchema") return;
        const args =
          isNode(part.typeArguments) && Array.isArray(part.typeArguments.params)
            ? part.typeArguments.params
            : [];
        const output = isNode(args[0]) ? args[0] : undefined;
        const outputName = qualified(
          isNode(output?.typeName) ? output.typeName : output,
        ).at(-1);
        if (outputName) schemas.add(outputName);
      });
    }
    if (brands.size || schemas.size)
      scopes.push({ ...rangeOf(node), brands, schemas });
  });

  const seen = new Set<string>();
  const add = (
    kind: IdentifierViolationKind,
    node: AstNode,
    message: string,
  ) => {
    const { start, end } = rangeOf(node);
    const key = `${kind}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({
      file,
      kind,
      message,
      start,
      end,
      ...positionAt(source, start),
    });
  };
  walk(program, (node) => {
    scanTestingModuleBoundary(node, file, constant, add);
    scanUnsafeImports(node, add);
    scanUnsafeDeclaration(node, constant, add);
    scanUnsafeCall(node, file, aliases, constant, add);
    scanBrandedAssertion(node, file, scopes, provenance, add);
  });
  return violations.sort(
    (a, b) => a.start - b.start || a.kind.localeCompare(b.kind),
  );
};

/** Scan in-memory TypeScript sources with cross-file symbol provenance. */
export const scanSources = (
  sources: readonly Readonly<{ file: string; source: string }>[],
) => {
  const units = sources.map(({ file, source }) => parseUnit(file, source));
  const provenance = new Provenance(units);
  return units.flatMap((unit) => scanUnit(unit, provenance));
};
export const scanSource = (file: string, source: string) =>
  scanSources([{ file, source }]);

type ScanOptions = Readonly<{ includeTests?: boolean }>;
const isTestPath = (path: string): boolean =>
  /(?:^|[\\/])(?:tests?|__fixtures__|test-support|tooling)(?:[\\/]|$)/u.test(
    path,
  ) || /\.(?:test|spec|fixtures)\.[cm]?[jt]sx?$/u.test(path);
const sourceFilesUnder = (path: string, options: ScanOptions): string[] => {
  const stat = statSync(path);
  if (stat.isFile()) {
    return SOURCE_EXTENSIONS.has(extname(path)) &&
      !path.endsWith(".d.ts") &&
      (options.includeTests === true || !isTestPath(path))
      ? [path]
      : [];
  }
  if (!stat.isDirectory() || IGNORED_DIRECTORIES.has(basename(path))) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)
      ? []
      : sourceFilesUnder(child, options);
  });
};
const scanPaths = (paths: readonly string[], options: ScanOptions = {}) => {
  const files = paths
    .flatMap((path) => sourceFilesUnder(resolve(path), options))
    .sort();
  return scanSources(
    files.map((file) => ({ file, source: readFileSync(file, "utf8") })),
  );
};

const main = (): void => {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: node scripts/check-unsafe-identifiers.ts [file-or-directory ...]",
    );
    return;
  }
  const paths = args.filter((arg) => !arg.startsWith("--"));
  const violations = scanPaths(paths.length ? paths : [root], {
    includeTests: args.includes("--include-tests"),
  });
  for (const violation of violations) {
    console.error(
      `${relative(root, violation.file) || violation.file}:${violation.line}:${violation.column} ${violation.message}`,
    );
  }
  if (violations.length) {
    console.error(`Found ${violations.length} unsafe identifier violation(s).`);
    process.exitCode = 1;
  }
};
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
