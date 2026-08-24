#!/usr/bin/env node
// The one universal entry is inlined before a resource is served. The resource
// registrar injects the manifest app id, so it can safely expose this same
// document at the two stable `ui://` URIs without depending on host internals.

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));

rmSync(resolve(HERE, "dist"), { recursive: true, force: true });
await build({ configFile: resolve(HERE, "vite.config.ts") });
