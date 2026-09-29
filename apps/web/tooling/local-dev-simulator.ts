import { spawn } from "node:child_process";
import path from "node:path";
import { localSimulatorServer } from "../../../scripts/lib/simulator-server.ts";

export async function launchLocalDevSimulator(
  origin: string,
  args: readonly string[] = [],
): Promise<void> {
  const server = localSimulatorServer(origin);
  if (args.includes("--server"))
    throw new Error(
      "The development session selects the simulator server; omit --server.",
    );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "apple",
        "sim",
        "--server",
        server,
        ...args.filter((arg) => arg !== "--"),
      ],
      { cwd: path.resolve(import.meta.dirname, "../../.."), stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`Local simulator launch failed (${signal ?? code}).`),
          ),
    );
  });
}
