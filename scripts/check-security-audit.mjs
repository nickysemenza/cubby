import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const policy = JSON.parse(
  readFileSync(new URL("../security-audit-allowlist.json", import.meta.url)),
);
const now = new Date();
const allowlist = new Map();

for (const entry of policy.entries) {
  const reviewedAt = new Date(entry.reviewedAt);
  const expires = new Date(entry.expires);
  const lifetimeDays = (expires - reviewedAt) / 86_400_000;
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

const report = JSON.parse(audit.stdout);
const failures = [];
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
  console.log("Security audit gate passed (no unallowlisted critical/high advisory)");
}
