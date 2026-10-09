import { spawnSync } from "node:child_process";

export function installedApprovalVerifier(
  installed: string,
): (candidate: string) => void {
  const displayed = spawnSync("codesign", ["-d", "-r-", installed], {
    encoding: "utf8",
  });
  const requirement = `${displayed.stdout}\n${displayed.stderr}`
    .split("\n")
    .find((line) => line.startsWith("designated => "))
    ?.slice("designated => ".length);
  if (displayed.error || displayed.status !== 0 || !requirement)
    throw new Error(
      `Cannot read installed app privacy requirement: ${installed}\n${displayed.error?.message ?? displayed.stderr.trim()} (exit ${displayed.status})`,
    );
  return (candidate) => {
    const result = spawnSync(
      "codesign",
      ["--verify", "--strict", `-R=${requirement}`, candidate],
      { encoding: "utf8" },
    );
    if (result.error || result.status !== 0)
      throw new Error(
        `Candidate does not satisfy the installed app privacy requirement: ${candidate}\n${result.error?.message ?? result.stderr.trim()} (exit ${result.status})`,
      );
  };
}
