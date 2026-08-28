import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { z } from "zod";

/** One reviewed, time-boxed exemption from `security-audit-allowlist.json`. */
const allowlistEntrySchema = z.object({
  advisory: z.string().min(1),
  reviewedAt: z.iso.date(),
  expires: z.iso.date(),
  reachability: z.string().min(1),
  rationale: z.string().min(1),
});
type AllowlistEntry = z.output<typeof allowlistEntrySchema>;

/** The subset of a `pnpm audit --json` advisory this gate reads. */
const advisorySchema = z.object({
  severity: z.string(),
  github_advisory_id: z.string(),
  module_name: z.string(),
  title: z.string(),
});

const policy = z
  .object({ entries: z.array(allowlistEntrySchema) })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../security-audit-allowlist.json", import.meta.url),
        "utf8",
      ),
    ),
  );
const now = new Date();
const allowlist = new Map<
  string,
  Omit<AllowlistEntry, "expires"> & { expires: Date }
>();

for (const entry of policy.entries) {
  const reviewedAt = new Date(entry.reviewedAt);
  const expires = new Date(entry.expires);
  const lifetimeDays = (expires.getTime() - reviewedAt.getTime()) / 86_400_000;
  if (
    !entry.advisory ||
    !entry.reachability ||
    !entry.rationale ||
    !Number.isFinite(lifetimeDays) ||
    lifetimeDays <= 0 ||
    lifetimeDays > 90
  ) {
    throw new Error(
      `Invalid security allowlist entry ${entry.advisory ?? "[missing advisory]"}`,
    );
  }
  allowlist.set(entry.advisory, { ...entry, expires });
}

const audit = spawnSync("pnpm", ["audit", "--prod", "--json"], {
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});
if (!audit.stdout) {
  throw new Error(`pnpm audit produced no JSON: ${audit.stderr}`);
}

const report = z
  .object({
    advisories: z.record(z.string(), advisorySchema).optional(),
  })
  .parse(JSON.parse(audit.stdout));
const failures: string[] = [];
for (const advisory of Object.values(report.advisories ?? {})) {
  if (!new Set(["critical", "high"]).has(advisory.severity)) continue;
  const id = advisory.github_advisory_id;
  const allowed = allowlist.get(id);
  if (!allowed || allowed.expires <= now) {
    failures.push(
      `${id}: ${advisory.module_name} — ${advisory.title}${allowed ? " (allowlist expired)" : ""}`,
    );
  }
}

if (failures.length > 0) {
  console.error("Unallowlisted critical/high dependency advisories:\n");
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    "Security audit gate passed (no unallowlisted critical/high advisory)",
  );
}
