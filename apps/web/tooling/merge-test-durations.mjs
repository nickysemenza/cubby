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
    "Usage: merge-test-durations.mjs <timing-directory> <output-json>",
  );
}

function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return entry.name.endsWith(".json") ? [path] : [];
  });
}

const durations = {};
for (const path of filesIn(sourceDirectory)) {
  try {
    const report = JSON.parse(readFileSync(path, "utf8"));
    if (!report || typeof report !== "object" || !report.timings) continue;
    for (const [file, timing] of Object.entries(report.timings)) {
      if (
        timing &&
        typeof timing === "object" &&
        typeof timing.total === "number" &&
        Number.isFinite(timing.total) &&
        timing.total >= 0
      ) {
        durations[file] = timing.total;
      }
    }
  } catch {
    // A partial artifact must not block deterministic hash sharding next run.
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(durations, null, 2)}\n`);
console.log(`Promoted ${Object.keys(durations).length} Vitest file durations.`);
