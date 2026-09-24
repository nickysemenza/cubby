import type { Plugin } from "vite";

import { assertDevDatabaseUrl } from "./dev-db-guard.ts";
import { DEV_USER_EMAIL, DEV_USER_PASSWORD } from "./dev-db-identity.ts";

const route = "/__dev/login";
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A Vite middleware only; it is never imported by the Worker entrypoint. */
export function viteDevLogin(): Plugin {
  return {
    name: "cubby-vite-dev-login",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (new URL(req.url ?? "/", "http://localhost").pathname !== route) {
          next();
          return;
        }
        void (async () => {
          assertDevDatabaseUrl(process.env.DATABASE_URL);
          const remote = req.socket.remoteAddress;
          const host = req.headers.host;
          if (
            req.method !== "GET" ||
            !remote ||
            !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) ||
            !host
          ) {
            res.writeHead(403).end("Local development only");
            return;
          }
          const origin = new URL(`http://${host}`);
          if (
            !loopback.has(origin.hostname) ||
            Number(origin.port) !== req.socket.localPort
          ) {
            res.writeHead(403).end("Loopback host required");
            return;
          }
          const requested = new URL(req.url ?? route, origin);
          const destination = new URL(
            requested.searchParams.get("next") ?? "/",
            origin,
          );
          if (destination.origin !== origin.origin) {
            res.writeHead(400).end("Same-origin redirect required");
            return;
          }
          const signIn = await fetch(
            new URL("/api/auth/sign-in/email", origin),
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: origin.origin,
              },
              body: JSON.stringify({
                email: DEV_USER_EMAIL,
                password: DEV_USER_PASSWORD,
              }),
            },
          );
          if (!signIn.ok) {
            res
              .writeHead(502)
              .end(
                `Development sign-in failed: ${signIn.status} ${await signIn.text()}`,
              );
            return;
          }
          const cookies = signIn.headers.getSetCookie();
          if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);
          res.writeHead(303, {
            Location:
              destination.pathname + destination.search + destination.hash,
          });
          res.end();
        })().catch(next);
      });
    },
  };
}
