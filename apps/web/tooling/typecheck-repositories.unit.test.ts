import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

import { createRepositoryPrograms } from "./typecheck-repositories";

it("publishes a complete checked incremental boundary and recovers lost output", () => {
  const root = mkdtempSync(join(tmpdir(), "cubby-storage-types-"));
  const app = join(root, "apps/web");
  const installed = resolve(import.meta.dirname, "../node_modules");
  const compiler = join(installed, "typescript/bin/tsc");
  const write = (file: string, content: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const compile = (args: string[]) => {
    const result = spawnSync(process.execPath, [compiler, ...args], {
      cwd: app,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  };
  const source = join(app, "src/server/storage.ts");
  const declaration = "apps/web/src/server/storage.d.ts";
  const snapshot = (program: ReturnType<typeof createRepositoryPrograms>) => ({
    content: readFileSync(join(program.output, declaration), "utf8"),
    modified: statSync(join(program.output, declaration), { bigint: true })
      .mtimeNs,
  });
  try {
    mkdirSync(app, { recursive: true });
    symlinkSync(installed, join(app, "node_modules"), "dir");
    write(
      join(app, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          incremental: true,
          noEmit: true,
        },
      }),
    );
    write(
      join(app, "tsconfig.server.json"),
      JSON.stringify({
        extends: "./tsconfig.json",
        include: ["src/server/**/*.ts"],
        exclude: [],
      }),
    );
    write(source, "export function value(): number { return 1; }\n");
    write(join(app, "src/server/retired.ts"), "export const retired = 1;\n");
    write(
      join(app, "src/server/consumer.ts"),
      'import { value } from "~/server/storage"; export const result: number = value();\n',
    );
    let program = createRepositoryPrograms(app, [
      "src/server/storage.ts",
      "src/server/retired.ts",
    ]);
    program.configure();
    program.build(compiler, compile, []);
    compile(["--build", program.serverConfig, "--checkers", "1"]);
    const original = snapshot(program);
    const consumerTime = statSync(join(program.state, "server.tsbuildinfo"), {
      bigint: true,
    }).mtimeNs;
    program.build(compiler, compile, []);
    expect(snapshot(program)).toEqual(original);

    write(source, "export function value(): number { return 2; }\n");
    program.build(compiler, compile, []);
    expect(snapshot(program)).toEqual(original);
    compile(["--build", program.serverConfig, "--checkers", "1"]);
    expect(
      statSync(join(program.state, "server.tsbuildinfo"), { bigint: true })
        .mtimeNs,
    ).toBe(consumerTime);

    rmSync(join(program.cache, declaration));
    program.build(compiler, compile, []);
    expect(snapshot(program)).toEqual(original);

    rmSync(join(program.state, "outputs.json"));
    program.build(compiler, compile, []);
    expect(snapshot(program)).toEqual(original);

    write(join(app, "src/server/added.ts"), "export const added = 1;\n");
    program = createRepositoryPrograms(app, [
      "src/server/storage.ts",
      "src/server/retired.ts",
      "src/server/added.ts",
    ]);
    program.configure();
    expect(() =>
      program.build(
        compiler,
        (args) => {
          compile(args);
          throw new Error("Simulated interruption after successful emit");
        },
        [],
      ),
    ).toThrow(/Simulated interruption/u);
    program.build(compiler, compile, []);
    expect(
      readFileSync(
        join(program.output, "apps/web/src/server/added.d.ts"),
        "utf8",
      ),
    ).toContain("added");

    write(source, 'export function value(): number { return "invalid"; }\n');
    expect(() => program.build(compiler, compile, [])).toThrow(/TS2322/u);
    expect(snapshot(program)).toEqual(original);
    write(source, 'export function value(): string { return "changed"; }\n');
    program.build(compiler, compile, []);
    expect(() =>
      compile(["--build", program.serverConfig, "--checkers", "1"]),
    ).toThrow(/TS2322/u);

    write(source, "export function value(): number { return 2; }\n");
    program = createRepositoryPrograms(app, ["src/server/storage.ts"]);
    program.configure();
    program.build(compiler, compile, []);
    expect(() =>
      readFileSync(join(program.output, "apps/web/src/server/retired.d.ts")),
    ).toThrow(/ENOENT/u);
    compile(["--build", program.serverConfig, "--checkers", "1"]);
    rmSync(program.output, { recursive: true });
    program.build(compiler, compile, []);
    expect(snapshot(program).content).toBe(original.content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
