import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function specFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return specFiles(path);
    return entry.name.endsWith(".spec.ts") ? [path] : [];
  });
}

function durationsAt(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, duration]) =>
          typeof duration === "number" &&
          Number.isFinite(duration) &&
          duration >= 0,
      ),
    );
  } catch {
    return {};
  }
}

export function assignFiles(files, durations, count) {
  const bins = Array.from({ length: count }, () => ({ total: 0, files: [] }));
  const known = Object.keys(durations).length > 0;
  const fallback = Math.max(1, ...Object.values(durations));
  const ranked = [...files].sort((a, b) => {
    if (!known) return a.localeCompare(b);
    return (
      (durations[b] ?? fallback) - (durations[a] ?? fallback) ||
      a.localeCompare(b)
    );
  });

  for (const [index, file] of ranked.entries()) {
    const bin = known
      ? bins.reduce((least, candidate) =>
          candidate.total < least.total ? candidate : least,
        )
      : bins[index % count];
    bin.files.push(file);
    bin.total += durations[file] ?? 1;
  }
  return bins;
}

function selfTest() {
  const files = ["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"];
  const fallback = assignFiles(files, {}, 2);
  const weighted = assignFiles(
    files,
    { "a.spec.ts": 40, "b.spec.ts": 30, "c.spec.ts": 10, "d.spec.ts": 10 },
    2,
  );
  if (
    fallback[0].files.length !== 2 ||
    fallback[1].files.length !== 2 ||
    weighted[0].total !== 50 ||
    weighted[1].total !== 40
  ) {
    throw new Error(
      "Playwright shard assignment is not deterministic and balanced.",
    );
  }
  console.log("Playwright shard assignment self-check passed.");
}

if (process.argv[2] === "--self-test") {
  selfTest();
} else {
  const [root, historyPath, shard, shardCount] = process.argv.slice(2);
  const index = Number(shard);
  const count = Number(shardCount);
  if (
    !root ||
    !historyPath ||
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    index < 1 ||
    index > count
  ) {
    throw new Error(
      "Usage: playwright-shard.mjs <root> <duration-json> <shard> <shard-count>",
    );
  }
  const files = specFiles(join(root, "tests/e2e")).map((file) =>
    relative(root, file),
  );
  for (const file of assignFiles(files, durationsAt(historyPath), count)[
    index - 1
  ].files) {
    console.log(file);
  }
}
