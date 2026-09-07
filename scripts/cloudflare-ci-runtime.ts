import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CommandOptions = {
  cwd?: string;
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
};

export function commandRunner(
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  return async (
    command: string,
    args: string[],
    options: CommandOptions = {},
  ) => {
    signal.throwIfAborted();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...environment, ...options.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const terminate = () => {
      const pid = child.pid;
      if (pid) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          /* Already exited. */
        }
        const timer = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }, 5_000);
        timer.unref();
        child.once("close", () => clearTimeout(timer));
      }
    };
    signal.addEventListener("abort", terminate, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-64_000);
      if (!options.quiet) process.stdout.write(data);
    });
    let errors = "";
    child.stderr.on("data", (data: Buffer) => {
      errors = (errors + data.toString()).slice(-8_000);
      if (!options.quiet) process.stderr.write(data);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, childSignal) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(`${command} exited ${code ?? childSignal}\n${errors}`),
            );
        });
      });
      return output.trim();
    } finally {
      signal.removeEventListener("abort", terminate);
    }
  };
}

export type RunCommand = ReturnType<typeof commandRunner>;

export async function download(
  url: string,
  destination: string,
  signal: AbortSignal,
) {
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new Error(`Download failed (${response.status}): ${url}`);
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}

/** APT only downloads; dpkg-deb extracts files without maintainer scripts or host changes. */
export async function createPackageStore(
  root: string,
  run: RunCommand,
  signal: AbortSignal,
) {
  const os = await readFile("/etc/os-release", "utf8");
  if (!os.includes('VERSION_ID="24.04"') || !os.includes("ID=ubuntu"))
    throw Error("Native pilot dependencies require Ubuntu 24.04");
  const apt = join(root, "apt");
  const prefix = join(root, "system");
  for (const dir of [
    "lists/partial",
    "cache/archives/partial",
    "sourceparts",
  ]) {
    await mkdir(join(apt, dir), { recursive: true });
  }
  await mkdir(prefix, { recursive: true });
  await writeFile(
    join(prefix, "pilot-fonts.conf"),
    `<fontconfig><dir>${prefix}/usr/share/fonts</dir><cachedir>${prefix}/font-cache</cachedir></fontconfig>`,
  );
  await writeFile(join(apt, "status"), "");
  const key = join(apt, "postgresql.asc");
  await download(
    "https://www.postgresql.org/media/keys/ACCC4CF8.asc",
    key,
    signal,
  );
  await writeFile(
    join(apt, "sources.list"),
    [
      "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://archive.ubuntu.com/ubuntu noble main universe multiverse restricted",
      "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://archive.ubuntu.com/ubuntu noble-updates main universe multiverse restricted",
      "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://security.ubuntu.com/ubuntu noble-security main universe multiverse restricted",
      `deb [signed-by=${key}] http://apt.postgresql.org/pub/repos/apt noble-pgdg main`,
    ].join("\n"),
  );
  const aptOptions = [
    "-o",
    `Dir::State::lists=${apt}/lists`,
    "-o",
    `Dir::State::status=${apt}/status`,
    "-o",
    `Dir::Cache=${apt}/cache`,
    "-o",
    `Dir::Etc::sourcelist=${apt}/sources.list`,
    "-o",
    `Dir::Etc::sourceparts=${apt}/sourceparts`,
    "-o",
    "Debug::NoLocking=true",
  ];
  await run("apt-get", [...aptOptions, "update"], { quiet: true });
  const extracted = new Set<string>();
  return {
    prefix,
    async install(packages: string[]) {
      if (
        !packages.length ||
        packages.some(
          (name) =>
            !/^[a-z0-9][a-z0-9+.:-]*(?:=[a-zA-Z0-9.+:~_-]+)?$/u.test(name),
        )
      ) {
        throw new Error("Invalid APT package list");
      }
      await run(
        "apt-get",
        [
          ...aptOptions,
          "--yes",
          "--download-only",
          "--no-install-recommends",
          "install",
          ...packages,
        ],
        { quiet: true },
      );
      const archives = join(apt, "cache/archives");
      for (const file of (await readdir(archives))
        .filter((name) => name.endsWith(".deb"))
        .sort()) {
        if (extracted.has(file)) continue;
        const archive = join(archives, file);
        console.log(
          `pilot package=${file} sha256=${createHash("sha256")
            .update(await readFile(archive))
            .digest("hex")}`,
        );
        // Keep the host's dynamic loader and glibc paired. Noble has the required ABI.
        if (!/^libc6[_-]|^libc-bin_/u.test(file))
          await run("dpkg-deb", ["-x", archive, prefix], { quiet: true });
        extracted.add(file);
      }
    },
  };
}

export function relocatedEnvironment(
  prefix: string,
  original: NodeJS.ProcessEnv,
) {
  return {
    // Playwright checks the host ldconfig cache, which cannot describe a relocated prefix.
    // Both real browser launches and the unchanged E2E suite validate the extracted libraries.
    ...original,
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: "1",
    PATH: `${prefix}/usr/lib/postgresql/17/bin:${prefix}/usr/bin:${original.PATH}`,
    LD_LIBRARY_PATH: `${prefix}/usr/lib/x86_64-linux-gnu:${prefix}/lib/x86_64-linux-gnu:${prefix}/usr/lib/postgresql/17/lib:${prefix}/usr/lib/x86_64-linux-gnu/blas:${prefix}/usr/lib/x86_64-linux-gnu/lapack:${prefix}/usr/lib/x86_64-linux-gnu/pulseaudio`,
    LIBGL_DRIVERS_PATH: `${prefix}/usr/lib/x86_64-linux-gnu/dri`,
    __EGL_VENDOR_LIBRARY_FILENAMES: `${prefix}/usr/share/glvnd/egl_vendor.d/50_mesa.json`,
    FONTCONFIG_FILE: `${prefix}/pilot-fonts.conf`,
    XDG_DATA_DIRS: `${prefix}/usr/share:/usr/share`,
    GSETTINGS_SCHEMA_DIR: `${prefix}/usr/share/glib-2.0/schemas`,
    GST_PLUGIN_SYSTEM_PATH_1_0: `${prefix}/usr/lib/x86_64-linux-gnu/gstreamer-1.0`,
  };
}

// Ubuntu 24.04 dependencies from Playwright 1.62.1 nativeDeps (tools, Chromium, WebKit).
// The pilot verifies this package version before using the list.
export const browserPackages = [
  // APT recommendations normally supply the software EGL renderer.
  "libegl-mesa0",
  "libgl1-mesa-dri",
  "xvfb",
  "fonts-noto-color-emoji",
  "fonts-unifont",
  "libfontconfig1",
  "libfreetype6",
  "xfonts-cyrillic",
  "xfonts-scalable",
  "fonts-liberation",
  "fonts-ipafont-gothic",
  "fonts-wqy-zenhei",
  "fonts-tlwg-loma-otf",
  "fonts-freefont-ttf",
  "libasound2t64",
  "libatk-bridge2.0-0t64",
  "libatk1.0-0t64",
  "libatspi2.0-0t64",
  "libcairo2",
  "libcups2t64",
  "libdbus-1-3",
  "libdrm2",
  "libgbm1",
  "libglib2.0-0t64",
  "libnspr4",
  "libnss3",
  "libpango-1.0-0",
  "libx11-6",
  "libxcb1",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxkbcommon0",
  "libxrandr2",
  "gstreamer1.0-libav",
  "gstreamer1.0-plugins-bad",
  "gstreamer1.0-plugins-base",
  "gstreamer1.0-plugins-good",
  "libicu74",
  "libatomic1",
  "libcairo-gobject2",
  "libenchant-2-2",
  "libepoxy0",
  "libevent-2.1-7t64",
  "libflite1",
  "libgdk-pixbuf-2.0-0",
  "libgles2",
  "libgstreamer-gl1.0-0",
  "libgstreamer-plugins-bad1.0-0",
  "libgstreamer-plugins-base1.0-0",
  "libgstreamer1.0-0",
  "libgtk-4-1",
  "libharfbuzz-icu0",
  "libharfbuzz0b",
  "libhyphen0",
  "libjpeg-turbo8",
  "liblcms2-2",
  "libmanette-0.2-0",
  "libopus0",
  "libpangocairo-1.0-0",
  "libpng16-16t64",
  "libsecret-1-0",
  "libvpx9",
  "libwayland-client0",
  "libwayland-egl1",
  "libwayland-server0",
  "libwebp7",
  "libwebpdemux2",
  "libwoff1",
  "libxml2",
  "libxslt1.1",
  "libx264-164",
  "libavif16",
];

export const postgresPackages = [
  "postgresql-17=17.11-1.pgdg24.04+2",
  "postgresql-client-17=17.11-1.pgdg24.04+2",
  "postgresql-17-pgvector=0.8.6-1.pgdg24.04+1",
];
