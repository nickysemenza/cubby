import { z } from "zod";
import { createServer } from "node:http";

/** External S3 seam: keep browser attachment contracts off real household storage. */
export async function createE2EObjectStorage() {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Allow-Methods",
      "GET, PUT, DELETE, OPTIONS",
    );
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, x-amz-content-sha256",
    );
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const key = decodeURIComponent(
      pathname.replace(/^\/e2e-bucket\//, "/").slice(1),
    );
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.set(key, {
        bytes: Buffer.concat(chunks),
        contentType:
          request.headers["content-type"] ?? "application/octet-stream",
      });
      response.writeHead(200).end();
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204).end();
      return;
    }
    const object = objects.get(key);
    if (!object) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": object.contentType,
      "content-length": object.bytes.length,
    });
    response.end(object.bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z.object({ port: z.number() }).parse(server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
export type E2EObjectStorage = Awaited<
  ReturnType<typeof createE2EObjectStorage>
>;
