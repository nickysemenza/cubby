import concurrently, { type ConcurrentlyCommandInput } from "concurrently";

type Lane = "rust" | "web";

export function pilotCommands(lane: Lane) {
  const tasks: [name: string, command: string][] =
    lane === "rust"
      ? [
          [
            "rust-fmt",
            "cargo fmt --manifest-path recipebridge/Cargo.toml --check",
          ],
          ["rust-test", "cargo test --manifest-path recipebridge/Cargo.toml"],
          [
            "rust-clippy",
            "cargo clippy --manifest-path recipebridge/Cargo.toml --profile test --all-targets -- -D warnings",
          ],
        ]
      : [
          ["dedupe", "pnpm dedupe:check"],
          ["checks", "pnpm check:all"],
          [
            "workspace-tests",
            "pnpm -r --workspace-concurrency=1 test --maxWorkers=2",
          ],
          [
            "postgres-tests",
            "pnpm --filter @cubby/web test:postgres --maxWorkers=2",
          ],
          ["usda-build", "pnpm --filter @cubby/usda-api build"],
          ["upc-build", "pnpm --filter @cubby/upc-lookup build"],
          ["web-build", "pnpm --filter @cubby/web build:cf"],
          ["browser-tests", "pnpm test:e2e"],
        ];
  return tasks.map(([name, command]) => ({
    name,
    command: `time -v ${command}`,
  }));
}

export async function runPilotCommands(
  commands: ConcurrentlyCommandInput[],
  maxProcesses: 1 | 2,
) {
  try {
    await concurrently(commands, {
      maxProcesses,
      killOthersOn: ["failure"],
      killTimeout: 3_000,
      successCondition: "all",
      prefix: "name",
      timings: true,
    }).result;
  } catch {
    // Concurrently rejection objects include environments. Diagnostics are already logged.
    throw new Error("Pilot task group failed; see named task output");
  }
}

if (import.meta.main) {
  try {
    if (
      process.env.WORKERS_CI !== "1" ||
      process.env.WORKERS_CI_BRANCH !== "codex/cloudflare-ci-pilot"
    ) {
      throw new Error("Run verification through cloudflare-ci-pilot.ts");
    }
    const lane = process.argv[2];
    if (lane === "all") {
      // Each lane owns its sequencing. Heavy JS stages never overlap one another;
      // Cargo commands share one target directory and also stay serial.
      await runPilotCommands(
        [
          { name: "rust", command: "node scripts/cloudflare-ci-tasks.ts rust" },
          { name: "web", command: "node scripts/cloudflare-ci-tasks.ts web" },
        ],
        2,
      );
    } else if (lane === "rust" || lane === "web") {
      await runPilotCommands(pilotCommands(lane), 1);
    } else {
      throw new Error("Expected all, rust, or web lane");
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Pilot verification failed",
    );
    process.exitCode = 1;
  }
}
