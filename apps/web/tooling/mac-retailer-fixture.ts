import { spawn, execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import path from "node:path";
import { chromium } from "@playwright/test";
import { z } from "zod";

/** Synthetic HTTPS retailer and uniquely addressed native Chromium, never a user browser. */
export async function createMacRetailerFixture(
  artifacts: string,
  nonce: string,
) {
  if (process.platform !== "darwin" || !/^[a-f\d]{16}$/u.test(nonce))
    throw new Error("Mac retailer fixture requires macOS and a fixture nonce");
  const root = path.join(artifacts, "retailer");
  mkdirSync(root, { recursive: true });
  const key = path.join(root, "tls-key.pem");
  const certificate = path.join(root, "tls-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=shop.example.test",
      "-addext",
      "subjectAltName=DNS:shop.example.test",
    ],
    { stdio: "ignore" },
  );
  const spki = createHash("sha256")
    .update(
      new X509Certificate(readFileSync(certificate)).publicKey.export({
        type: "spki",
        format: "der",
      }),
    )
    .digest("base64");
  let origin = "";
  const requests: Array<{ path: string; authenticated: boolean }> = [];
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    (request, response) => {
      const pathname = new URL(request.url ?? "/", "https://shop.example.test")
        .pathname;
      const authenticated =
        request.headers.cookie?.includes("fixture_session=synthetic") ?? false;
      requests.push({ path: pathname, authenticated });
      if (pathname === "/sign-in" && request.method === "POST") {
        response.writeHead(303, {
          "Set-Cookie":
            "fixture_session=synthetic; Secure; HttpOnly; SameSite=Lax",
          Location: "/order-history",
        });
        response.end();
        return;
      }
      const body = !authenticated
        ? '<h1>Sign in to Synthetic Outfitters</h1><form method="POST" action="/sign-in"><input type="password" name="password" aria-label="Fixture password"><button>Sign in to fixture retailer</button></form>'
        : pathname === "/order-history"
          ? `<h1>Your orders</h1><article><p>Order placed September 21, 2026</p><p>Order # order-001</p><a href="${origin}/orders/order-001">View order</a></article>`
          : pathname === "/orders/order-001"
            ? `<h1>Order order-001</h1><p>September 21, 2026 · Delivered · Visa ending 4242 · Total $29.99</p><a href="${origin}/products/black-crew-shirt">Black crew shirt · size M</a><p>Quantity 1 · $29.99</p>`
            : "<h1>Black crew shirt</h1><p>Exact color Black · Size M · GTIN 00012345678905 · $29.99</p>";
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic Outfitters</title><link rel="canonical" href="${origin}${pathname}"></head><body>${body}</body></html>`,
      );
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  origin = `https://shop.example.test:${address.port}`;
  const bundleID = `com.cubby.fixture.browser.${nonce}`;
  const appPath = path.join(root, "FixtureBrowser.app");
  const profile = path.join(root, "profile");
  const originalExecutable = chromium.executablePath();
  const sourceApp = path.dirname(
    path.dirname(path.dirname(originalExecutable)),
  );
  let browser: ReturnType<typeof spawn> | undefined;
  try {
    execFileSync("ditto", [sourceApp, appPath]);
    const info = path.join(appPath, "Contents/Info.plist");
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :CFBundleIdentifier ${bundleID}`,
      info,
    ]);
    execFileSync(
      "codesign",
      [
        "--force",
        "--deep",
        "--sign",
        "-",
        "--preserve-metadata=entitlements",
        appPath,
      ],
      { stdio: "ignore" },
    );
    execFileSync(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", appPath],
    );
    mkdirSync(path.join(profile, "Default"), { recursive: true });
    writeFileSync(
      path.join(profile, "Default/Preferences"),
      JSON.stringify({ browser: { allow_javascript_apple_events: true } }),
    );
    writeFileSync(
      path.join(root, "fixture.json"),
      JSON.stringify(
        { bundleID, origin, certificateSPKI: spki, isolatedProfile: true },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return {
    bundleID,
    origin,
    profile,
    appPath,
    get pid() {
      if (!browser?.pid) throw new Error("Fixture browser has not launched");
      return browser.pid;
    },
    historyURL: `${origin}/order-history`,
    async launch() {
      const executable = path.join(
        appPath,
        "Contents/MacOS",
        path.basename(originalExecutable),
      );
      browser = spawn(
        executable,
        [
          `--user-data-dir=${profile}`,
          `--ignore-certificate-errors-spki-list=${spki}`,
          "--host-resolver-rules=MAP shop.example.test 127.0.0.1",
          "--no-proxy-server",
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
        { stdio: "ignore" },
      );
      const owned = browser;
      await new Promise<void>((resolve, reject) => {
        owned.once("spawn", resolve);
        owned.once("error", reject);
      });
      if (!owned.pid) throw new Error("Fixture browser did not launch");
      const command = execFileSync(
        "ps",
        ["-p", String(owned.pid), "-o", "command="],
        { encoding: "utf8" },
      );
      if (
        !command.startsWith(executable) ||
        !command.includes(`--user-data-dir=${profile}`)
      )
        throw new Error("Fixture browser process/profile identity mismatch");
    },
    async close() {
      browser?.kill("SIGTERM");
      server.closeAllConnections();
      writeFileSync(
        path.join(root, "requests.json"),
        JSON.stringify(requests, null, 2) + "\n",
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
