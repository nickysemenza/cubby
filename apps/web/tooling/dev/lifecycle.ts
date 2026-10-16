import type { Plugin } from "vite";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * Ends a supervised `vite dev` runtime that nobody is using. Activity is an
 * HTTP request or a watched file change; an open HMR socket alone is not, since
 * forgotten preview panes and test browsers hold one indefinitely. Idle asks
 * the supervisor to stop so the session manifest records it. A runtime whose
 * supervisor was SIGKILLed has no one left to stop it, so it closes itself.
 */
export function devLifecycle(): Plugin {
  return {
    name: "cubby-dev-lifecycle",
    apply: "serve",
    configureServer(server) {
      const supervisorPid = Number(process.env.CUBBY_DEV_SUPERVISOR_PID);
      if (!supervisorPid) return;
      const idleMinutes = Number(process.env.CUBBY_DEV_IDLE_MINUTES || 30);
      let lastActivity = Date.now();
      const touch = () => {
        lastActivity = Date.now();
      };
      server.middlewares.use((_req, _res, next) => {
        touch();
        next();
      });
      server.watcher.on("all", touch);
      const timer = setInterval(() => {
        if (!processAlive(supervisorPid)) {
          clearInterval(timer);
          server.config.logger.warn(
            "[dev] Supervisor exited; closing the orphaned runtime",
          );
          // Closing disposes Miniflare, which stops its workerd children.
          const exit = () => process.exit(0);
          setTimeout(exit, 10_000).unref();
          void server.close().finally(exit);
        } else if (
          idleMinutes > 0 &&
          Date.now() - lastActivity > idleMinutes * 60_000
        ) {
          clearInterval(timer);
          server.config.logger.warn(
            `[dev] No requests or file changes for ${idleMinutes} min; stopping. pnpm dev starts it again.`,
          );
          process.kill(supervisorPid, "SIGTERM");
        }
      }, 15_000);
      timer.unref();
      server.httpServer?.once("close", () => clearInterval(timer));
    },
  };
}
