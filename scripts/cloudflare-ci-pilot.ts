import {
  access,
  copyFile,
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { availableParallelism, cpus, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  browserPackages,
  commandRunner,
  createPackageStore,
  download,
  postgresPackages,
  relocatedEnvironment,
} from "./cloudflare-ci-runtime.ts";

async function main() {
  const mode = process.argv[2];
  if (mode !== "probe" && mode !== "full")
    throw Error("usage: node scripts/cloudflare-ci-pilot.ts probe|full");
  if (process.env.WORKERS_CI_BRANCH !== "codex/cloudflare-ci-pilot")
    throw Error("unexpected build branch");
  if (process.env.WORKERS_CI !== "1")
    throw Error("Workers Builds environment required");
  if (process.platform !== "linux" || process.arch !== "x64")
    throw Error("Linux x86_64 required");
  if (process.env.SKIP_DEPENDENCY_INSTALL !== "1")
    throw Error("automatic dependency installation must be disabled");
  if (process.versions.node.split(".")[0] !== "24")
    throw Error("Node 24 required");
  await access("recipebridge/Cargo.toml");
  if (process.env.CUBBY_PILOT_FAIL === "1")
    throw Error("intentional failure: deploy sentinel must not run");
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(Error("18-minute pilot deadline exceeded")),
    18 * 60_000,
  );
  const interrupt = () => controller.abort(Error("Pilot interrupted"));
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  const signal = controller.signal;
  const root = await mkdtemp(join(tmpdir(), "cubby-ci-pilot-"));
  // Only these values reach subprocesses; production credentials and DB overrides do not.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: "C.UTF-8",
    CI: "1",
    WORKERS_CI: "1",
    WORKERS_CI_BRANCH: "codex/cloudflare-ci-pilot",
    CHECK_MAX_PROCESSES: "2",
    NODE_OPTIONS: "--max-old-space-size=4096",
    CARGO_TARGET_DIR: join(root, "cargo-target"),
    CARGO_BUILD_JOBS: "4",
    GOMAXPROCS: "4",
    GOMEMLIMIT: "6GiB",
    DATABASE_URL: "postgresql://postgres:password@localhost:5432/cubby",
    INTEGRESQL_URL: "http://localhost:5000",
    INTEGRESQL_DATABASE_HOST: "localhost",
    E2E_TEST_USER_EMAIL: "ci-pilot@example.test",
    E2E_TEST_USER_PASSWORD: "cubby-pilot-test-password",
  };
  let run = commandRunner(env, signal);
  const cleanups: (() => Promise<string | void>)[] = [];
  const started = performance.now();
  let currentStage = "setup";
  const stage = async (name: string, action: () => Promise<string | void>) => {
    currentStage = name;
    const start = performance.now();
    console.log(`pilot stage=${name} event=start`);
    try {
      await action();
    } catch (error) {
      console.log(
        `pilot stage=${name} result=1 elapsed_seconds=${((performance.now() - start) / 1000).toFixed(2)}`,
      );
      throw error;
    }
    console.log(
      `pilot stage=${name} result=0 elapsed_seconds=${((performance.now() - start) / 1000).toFixed(2)}`,
    );
  };
  try {
    if ((await run("pnpm", ["--version"], { quiet: true })) !== "10.34.1")
      throw Error("pnpm 10.34.1 required");
    console.log(
      `pilot available_cpus=${availableParallelism()} cpu_model=${cpus()[0]?.model} total_memory_bytes=${totalmem()}`,
    );
    await run("uname", ["-srmo"]);
    await run("id", []);
    console.log(
      (await readFile("/proc/meminfo", "utf8"))
        .split("\n")
        .filter((line) =>
          /^(MemTotal|MemAvailable|SwapTotal|SwapFree):/u.test(line),
        )
        .join("\n"),
    );
    await run("df", ["-Pk", ".", "/tmp"]);
    await run("git", ["rev-parse", "HEAD"]);
    for (const port of [5432, 5000]) {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    let store: Awaited<ReturnType<typeof createPackageStore>> | undefined;
    const packages = async (names: string[]) => {
      store ??= await createPackageStore(root, run, signal);
      await store.install(names);
      Object.assign(env, relocatedEnvironment(store.prefix, env));
      run = commandRunner(env, signal);
      return store.prefix;
    };
    await stage("database", async () => {
      const docker = await run("docker", ["info"], { quiet: true }).then(
        () => true,
        () => false,
      );
      if (docker) {
        const compose = [
          "compose",
          "-p",
          `cubby-ci-pilot-${process.pid}`,
          "-f",
          "scripts/cloudflare-ci-compose.yml",
        ];
        await run("docker", ["compose", "version"]);
        cleanups.push(() =>
          commandRunner(env, AbortSignal.timeout(15_000))("docker", [
            ...compose,
            "down",
            "--volumes",
            "--remove-orphans",
          ]),
        );
        await run("docker", [...compose, "up", "-d"]);
      } else {
        console.log("pilot database=native docker_runtime=unavailable");
        if (process.getuid?.() === 0)
          throw Error("native initdb requires an unprivileged build user");
        const prefix = await packages(postgresPackages);
        await writeFile(join(root, "password"), "password", { mode: 0o600 });
        await run("initdb", [
          "-D",
          join(root, "data"),
          "-U",
          "postgres",
          "--pwfile",
          join(root, "password"),
          "--auth-host=scram-sha-256",
          "--encoding=UTF8",
          "-L",
          join(prefix, "usr/share/postgresql/17"),
        ]);
        cleanups.push(() =>
          commandRunner(env, AbortSignal.timeout(10_000))(
            "pg_ctl",
            ["-D", join(root, "data"), "-m", "immediate", "stop"],
            { quiet: true },
          ),
        );
        await run("pg_ctl", [
          "-D",
          join(root, "data"),
          "-l",
          join(root, "postgres.log"),
          "-o",
          `-h 127.0.0.1 -k ${root} -p 5432 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c shared_buffers=512MB -c max_connections=200`,
          "-w",
          "start",
        ]);
        await run("createdb", ["-h", "127.0.0.1", "-U", "postgres", "cubby"], {
          env: { PGPASSWORD: "password" },
        });
        await download(
          "https://go.dev/dl/go1.23.6.linux-amd64.tar.gz",
          join(root, "go.tar.gz"),
          signal,
        );
        await run("tar", ["-xzf", join(root, "go.tar.gz"), "-C", root]);
        env.PATH = `${root}/go/bin:${env.PATH}`;
        env.GOBIN = join(root, "bin");
        run = commandRunner(env, signal);
        await run("go", [
          "install",
          "github.com/allaboutapps/integresql/cmd/server@v1.1.0",
        ]);
        const service = spawn(join(root, "bin/server"), [], {
          env: {
            ...env,
            PGHOST: "127.0.0.1",
            PGUSER: "postgres",
            PGPASSWORD: "password",
          },
          stdio: "ignore",
        });
        let serviceError: Error | undefined;
        service.once("error", (error) => {
          serviceError = error;
        });
        cleanups.push(async () => {
          service.kill("SIGTERM");
        });
        for (let attempt = 0; attempt < 60; attempt++) {
          if (serviceError) throw serviceError;
          if (service.exitCode !== null)
            throw Error("IntegreSQL exited during startup");
          if (
            await fetch("http://localhost:5000/", { signal }).then(
              () => true,
              () => false,
            )
          )
            break;
          await delay(1000, undefined, { signal });
        }
      }
      await fetch("http://localhost:5000/", { signal });
    });
    await stage("toolchain", async () => {
      env.PATH = `${env.HOME}/.cargo/bin:${env.PATH}`;
      run = commandRunner(env, signal);
      if (
        !(await run("rustup", ["--version"], { quiet: true }).then(
          () => true,
          () => false,
        ))
      ) {
        await download("https://sh.rustup.rs", join(root, "rustup.sh"), signal);
        await run("sh", [
          join(root, "rustup.sh"),
          "-y",
          "--profile",
          "minimal",
          "--default-toolchain",
          "none",
        ]);
      }
      await run("rustup", [
        "toolchain",
        "install",
        "stable",
        "--profile",
        "minimal",
      ]);
      await run("rustup", ["component", "add", "rustfmt", "clippy"]);
      await run("rustup", ["target", "add", "wasm32-unknown-unknown"]);
      await download(
        "https://github.com/rustwasm/wasm-pack/releases/download/v0.13.1/wasm-pack-v0.13.1-x86_64-unknown-linux-musl.tar.gz",
        join(root, "wasm.tar.gz"),
        signal,
      );
      await run("tar", ["-xzf", join(root, "wasm.tar.gz"), "-C", root]);
      env.PATH = `${root}/wasm-pack-v0.13.1-x86_64-unknown-linux-musl:${env.PATH}`;
      run = commandRunner(env, signal);
      await run("rustc", ["--version"]);
      await run("wasm-pack", ["--version"]);
    });
    await stage("wasm", () =>
      run("pnpm", ["wasm"], {
        env: { RUSTFLAGS: '--cfg getrandom_backend="wasm_js"' },
      }),
    );
    await stage("install", () =>
      run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"]),
    );
    await copyFile("apps/web/.env.example", "apps/web/.env");
    await appendFile("apps/web/.env", "\nNEXTAUTH_SECRET=supersecret\n");
    const smoke = (mode: string) =>
      run("pnpm", [
        "--filter",
        "@cubby/web",
        "exec",
        "node",
        "scripts/cloudflare-ci-smoke.ts",
        mode,
      ]);
    await stage("database-contract", () => smoke("database"));
    await stage("browsers", async () => {
      const version = await run(
        "pnpm",
        ["--filter", "@cubby/web", "exec", "playwright", "--version"],
        { quiet: true },
      );
      if (version !== "Version 1.62.1")
        throw Error("Update pinned browser dependencies for " + version);
      await packages(browserPackages);
      await run("pnpm", [
        "--filter",
        "@cubby/web",
        "exec",
        "playwright",
        "install",
        "chromium",
        "webkit",
      ]);
    });
    await stage("browser-launch", async () => {
      await smoke("prepare-browser");
      await smoke("browser");
    });
    if (mode === "full") {
      const stages: [string, string, string[]][] = [
        ["dedupe", "pnpm", ["dedupe:check"]],
        ["checks", "pnpm", ["check:all"]],
        [
          "rust-fmt",
          "cargo",
          ["fmt", "--manifest-path", "recipebridge/Cargo.toml", "--check"],
        ],
        [
          "rust-test",
          "cargo",
          ["test", "--manifest-path", "recipebridge/Cargo.toml"],
        ],
        // Reuse test-profile dependency artifacts without dropping any lint targets.
        [
          "rust-clippy",
          "cargo",
          [
            "clippy",
            "--manifest-path",
            "recipebridge/Cargo.toml",
            "--profile",
            "test",
            "--all-targets",
            "--",
            "-D",
            "warnings",
          ],
        ],
        ["workspace-tests", "pnpm", ["test", "--maxWorkers=2"]],
        ["postgres-tests", "pnpm", ["test:postgres"]],
        ["usda-build", "pnpm", ["--filter", "@cubby/usda-api", "build"]],
        ["upc-build", "pnpm", ["--filter", "@cubby/upc-lookup", "build"]],
        ["web-build", "pnpm", ["--filter", "@cubby/web", "build:cf"]],
        ["browser-tests", "pnpm", ["test:e2e"]],
      ];
      for (const [name, command, args] of stages)
        await stage(name, () => run("time", ["-v", command, ...args]));
    }
    console.log(`pilot mode=${mode} passed`);
  } finally {
    clearTimeout(deadline);
    for (const cleanup of cleanups.reverse())
      await cleanup().catch((error) =>
        console.error("pilot cleanup failed", error),
      );
    const finalRun = commandRunner(env, AbortSignal.timeout(10_000));
    await finalRun("df", ["-Pk", ".", "/tmp"]).catch(() => undefined);
    const peak = await readFile("/sys/fs/cgroup/memory.peak", "utf8").catch(
      () => "unavailable",
    );
    console.log(
      `pilot memory_peak_bytes=${peak.trim()} final_stage=${currentStage} total_seconds=${((performance.now() - started) / 1000).toFixed(2)}`,
    );
    await rm(root, { recursive: true, force: true });
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
