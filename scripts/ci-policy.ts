import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The Nx tasks (`project:target`, `*` for every project with the target) each
// CI lane runs, and the files a lane's non-Nx steps read. Keep each lane's
// tasks in step with its command in ci.yaml.
// `deleted` patterns select the lane only when a matching file is deleted.
export type LaneSpec = {
  tasks?: string[];
  files?: string[];
  deleted?: string[];
};
export const LANES = {
  // Named Validation steps.
  validation: {
    tasks: [
      "cubby-checks:generate",
      "cubby-checks:design-tokens",
      "cubby-checks:types",
      "cubby-checks:lint",
      "cubby-checks:knip",
      "cubby-checks:bindings",
      "cubby-checks:script-tests",
      "cubby-checks:ci-lanes",
      "@cubby/web:workers-tests",
    ],
  },
  // Formatting and the offline Markdown link check (lychee).
  docs: {
    tasks: ["cubby-checks:format"],
    files: [".lycheeignore"],
    // A deleted or renamed file can be any relative link's target.
    deleted: ["**"],
  },
  aux: { tasks: ["*:test"] },
  "build-worker": {
    tasks: ["@cubby/web:db-check", "@cubby/web:workerd-tests"],
  },
  postgres: { tasks: ["@cubby/web:postgres"] },
  e2e: { tasks: ["@cubby/web:e2e"] },
  "purchase-import": { tasks: ["@cubby/web:e2e-purchase-import"] },
  rust: { tasks: ["*:rust"] },
  "apple-lint": { tasks: ["apple:lint"] },
  apple: { tasks: ["apple:host-tests", "apple:simulator-build"] },
} satisfies Record<string, LaneSpec>;

export const JOURNEYS = [
  "simulator-search",
  "simulator-inputs",
  "tester-army-web",
  "tester-army-visual",
  "tester-army-explore",
  "tester-army-ios",
  "tester-army-both",
  "tester-army-import",
  "tester-army-all",
];

export interface MatrixEntry {
  lane?: string;
  name: string;
  run: string;
  db?: boolean;
  browser?: string;
  step?: string;
  timeout?: number;
  // At most two companion checks, each a separate workflow step after `run`.
  checks?: { lane: string; name: string; run: string }[];
}

// Browser shards run alone: a companion check behind a shard serializes the
// slowest lane's wall time.
const E2E_SHARDS = [1, 2, 3, 4];

export function laneMatrix(lanes: readonly string[]): MatrixEntry[] {
  const entries: MatrixEntry[] = [
    {
      lane: "aux",
      name: "Auxiliary tests and builds",
      run: "pnpm exec nx run-many -t test --exclude=cubby-checks --outputStyle=static-failures-only",
    },
    {
      lane: "build-worker",
      name: "Build Workers and runtime tests",
      db: true,
      run: "pnpm exec nx run-many -p @cubby/web -t db-check workerd-tests --parallel=1 --outputStyle=stream",
    },
    {
      lane: "postgres",
      name: "PostgreSQL integration tests",
      db: true,
      run: "pnpm exec nx run @cubby/web:postgres --outputStyle=stream",
    },
    ...E2E_SHARDS.map((shard) => ({
      lane: "e2e",
      name: `E2E tests (desktop ${shard}/${E2E_SHARDS.length})`,
      db: true,
      browser: `desktop-${shard}`,
      run: `CUBBY_E2E_SHARD=${shard}/${E2E_SHARDS.length} pnpm exec nx run @cubby/web:e2e --outputStyle=stream`,
    })),
  ].filter((entry) => lanes.includes(entry.lane!));
  const companion = (entry: MatrixEntry) => ({
    lane: entry.lane!,
    name: entry.name,
    run: entry.run,
  });
  const aux = entries.find((entry) => entry.lane === "aux");
  const worker = entries.find((entry) => entry.lane === "build-worker");
  if (!aux || !worker) return entries;
  return [
    ...entries.filter((entry) => entry !== aux && entry !== worker),
    {
      ...aux,
      name: "Auxiliary, Worker, and runtime tests",
      db: true,
      step: aux.name,
      checks: [companion(worker)],
    },
  ];
}

export function planLanes({
  event,
  baseline = false,
  changes = [],
  tested = false,
  full = false,
  fresh = false,
  purchaseRelevant = false,
  purchaseOptIn = false,
  liveEmail = false,
}: {
  event: string;
  baseline?: boolean;
  changes?: string[];
  tested?: boolean;
  full?: boolean;
  fresh?: boolean;
  purchaseRelevant?: boolean;
  purchaseOptIn?: boolean;
  liveEmail?: boolean;
}) {
  const fullRun = event === "schedule" || full || fresh;
  const groups =
    tested && !fullRun
      ? []
      : fullRun || !baseline
        ? Object.keys(LANES)
        : changes;
  const lanes = [
    ...new Set(
      groups.flatMap((group) => group.replace(/\.\d+$/u, "").split("+")),
    ),
  ].sort();
  for (const lane of lanes) {
    if (!(lane in LANES)) throw new Error(`Unknown lane: ${lane}`);
  }
  const matrix = laneMatrix(lanes);
  const optional: MatrixEntry[] = [];
  if (purchaseRelevant || purchaseOptIn)
    optional.push({
      name: "E2E tests (purchase import agent, optional)",
      db: true,
      browser: "purchase-import",
      run: "pnpm exec nx run @cubby/web:e2e-purchase-import --outputStyle=stream",
    });
  if (event === "workflow_dispatch" && liveEmail)
    optional.push({
      name: "Live Email decisions (Jev and Clef, optional)",
      db: true,
      run: "MAIL_PROMPT_BASELINE_ONLY=1 pnpm --dir apps/web eval:mail-prompts",
    });
  const skips = ["rust", "apple-lint"].filter((lane) => !lanes.includes(lane));
  if (!lanes.includes("validation") && !lanes.includes("docs"))
    skips.push("validation");
  if (!matrix.length) skips.push("lanes");
  if (!lanes.includes("apple"))
    skips.push(
      "apple-environment",
      "apple-probe",
      "apple-host",
      "apple-simulator",
    );
  else if (fresh) skips.push("apple-environment", "apple-probe");
  return { lanes, matrix, optional, skips: skips.join(",") };
}

export function selectJourneys({
  journey,
  action,
  labels,
}: {
  journey: string;
  action: string;
  labels: string[];
}) {
  if (journey && !JOURNEYS.includes(journey))
    throw new Error(`Unknown journey: ${journey}`);
  const mode = action === "labeled" || journey ? "journeys" : "ci";
  const web = journey
    ? [
        "tester-army-web",
        "tester-army-both",
        "tester-army-all",
        "tester-army-visual",
        "tester-army-explore",
      ].includes(journey)
    : labels.includes("tester-army");
  const importing = journey
    ? ["tester-army-import", "tester-army-all"].includes(journey)
    : labels.includes("tester-army:import");
  const ios = journey
    ? ["tester-army-ios", "tester-army-both", "tester-army-all"].includes(
        journey,
      )
    : labels.includes("tester-army:ios");
  const entries = [];
  if (web)
    entries.push({
      lane: "web",
      harness: "standard",
      db: true,
      mode:
        journey === "tester-army-visual"
          ? "visual"
          : journey === "tester-army-explore"
            ? "explore"
            : "agent",
      timeout: journey ? 25 : 10,
      journeys: journey
        ? ""
        : "product-rename,receive-purchase,field-product-tags",
    });
  if (importing)
    entries.push({
      lane: "import",
      harness: "coupled",
      db: true,
      mode: "agent",
      timeout: 30,
      journeys: "",
    });
  const simulator = journey.startsWith("simulator-")
    ? journey.slice("simulator-".length)
    : !journey && labels.includes("simulator-e2e")
      ? "search"
      : "";
  return { mode, web: entries, ios, simulator };
}

function strings(raw: string | undefined): string[] {
  const value = JSON.parse(raw || "[]");
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  )
    throw new Error("Expected a JSON string array");
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const result =
    process.argv[2] === "journeys"
      ? {
          ...selectJourneys({
            journey: env.JOURNEY || "",
            action: env.ACTION || "",
            labels: strings(env.LABELS),
          }),
          ref: env.HEAD || env.GITHUB_SHA || "",
        }
      : planLanes({
          event: env.GITHUB_EVENT_NAME || "",
          baseline: !!env.BASE,
          changes: strings(env.CHANGES),
          tested: env.TESTED === "true",
          full: env.SCOPE === "full",
          fresh: env.FRESH === "true",
          purchaseRelevant: env.PURCHASE_RELEVANT === "true",
          purchaseOptIn: env.PURCHASE_OPT_IN === "true",
          liveEmail: env.LIVE_EMAIL === "true",
        });
  const output =
    Object.entries(result)
      .map(
        ([key, value]) =>
          `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
      )
      .join("\n") + "\n";
  if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(env.GITHUB_OUTPUT, output);
  console.log(output);
}
