import type { ChildProcess } from "node:child_process";
import type { FullConfig } from "@playwright/test";

async function globalTeardown(_config: FullConfig): Promise<void> {
  console.log("[E2E Teardown] Cleaning up...");

  const serverProcess = (globalThis as Record<string, unknown>)
    .__E2E_SERVER__ as ChildProcess | undefined;

  if (serverProcess) {
    console.log("[E2E Teardown] Stopping dev server...");
    serverProcess.kill("SIGTERM");

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log("[E2E Teardown] Force killing server...");
        serverProcess.kill("SIGKILL");
        resolve();
      }, 5000);

      serverProcess.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    console.log("[E2E Teardown] Server stopped");
  }

  console.log("[E2E Teardown] Done");
}

export default globalTeardown;
