/** Assemble selected SDK shard documents without rewriting their evidence. */
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readJourneyEvidence, writeJourneyHtml } from "../tester-army/html.ts";
import { testerArmyRecords } from "./records.ts";

const [input, expected] = process.argv.slice(2);
if (!input)
  throw new Error("usage: tester-army.ts <downloaded-artifacts> <shard-count>");
const count = z.coerce.number().int().min(1).max(16).parse(expected);
const output = path.resolve(
  import.meta.dirname,
  "../../artifacts/tester-army-report",
);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const choices = new Map<number, { name: string; attempt: number }>();
for (const name of await readdir(input).catch(() => [])) {
  const match = /-(\d+)of(\d+)-attempt(\d+)$/u.exec(name);
  if (!match || Number(match[2]) !== count) continue;
  const shard = Number(match[1]);
  const attempt = Number(match[3]);
  if (
    shard >= 1 &&
    shard <= count &&
    attempt > (choices.get(shard)?.attempt ?? 0)
  )
    choices.set(shard, { name, attempt });
}
const sources: Awaited<ReturnType<typeof readJourneyEvidence>>[] = [];
const missing: string[] = [];
const extraLinks: { href: string; label: string }[] = [];
for (let shard = 1; shard <= count; shard++) {
  const choice = choices.get(shard);
  if (!choice) {
    missing.push(`Shard ${shard}/${count}: no artifact was produced.`);
    continue;
  }
  const prefix = `shards/${shard}/`;
  const destination = path.join(output, prefix);
  await cp(path.join(input, choice.name), destination, { recursive: true });
  extraLinks.push({
    href: `${prefix}index.html`,
    label: `Shard ${shard}/${count} report (attempt ${choice.attempt})`,
  });
  try {
    sources.push(await readJourneyEvidence(destination, prefix));
  } catch (error) {
    missing.push(
      `Shard ${shard}/${count}: ${error instanceof Error ? error.message : "unreadable test evidence"}`,
    );
  }
}
const selected = sources.flatMap(({ report }) =>
  report.run.results.filter((result) => result.selected),
);
const identities = selected.map(
  (result) => `${result.testId}:${result.targetId}`,
);
if (new Set(identities).size !== identities.length)
  missing.push("A selected journey appears in more than one shard.");
const discovered = Math.max(
  0,
  ...sources.map(({ report }) => report.run.summary.discovered ?? 0),
);
if (selected.length !== discovered)
  missing.push(
    `Only ${selected.length} of ${discovered} discovered journeys have selected evidence.`,
  );
const complete = await writeJourneyHtml(output, sources, missing, extraLinks);
await writeFile(
  path.join(output, "records.json"),
  JSON.stringify({
    complete,
    missing,
    records: sources.flatMap(({ report }) => testerArmyRecords(report)),
  }),
);
// Preserve startup diagnostics even when no SDK document could be read.
console.log(
  `Tester Army report: ${selected.length} selected journeys, ${sources.length}/${count} shards, ${complete ? "passed" : "failed / incomplete"}`,
);
process.exitCode = complete ? 0 : 1;
