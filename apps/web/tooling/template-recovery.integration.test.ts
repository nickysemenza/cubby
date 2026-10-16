import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { Client } from "pg";
import { templateMarkerDirectory } from "../../../scripts/lib/template-markers.ts";
import { initializeRecoverableTemplate } from "./template-recovery";
import { templateClient, templateConnectionUrl } from "./schema-template";

// A killed initializer leaves 423 forever. Live initializers must never be
// discarded; simultaneous recoverers must converge without dropping a successor.
it("recovers an interrupted template and preserves live initialization", async () => {
  const hash = createHash("sha1")
    .update(`synthetic-recovery-${process.pid}-${Date.now()}`)
    .digest("hex");
  const directory = mkdtempSync(join(tmpdir(), "cubby-template-interruption-"));
  const script = join(directory, "initializer.mts");
  writeFileSync(
    script,
    `import { initializeRecoverableTemplate } from ${JSON.stringify(new URL("./template-recovery.ts", import.meta.url).pathname)}; await initializeRecoverableTemplate('${hash}', async () => { console.log('SYNTHETIC_INITIALIZING'); setInterval(() => {}, 1000); await new Promise(() => {}); });`,
  );
  const child = spawn("pnpm", ["exec", "tsx", script], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const output: string[] = [];
  child.stderr.on("data", (data) => output.push(String(data)));
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Initializer did not start: ${output.join("")}`)),
        15_000,
      );
      child.stdout.on("data", (data) => {
        if (String(data).includes("SYNTHETIC_INITIALIZING")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(output.join("")));
      });
    });
    await expect(
      initializeRecoverableTemplate(
        hash,
        async () => {
          throw new Error("Must not replace live initializer");
        },
        { timeoutMs: 300 },
      ),
    ).rejects.toThrow(/Timed out/u);
    process.kill(-child.pid!, "SIGKILL");
    await once(child, "exit");
    let seeds = 0;
    const setup = async (
      config: Parameters<
        Parameters<ReturnType<typeof templateClient>["initializeTemplate"]>[1]
      >[0],
    ) => {
      seeds++;
      const db = new Client({
        connectionString: templateConnectionUrl(config),
      });
      await db.connect();
      try {
        await db.query("CREATE TABLE synthetic_recovered (value integer)");
      } finally {
        await db.end();
      }
    };
    const hashes = await Promise.all([
      initializeRecoverableTemplate(hash, setup),
      initializeRecoverableTemplate(hash, setup),
    ]);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hash);
    expect(seeds).toBe(1);
    const client = templateClient();
    const lease = await client.api.getTestDatabase(hashes[0]!);
    const db = new Client({
      connectionString: templateConnectionUrl(lease.database.config),
    });
    await db.connect();
    try {
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM synthetic_recovered",
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await db.end();
      await client.api.reuseTestDatabase(hashes[0]!, lease.id);
      await client.api.discardTemplate(hashes[0]!);
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid!, "SIGKILL");
      await once(child, "exit");
    }
    await templateClient()
      .api.discardTemplate(hash)
      .catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

// Established redirects must not spend a new waiter's interruption budget.
it("traverses more than eight historical interruptions before initializing", async () => {
  const initial = createHash("sha1")
    .update(`synthetic-history-${process.pid}-${Date.now()}`)
    .digest("hex");
  const directory = templateMarkerDirectory(
    process.env.INTEGRESQL_URL ?? "http://localhost:5000",
    process.env.CUBBY_TEMPLATE_SERVICE_ID,
  );
  const files: string[] = [];
  const owner = {
    pid: 2147483647,
    start: "synthetic-dead-owner",
    host: hostname(),
  };
  let hash = initial;
  try {
    for (let i = 0; i < 9; i++) {
      const redirect = createHash("sha1")
        .update(hash)
        .update(JSON.stringify(owner))
        .digest("hex");
      const file = join(directory, `${hash}.json`);
      writeFileSync(file, JSON.stringify({ ...owner, redirect }));
      files.push(file);
      hash = redirect;
    }
    let seeds = 0;
    expect(
      await initializeRecoverableTemplate(initial, async () => {
        seeds++;
      }),
    ).toBe(hash);
    expect(seeds).toBe(1);
  } finally {
    for (const file of files) rmSync(file, { force: true });
    await templateClient()
      .api.discardTemplate(hash)
      .catch(() => {});
  }
});

// PID reuse can be proven only with a recognized birth identity. A foreign
// host or an unknown service incarnation is never local recovery authority.
it("fails closed for unverifiable identities and marker namespaces", async () => {
  const serviceId = process.env.CUBBY_TEMPLATE_SERVICE_ID;
  const hash = createHash("sha1")
    .update(`synthetic-unknown-${process.pid}-${Date.now()}`)
    .digest("hex");
  const url = process.env.INTEGRESQL_URL ?? "http://localhost:5000";
  const files: string[] = [];
  await templateClient().api.initializeTemplate(hash);
  try {
    for (const scope of ["birth", "host", "service"]) {
      if (scope === "service") delete process.env.CUBBY_TEMPLATE_SERVICE_ID;
      const file = join(
        templateMarkerDirectory(url, process.env.CUBBY_TEMPLATE_SERVICE_ID),
        `${hash}.json`,
      );
      files.push(file);
      writeFileSync(
        file,
        JSON.stringify({
          pid: process.pid,
          start: "unverifiable-birth",
          host: scope === "host" ? "synthetic-foreign-host" : hostname(),
        }),
      );
      await expect(
        initializeRecoverableTemplate(
          hash,
          async () => {
            throw new Error("Must not replace unverifiable owner");
          },
          { timeoutMs: 100 },
        ),
      ).rejects.toThrow(/Timed out/u);
      rmSync(file);
    }
  } finally {
    if (serviceId === undefined) delete process.env.CUBBY_TEMPLATE_SERVICE_ID;
    else process.env.CUBBY_TEMPLATE_SERVICE_ID = serviceId;
    for (const file of files) rmSync(file, { force: true });
    await templateClient().api.discardTemplate(hash);
  }
});
