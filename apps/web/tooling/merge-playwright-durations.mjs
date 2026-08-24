import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const [sourceDirectory, outputPath] = process.argv.slice(2);
if (!sourceDirectory || !outputPath) {
  throw new Error(
    "Usage: merge-playwright-durations.mjs <timing-directory> <output-json>",
  );
}

function jsonFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? jsonFiles(path)
      : entry.name.endsWith(".json")
        ? [path]
        : [];
  });
}

const durations = {};
for (const path of jsonFiles(sourceDirectory)) {
  try {
    const report = JSON.parse(readFileSync(path, "utf8"));
    if (!report || typeof report !== "object") continue;
    for (const [file, duration] of Object.entries(report)) {
      if (
        typeof duration === "number" &&
        Number.isFinite(duration) &&
        duration >= 0
      ) {
        durations[file] = duration;
      }
    }
  } catch {
    // A malformed timing artifact must not block the next run's fallback.
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(durations, null, 2)}\n`);
console.log(
  `Promoted ${Object.keys(durations).length} Playwright file durations.`,
);
