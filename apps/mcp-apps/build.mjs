#!/usr/bin/env node
// The USDA picker entry is inlined before its `ui://` resource is served.

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));

rmSync(resolve(HERE, "dist"), { recursive: true, force: true });
await build({ configFile: resolve(HERE, "vite.config.ts") });
