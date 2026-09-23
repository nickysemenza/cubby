import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = z.object({ port: z.number() }).parse(server.address()).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function startE2EHttp2Proxy(upstreamURL: string) {
  const binary = process.env.CUBBY_E2E_CADDY_BIN;
  if (!binary) throw new Error("CUBBY_E2E_CADDY_BIN is required");
  const directory = await mkdtemp(path.join(os.tmpdir(), "cubby-e2e-caddy-"));
  const port = await freePort();
  const upstream = new URL(upstreamURL);
  const config = path.join(directory, "Caddyfile");
  await writeFile(
    config,
    `{\n  admin off\n  auto_https disable_redirects\n}\nhttps://127.0.0.1:${port} {\n  tls internal\n  reverse_proxy ${upstream.hostname}:${upstream.port}\n}\n`,
  );
  const processHandle = spawn(binary, ["run", "--config", config], {
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  processHandle.stderr.on("data", (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-4000);
  });
  const baseURL = `https://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (processHandle.exitCode !== null) break;
      ready = await new Promise<boolean>((resolve) => {
        const socket = tls.connect({
          host: "127.0.0.1",
          port,
          rejectUnauthorized: false,
          ALPNProtocols: ["h2"],
        });
        socket.once("secureConnect", () => {
          const isH2 = socket.alpnProtocol === "h2";
          socket.end();
          resolve(isH2);
        });
        socket.once("error", () => resolve(false));
      });
      if (ready) break;
      await delay(100);
    }
    if (!ready) throw new Error(`Caddy did not start HTTP/2: ${logs}`);
    const previousCAs = tls.getCACertificates("default");
    const rootCA = await readFile(
      path.join(
        directory,
        "data",
        "caddy",
        "pki",
        "authorities",
        "local",
        "root.crt",
      ),
      "utf8",
    );
    tls.setDefaultCACertificates([...previousCAs, rootCA]);
    return {
      baseURL,
      async close() {
        tls.setDefaultCACertificates(previousCAs);
        if (
          processHandle.exitCode === null &&
          processHandle.signalCode === null
        ) {
          const exited = new Promise<void>((resolve) =>
            processHandle.once("exit", () => resolve()),
          );
          processHandle.kill("SIGTERM");
          await Promise.race([exited, delay(2000)]);
          if (
            processHandle.exitCode === null &&
            processHandle.signalCode === null
          ) {
            processHandle.kill("SIGKILL");
          }
        }
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    processHandle.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
