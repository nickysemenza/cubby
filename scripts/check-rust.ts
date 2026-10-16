import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function collectRustChecks(
  browser: boolean,
  run: (args: string[]) => number,
) {
  const commands = [
    ["fmt", "--check"],
    [
      "clippy",
      "--locked",
      "--profile",
      "ci",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
    ...(browser
      ? [
          [
            "clippy",
            "--locked",
            "--profile",
            "ci",
            "--no-default-features",
            "--",
            "-D",
            "warnings",
          ],
        ]
      : []),
    ["test", "--locked", "--profile", "ci"],
  ];
  let failed = false;
  for (const args of commands) failed = run(args) !== 0 || failed;
  return failed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failed = collectRustChecks(
    process.argv.includes("--browser"),
    (args) => {
      console.log(`::group::cargo ${args.join(" ")}`);
      const result = spawnSync("cargo", args, { stdio: "inherit" });
      console.log("::endgroup::");
      if (result.error) console.error(result.error);
      return result.status ?? 1;
    },
  );
  process.exitCode = failed ? 1 : 0;
}
