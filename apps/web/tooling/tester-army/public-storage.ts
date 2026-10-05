import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Public DNS for 127.0.0.1. The Worker fetches public object URLs (the image
 * description rendition) through the external-fetch guard, which refuses
 * loopback hosts by name; this name passes it and still reaches local storage.
 */
const PUBLIC_LOOPBACK_HOST = "storage.localtest.me";

/**
 * Serves local object storage at a guard-passing public origin. Miniflare
 * refuses a `/cdn-cgi/` request whose Host is not its own, so the proxy
 * rewrites Host before forwarding.
 */
export async function publicStorageOrigin(storageUrl: string) {
  const target = new URL(storageUrl);
  const server = createServer((incoming, outgoing) => {
    const forwarded = request(
      {
        host: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: target.host },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    forwarded.on("error", (error) => outgoing.destroy(error));
    incoming.pipe(forwarded);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  // SAFETY: a TCP server listening on a port reports an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${PUBLIC_LOOPBACK_HOST}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // `close` alone waits for idle keep-alive sockets indefinitely.
        server.closeAllConnections();
      }),
  };
}
