/**
 * Reject live Cubby entity codes in outward-facing engineering text: commit
 * messages (the `commit-msg` hook) and PR titles/bodies (CI). AGENTS.md bans
 * real household identifiers there; a rule in a doc did not stop one from
 * being pasted straight out of a debugging session, so this is the gate.
 *
 * Usage: `node scripts/check-outward-text.ts <file>` or `--stdin`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const registry = readFileSync(
  resolve(root, "packages/shared/src/generated/shortcode-registry.gen.ts"),
  "utf8",
);
const prefixes = [...registry.matchAll(/:"([A-Z]+-)"/g)].map(([, p]) => p!);
if (prefixes.length === 0)
  throw new Error("No shortcode prefixes found in the generated registry");

// The one sanctioned example body, used by docs and error messages.
const EXAMPLE_BODY = "4K7M";
const SHORTCODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const livePatterns: readonly RegExp[] = [
  new RegExp(
    `\\b(?:${prefixes.map((p) => p.slice(0, -1)).join("|")})-[${SHORTCODE_CHARS}]{4}\\b`,
    "g",
  ),
  // Operational ids that predate the shortcode registry.
  /\bPIR-[A-Z0-9]{10}\b/g,
  /\bIP[RS]-[0-9A-F]{32}\b/g,
];

export function findLiveCodes(text: string): string[] {
  const hits = new Set<string>();
  for (const pattern of livePatterns) {
    for (const [match] of text.matchAll(pattern)) {
      if (!match.endsWith(`-${EXAMPLE_BODY}`)) hits.add(match);
    }
  }
  return [...hits];
}

if (import.meta.main) {
  const source = process.argv[2];
  const text =
    source === "--stdin" || source === undefined
      ? readFileSync(0, "utf8")
      : readFileSync(source, "utf8");
  const hits = findLiveCodes(text);
  if (hits.length > 0) {
    console.error(
      `Outward-facing text names live entity codes: ${hits.join(", ")}.\n` +
        "Describe the case with a synthetic example instead (AGENTS.md → synthetic data).",
    );
    process.exit(1);
  }
}
