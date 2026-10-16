import {
  copyFileSync,
  existsSync,
  globSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";

export const storageOwners = [
  "src/server/generic/entity-links/repo/entity-external-ids.ts",
  "src/server/domains/product/repo/gtin.ts",
  "src/server/domains/product/repo/find-by-external-ids.ts",
  "src/server/domains/product/repo/external-id-collisions.ts",
  "src/server/domains/product/repo/external-id-types.ts",
  "src/server/db/generated/identity-storage-tables.gen.ts",
  "src/server/db/external-identifier-tables.ts",
  "src/server/db/schema-primitives.ts",
  "src/server/db/entity-identity-schema.ts",
  "src/server/db/helpers/predicates.ts",
] as const;

export function createStoragePrograms(
  appRoot: string,
  owners: readonly string[],
) {
  const app = resolve(appRoot);
  const repository = resolve(app, "../..");
  const storageState = join(app, "artifacts/storage-typecheck");
  const storageCache = join(storageState, "emit");
  const storageOutput = join(app, "artifacts/storage-contracts");
  const storageConfig = join(storageState, "tsconfig.storage.json");
  const storageServerConfig = join(storageState, "tsconfig.server.json");
  const storageBuildInfo = join(storageState, "storage.tsbuildinfo");

  function writeConfig(file: string, value: unknown) {
    const content = JSON.stringify(value, null, 2) + "\n";
    if (existsSync(file) && readFileSync(file, "utf8") === content) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  /** One ownership roster drives roots, consumer exclusions and exact contract paths. */
  function configureStoragePrograms(): void {
    const paths = {
      "~/*": [join(app, "src/*")],
      "tooling/*": [join(app, "tooling/*")],
    };
    writeConfig(storageConfig, {
      extends: join(app, "tsconfig.json"),
      include: [],
      exclude: [],
      files: [...owners, ...globSync("src/**/*.d.ts", { cwd: app })].map(
        (file) => join(app, file),
      ),
      compilerOptions: {
        types: ["vite/client"],
        rootDir: repository,
        outDir: storageCache,
        tsBuildInfoFile: storageBuildInfo,
        incremental: true,
        noEmit: false,
        noCheck: false,
        isolatedDeclarations: false,
        declaration: true,
        emitDeclarationOnly: true,
        noEmitOnError: true,
        paths: {
          ...paths,
          "~/server/db/repository-access.boundary": [
            join(
              app,
              "artifacts/server-contracts/server/db/repository-access.boundary.d.ts",
            ),
          ],
        },
      },
    });
    const server = JSON.parse(
      readFileSync(join(app, "tsconfig.server.json"), "utf8"),
    );
    writeConfig(storageServerConfig, {
      extends: join(app, "tsconfig.server.json"),
      exclude: [...server.exclude, ...owners].map((file: string) =>
        join(app, file),
      ),
      compilerOptions: {
        tsBuildInfoFile: join(storageState, "server.tsbuildinfo"),
        paths: {
          ...paths,
          ...Object.fromEntries(
            owners.map((file) => [
              `~/${file.slice(4, -3)}`,
              [join(storageOutput, "apps/web", file.slice(0, -3) + ".d.ts")],
            ]),
          ),
        },
      },
    });
  }

  const inventoryFile = join(storageState, "outputs.json");
  const outputFor = (file: string) =>
    join("apps/web", file.slice(0, -3) + ".d.ts");
  const revision = () =>
    existsSync(storageBuildInfo)
      ? statSync(storageBuildInfo, { bigint: true }).mtimeNs.toString()
      : "";

  /** The checked emitter's cache and build-info survive no-op and partial emits. */
  function buildStorage(
    compiler: string,
    compile: (args: string[]) => void,
    args: string[],
  ): void {
    let inventory: { revision: string; files: string[] } | undefined =
      existsSync(inventoryFile)
        ? JSON.parse(readFileSync(inventoryFile, "utf8"))
        : undefined;
    const expected = [...owners.map(outputFor), ...(inventory?.files ?? [])];
    if (
      !inventory?.revision ||
      expected.some((file) => !existsSync(join(storageCache, file)))
    )
      rmSync(storageBuildInfo, { force: true });
    compile(["--build", storageConfig, "--checkers", "1", ...args]);
    // A stopped process may have committed compiler state before this inventory.
    if (inventory?.revision !== revision()) {
      const graph = new Set(
        execFileSync(
          process.execPath,
          [compiler, "-p", storageConfig, "--listFilesOnly"],
          { cwd: app, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        ).split(/\r?\n/u),
      );
      const files = globSync("**/*.d.ts", { cwd: storageCache })
        .filter((file) => {
          const stem = resolve(repository, file.slice(0, -5));
          return graph.has(stem + ".ts") || graph.has(stem + ".tsx");
        })
        .sort();
      for (const file of owners.map(outputFor))
        if (!files.includes(file))
          throw new Error(`Missing checked storage declaration: ${file}`);
      const current = new Set(files);
      for (const file of globSync("**/*.d.ts", { cwd: storageCache }))
        if (!current.has(file)) rmSync(join(storageCache, file));
      inventory = { revision: revision(), files };
      writeConfig(inventoryFile, inventory);
    }
    if (!inventory)
      throw new Error("Storage declaration inventory was not produced");
    validateStorageDeclarations(inventory.files);
    publishStorage(inventory.files);
  }

  /** Publish a complete checked set; unchanged declarations retain their inodes/mtimes. */
  function publishStorage(files: readonly string[]): void {
    const pending = join(storageState, "publish.pending");
    const backup = join(storageState, "publish.previous");
    if (!existsSync(storageOutput) && existsSync(backup))
      renameSync(backup, storageOutput);
    const previous = globSync("**/*.d.ts", { cwd: storageOutput }).sort();
    const equal = (file: string) =>
      existsSync(join(storageOutput, file)) &&
      readFileSync(join(storageCache, file)).equals(
        readFileSync(join(storageOutput, file)),
      );
    if (
      previous.length === files.length &&
      files.every((file, index) => previous[index] === file && equal(file))
    )
      return;
    rmSync(pending, { recursive: true, force: true });
    mkdirSync(pending, { recursive: true });
    for (const file of files) {
      const target = join(pending, file);
      mkdirSync(dirname(target), { recursive: true });
      if (equal(file)) linkSync(join(storageOutput, file), target);
      else copyFileSync(join(storageCache, file), target);
    }
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(storageOutput)) renameSync(storageOutput, backup);
    try {
      renameSync(pending, storageOutput);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, storageOutput);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
  }

  function validateStorageDeclarations(files: readonly string[]): void {
    const complete = new Set(files.map((file) => resolve(storageCache, file)));
    for (const file of files) {
      const content = readFileSync(join(storageCache, file), "utf8");
      for (const match of content.matchAll(
        /\b(?:from\s+|import\s*\(\s*)["']([^"']+)["']/gu,
      )) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".")) continue;
        const path = resolve(storageCache, dirname(file), specifier).replace(
          /\.(?:[cm]?js|tsx?)$/u,
          "",
        );
        if (
          !complete.has(path + ".d.ts") &&
          !complete.has(join(path, "index.d.ts"))
        )
          throw new Error(
            `Incomplete storage declaration ${file}: ${specifier} (${relative(storageCache, path)})`,
          );
      }
    }
  }

  return {
    configure: configureStoragePrograms,
    build: buildStorage,
    config: storageConfig,
    serverConfig: storageServerConfig,
    output: storageOutput,
    cache: storageCache,
    state: storageState,
  };
}

export const storagePrograms = createStoragePrograms(
  resolve(import.meta.dirname, ".."),
  storageOwners,
);
