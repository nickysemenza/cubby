import type { ChildProcess } from "node:child_process";
import type { FullConfig } from "@playwright/test";

async function globalTeardown(_config: FullConfig): Promise<void> {
  console.log("[E2E Teardown] Cleaning up...");

  const serverProcess = (globalThis as Record<string, unknown>)
    .__E2E_SERVER__ as ChildProcess | undefined;

  if (serverProcess) {
    // A server that died mid-run has already emitted `exit`, and Node emits it
    // once — a listener attached now would never fire, so the wait below would
    // burn its whole timeout and then SIGKILL a dead pid, on exactly the
    // failure this teardown exists to report.
    const alreadyExited =
      serverProcess.exitCode !== null || serverProcess.signalCode !== null;

    if (alreadyExited) {
      console.log("[E2E Teardown] Dev server had already exited");
    } else {
      console.log("[E2E Teardown] Stopping dev server...");
      // Claim the exit before signalling: globalSetup's `exit` handler treats
      // any unclaimed exit as the server dying mid-run and prints a crash
      // report.
      (globalThis as Record<string, unknown>).__E2E_STOPPING__ = true;
      serverProcess.kill("SIGTERM");

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
  }

  // The mid-run crash banner is printed the moment it happens, which by the end
  // of a run is far above the failure list. Restate it last, where the reader is.
  const died = (globalThis as Record<string, unknown>).__E2E_SERVER_DIED__;
  if (typeof died === "string") {
    console.error(
      `[E2E Teardown] NOTE: the dev server died mid-run (${died}) — the failures above are ECONNREFUSED against a dead port, not app bugs.`,
    );
  }

  console.log("[E2E Teardown] Done");
}

export default globalTeardown;
