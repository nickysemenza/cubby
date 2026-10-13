import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

// An ephemeral loopback response avoids env-size limits and source files.
let buffer = "";
let started = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  try {
    JSON.parse(buffer);
  } catch {
    return;
  }
  started = true;
  process.stdin.pause();
  const route = `/${randomUUID()}`;
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== route) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(buffer);
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing local input socket");
    const child = spawn("pnpm", ["eval:mail-prompts"], {
      env: {
        ...process.env,
        MAIL_PROMPT_INPUT_URL: `http://127.0.0.1:${address.port}${route}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    const close = (code: number) => {
      buffer = "";
      process.stdin.destroy();
      server.close();
      process.exitCode = code;
    };
    child.on("error", () => close(1));
    child.on("exit", (code) => close(code ?? 1));
  });
});
process.stdin.on("end", () => {
  if (!started) {
    console.error("Expected a complete JSON array on stdin");
    process.exitCode = 1;
  }
});
