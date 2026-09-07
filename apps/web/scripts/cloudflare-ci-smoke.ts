import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
if (
  process.env.WORKERS_CI !== "1" ||
  process.env.WORKERS_CI_BRANCH !== "codex/cloudflare-ci-pilot"
)
  throw Error("Pilot environment required");
if (process.argv[2] === "database") {
  const { default: pg } = await import("pg");
  const { IntegreSQLClient } = await import("@devoxa/integresql-client");
  const client = new IntegreSQLClient({ url: "http://localhost:5000" });
  const hash = "cubby_cloudflare_ci_pilot";
  const poolFor = (config: {
    username: string;
    password: string;
    database: string;
  }) =>
    new pg.Pool({
      host: "localhost",
      port: 5432,
      user: config.username,
      password: config.password,
      database: config.database,
    });
  await client.initializeTemplate(hash, async (config) => {
    const pool = poolFor(config);
    try {
      await pool.query(
        "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE TABLE pilot (id integer); INSERT INTO pilot VALUES (42)",
      );
    } finally {
      await pool.end();
    }
  });
  const pool = poolFor(await client.getTestDatabase(hash));
  try {
    const { rows } = await pool.query(
      "SELECT id, (SELECT extversion FROM pg_extension WHERE extname = $$vector$$) AS vector FROM pilot",
    );
    if (rows[0]?.id !== 42 || !rows[0]?.vector)
      throw Error("template clone failed");
    console.log("pilot database template clone and pgvector passed");
  } finally {
    await pool.end();
  }
} else if (process.argv[2] === "prepare-browser") {
  const { webkit } = await import("@playwright/test");
  const original = 'export LD_LIBRARY_PATH="${MYDIR}/lib:${MYDIR}/sys/lib"';
  const relocated =
    'export LD_LIBRARY_PATH="${MYDIR}/lib:${MYDIR}/sys/lib:${LD_LIBRARY_PATH:-}"';
  for (const kind of ["wpe", "gtk"]) {
    const path = join(
      dirname(webkit.executablePath()),
      `minibrowser-${kind}`,
      "MiniBrowser",
    );
    const script = await readFile(path, "utf8");
    if (script.includes(relocated)) continue;
    if (!script.includes(original))
      throw Error("WebKit launcher changed; review library relocation");
    // Preserve the user-local dependency prefix through the upstream wrapper.
    await writeFile(path, script.replace(original, relocated));
  }
} else if (process.argv[2] === "browser") {
  const { chromium, webkit } = await import("@playwright/test");
  const { default: http } = await import("node:http");
  const server = http.createServer((_req, res) => res.end("pilot"));
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(undefined)),
  );
  // SAFETY: listen completed above on an explicit TCP host and ephemeral port.
  const { port } = server.address() as AddressInfo;
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}`);
        if ((await page.locator("body").innerText()) !== "pilot")
          throw Error("browser smoke failed");
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
  }
} else {
  throw Error("Unknown smoke probe");
}
