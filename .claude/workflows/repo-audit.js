export const meta = {
  name: "repo-audit",
  description:
    "Full-repo audit: scoped lanes, adversarial verification, and a root-owned mechanical gate",
  whenToUse:
    "Full-repo multi-agent audit; run quarterly or after large refactors",
  phases: [
    { title: "Audit", detail: "11 scoped domain auditors" },
    { title: "Verify", detail: "adversarial refutation per finding" },
    {
      title: "Synthesize",
      detail: "opus/high ranks + writes report",
      model: "opus",
      effort: "high",
    },
  ],
};

// The workflow is launched from the selected repository root. Avoid embedding
// one developer's checkout so worktrees and other machines resolve correctly.
const ROOT = process.cwd();
const DEFAULT_REPORT_PATH = "/tmp/cubby-repo-audit-report.md";
const workflowArgs = globalThis.args;
const workflowArgsTag = Object.prototype.toString.call(workflowArgs);
const REPORT_PATH =
  (workflowArgsTag === "[object Object]" && workflowArgs.reportPath) ||
  (workflowArgsTag === "[object String]" && workflowArgs.trim()) ||
  DEFAULT_REPORT_PATH;
const ROOT_GATES = {
  owner: "root",
  commands: [
    "pnpm check",
    "cargo fmt --manifest-path recipebridge/Cargo.toml -- --check",
  ],
  result:
    "array of { command, status: pass|fail, output } with compact evidence",
};
const suppliedRootGateResults =
  workflowArgsTag === "[object Object]" ? workflowArgs.rootGateResults : null;
const rootGateResults =
  Array.isArray(suppliedRootGateResults) &&
  ROOT_GATES.commands.every((command) =>
    suppliedRootGateResults.some(
      (result) =>
        result?.command === command &&
        ["pass", "fail"].includes(result.status) &&
        Object.prototype.toString.call(result.output) === "[object String]",
    ),
  )
    ? suppliedRootGateResults
    : null;

const COMMON = `
You are auditing the cubby monorepo at ${ROOT}. It is a personal (single-user) pantry/recipe/meal-planning app: TanStack Start + tRPC + Drizzle/Postgres web app on Cloudflare Workers (apps/web), a Rust WASM crate (recipebridge), two smaller CF Workers (apps/upc-lookup, apps/usda-api), and shared packages (packages/*).

HARD RULES:
- NEVER look inside .claude/, node_modules/, target/, dist/, or generated files (routeTree.gen.ts, *.gen.*). Findings there are invalid.
- ${ROOT}/AGENTS.md and ${ROOT}/README.md document intentional conventions and explicit carve-outs. READ AGENTS.md FIRST. A finding that re-flags a documented carve-out or intentional decision is INVALID (e.g. raw useMutation at the 5 documented carve-out sites, restore-not-implemented for soft delete, raw <table> for matrices/debug surfaces, unsafe*Id at genuine string boundaries, dev-DB-is-prod-Neon).
- This is a single-user personal tool: skip multi-tenant, GDPR, rate-limit-per-user, and accessibility-for-others findings.
- Only report findings you VERIFIED by reading the actual code (not just grep hits). Include exact file path (relative to repo root) and line number.
- Severity honestly: critical = data loss / security hole / prod crash; high = real bug users hit; medium = latent bug or meaningful debt; low = polish. Do NOT inflate.
- Max 10 findings, quality over quantity. Return an empty list rather than padding.
`;

const FINDINGS_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        required: [
          "title",
          "file",
          "severity",
          "category",
          "description",
          "evidence",
        ],
        properties: {
          title: { type: "string" },
          file: { type: "string" },
          line: { type: "number" },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
          },
          category: { type: "string" },
          description: { type: "string" },
          evidence: {
            type: "string",
            description: "the actual code/output you saw that proves it",
          },
          suggestion: { type: "string" },
        },
      },
    },
    laneSummary: {
      type: "string",
      description: "2-3 sentence overall health assessment of this domain",
    },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  required: ["isReal", "severity", "note"],
  properties: {
    isReal: { type: "boolean" },
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    note: {
      type: "string",
      description: "one sentence: why confirmed or refuted",
    },
  },
};

const LANES = [
  {
    key: "security",
    model: "opus",
    effort: "high",
    codexModel: "gpt-6-astra",
    codexEffort: "high",
    prompt: `${COMMON}
LANE: Security audit.
Scope: apps/web/src/server (tRPC routers/procedures in server/api, auth middleware, MCP server in server/mcp, agent endpoints in server/agent, AI endpoints in server/ai), apps/upc-lookup, apps/usda-api.
Look for: missing auth checks on mutating tRPC procedures or server routes (compare against the _authenticated guard pattern); SQL injection (raw sql\`\` with interpolation in server/repo or server/db); secrets committed or logged; SSRF in URL-fetching endpoints (recipe scraping/import takes user URLs); unvalidated external input reaching the DB or WASM; MCP tools that bypass auth; overly permissive CORS. Auth is better-auth with passkeys — check the guard actually covers all mutation surfaces including MCP and /api routes.`,
  },
  {
    key: "server-correctness",
    model: "opus",
    effort: "high",
    codexModel: "gpt-6-astra",
    codexEffort: "high",
    prompt: `${COMMON}
LANE: Server-side correctness.
Scope: apps/web/src/server/repo, server/services, server/api (routers), background-queue.ts, queue-recompute.ts.
Look for: transaction boundaries that leave data inconsistent on partial failure (mutations doing multi-table writes outside withTransaction); soft-delete filters (notDeleted) missing from queries so deleted rows leak; race conditions in queue/recompute paths; error swallowing that hides failures; incorrect cascade logic on delete; mutation side-effect paths that skip runMutationSideEffects (orphaned embeddings pattern — see server/repo delete cascades); off-by-one / wrong-operator query predicates; places where noUncheckedIndexedAccess is silenced with ! on genuinely-reachable undefined.`,
  },
  {
    key: "client-correctness",
    model: "opus",
    effort: "high",
    codexModel: "gpt-6-astra",
    codexEffort: "high",
    prompt: `${COMMON}
LANE: Client/React correctness.
Scope: apps/web/src/app (413 files — prioritize _components, inventory, recipes, products), src/hooks, src/components.
Look for: hook-dependency bugs (stale closures, missing deps that cause real staleness, inline object/array literals passed to hooks with deps — the AGENTS.md infinite-loop pattern); useQueries without combine; effects that set state from unstable deps; race conditions in async handlers (setState after unmount, double-submit); optimistic-update rollback bugs; SSR/hydration branching on session or non-deterministic values (Date, locale) — the hydration-gate rule; forms that lose user input. Skip pure style issues.`,
  },
  {
    key: "architecture",
    model: "opus",
    effort: "high",
    codexModel: "gpt-6-astra",
    codexEffort: "high",
    prompt: `${COMMON}
LANE: Architecture & layering.
Read AGENTS.md's "Where logic lives", "Service vs. Direct Repo Boundary", and "Opaque Database Type" sections carefully — they define the rules.
Scope: apps/web/src (server + app), recipebridge/src, packages/schemas.
Look for: TS code reimplementing logic that recipebridge WASM owns (costing, availability, unit conversion, ingredient parsing/formatting — grep for suspicious unit-math or amount-formatting in TS and verify it is not just thin marshalling); *.service.ts files that are empty pass-throughs (violating the service-boundary rule) or routers doing orchestration a service should own; repo-layer code leaking above the boundary (getDb outside server/repo); duplicated domain logic between the MCP server (server/mcp) and tRPC routers that has already drifted or will; packages/* importing app-level code (dependency direction violations). For each finding state which documented rule it violates.`,
  },
  {
    key: "rust",
    model: "opus",
    effort: "high",
    codexModel: "gpt-6-astra",
    codexEffort: "high",
    prompt: `${COMMON}
LANE: Rust crate quality (recipebridge).
Scope: recipebridge/src (~3.3k lines), recipebridge/tests, recipebridge/Cargo.toml.
Rules from memory/AGENTS.md: no unwrap/expect/panic in prod code (CI-enforced clippy gate, tests exempt); tracing on the WASM hot path must be level=trace + skip_all (workerd CPU-leak incident); edition 2024.
Look for: unwrap/expect/panic/indexing that could panic in prod paths; #[tracing::instrument] on per-call functions at INFO/DEBUG or without skip_all; f64 accumulation bugs in costing math; unbounded recursion without cycle guards (sub-recipe graphs — there is a cycle-taint memo, check it is used everywhere recursion happens); serde/tsify boundary mismatches where a W* type diverges from the TS zod schema consuming it; allocation-heavy hot loops. The root owns mechanical commands; report only code evidence.`,
  },
  {
    key: "performance",
    model: "opus",
    effort: "high",
    codexModel: "gpt-6-astra",
    codexEffort: "high",
    prompt: `${COMMON}
LANE: Performance.
Scope: apps/web/src/server (repo queries, routers, services), apps/web/src/app list pages, apps/usda-api.
Known context: runs on Cloudflare Workers with strict cpu_ms limits and ~6-connection Hyperdrive limit; per-request pg.Pool max 5; Promise.all does NOT parallelize CPU on workerd; the workerd clock freezes during sync CPU so timing logs lie.
Look for: N+1 query patterns in repos (loop of awaited queries where one IN query works); missing pagination on unbounded list queries; queries selecting * / heavy jsonb columns (Recipe.totals) on list endpoints that do not need them; sequential awaits that should be Promise.all (real I/O, not CPU); missing DB indexes for hot predicates visible in schema.ts vs query patterns; oversized client bundles (heavy imports at route top-level that should be lazy); React list pages rendering unvirtualized huge lists. Verify each with actual code reading.`,
  },
  {
    key: "conventions",
    model: "sonnet",
    effort: "medium",
    codexModel: "gpt-5.6-terra",
    codexEffort: "medium",
    prompt: `${COMMON}
LANE: Convention drift.
Read the current AGENTS.md, docs/agents/domain-rules.md, and docs/agents/web-runtime.md before auditing. Respect their caveats and carve-outs; re-flagging an explicit carve-out is the #1 failure mode of this lane.
Scope: apps/web/src.
Look for genuinely NEW drift: inline patterns from the "avoid" column (manual insert+returning, error instanceof Error ladders, inline ilike, isNull(deletedAt), hand-rolled keyBy/groupBy, [...new Set()], switch-ladders on discriminated unions, inline query keys); hardcoded hex/oklch colors outside the exempt files (design-gallery.tsx, design.tsx, IsometricPantry.tsx, theme-color fallbacks); raw flex/grid/space-y div soup where Row/Stack/Grid/Section primitives should be used (only where the layout repeats or encodes a real decision — do NOT flag lone one-off flex divs, flex-col columns, responsive switches, inline-flex, or classNames on shadcn primitives); spacing-scale violations. Cross-check every candidate against the carve-out list before reporting.`,
  },
  {
    key: "deps-deadcode",
    model: "haiku",
    effort: "default",
    codexModel: "gpt-5.6-luna",
    codexEffort: "low",
    prompt: `${COMMON}
LANE: Dependency & dead-code hygiene.
Scope: all package.json files (root, apps/*, packages/*), Cargo.toml files, knip.json.
Look for: dependencies listed but never imported (spot-check with grep, do not trust memory); the same dep at conflicting versions across workspace packages; deps in dependencies that should be devDependencies for a Workers-deployed app; TODO/FIXME/HACK comments older than the code around them that reference completed work; exported functions/components with zero importers (verify with grep before claiming); scripts in package.json that reference files that no longer exist; .env.example keys that no code reads. Verify every claim with grep — a wrong dead-code claim wastes everyone's time.`,
  },
  {
    key: "tests",
    model: "opus",
    effort: "high",
    codexModel: "gpt-6-astra",
    codexEffort: "high",
    prompt: `${COMMON}
LANE: Test health & coverage gaps.
Scope: all *.test.ts / *.spec.ts / e2e files in apps/web, recipebridge/tests, vitest/playwright configs.
Look for: high-risk modules with zero test coverage (server/repo transactional mutations, the merge/recompute paths, MCP tool handlers, auth guard); tests that assert nothing meaningful (no assertions, or asserting mocks against mocks); disabled/skipped tests (.skip, .todo) hiding regressions; e2e tests not using the shared e2e-helpers.ts (documented convention); test fixtures drifting from current zod schemas; unit tests importing ~/ aliased .tsx into the node project (documented failure mode). Name the top 5 UNTESTED risk areas concretely (file + what could silently break) rather than generic 'add more tests'.`,
  },
  {
    key: "docs-ci",
    model: "haiku",
    effort: "default",
    codexModel: "gpt-5.6-luna",
    codexEffort: "low",
    prompt: `${COMMON}
LANE: Docs & CI accuracy.
Scope: README.md, AGENTS.md, docs/, .github/workflows/, scripts/, docker-compose.yml, .env.example.
Look for: README claims that contradict the actual code (commands that no longer exist in package.json, described routes/features that were removed — check docs mention any removed routes); CI workflow steps referencing deleted scripts or wrong paths; workflow jobs with continue-on-error that would mask failures (there was a past incident); stale docs/ files describing superseded designs without a superseded marker; broken relative links in markdown. Verify each claim against the actual file it references.`,
  },
  {
    key: "workers-apps",
    model: "opus",
    effort: "high",
    codexModel: "gpt-6-astra",
    codexEffort: "high",
    prompt: `${COMMON}
LANE: Cloudflare Workers apps & config.
Scope: apps/upc-lookup, apps/usda-api, apps/web wrangler config + cf-server.ts + cf-env.ts, packages/worker-tracing, packages/wasm.
Look for: floating promises (unawaited async without ctx.waitUntil — silently dropped on workerd); global mutable state shared across requests in a reused isolate (caches without bounds, per-request data leaking); missing error handling on D1/R2/KV calls; wrangler.toml/jsonc drift (bindings declared but unused, or code reading env keys not declared); compatibility-date issues; response streams not consumed/cancelled (connection leak); secrets read at module scope. The usda-api uses D1+R2; upc-lookup has a negative cache on a separate D1 needing db:migrate:remote on deploy — check migrations are consistent with schema.`,
  },
];

phase("Audit");
log(
  `Fanning out ${LANES.length} audit lanes with explicit model/effort assignments`,
);

const verifyFinding = (f, laneKey) =>
  agent(
    `You are an adversarial verifier for a repo audit of ${ROOT}. Your default stance: the finding is WRONG until the code proves it right.

Finding from the "${laneKey}" auditor:
- Title: ${f.title}
- File: ${f.file}${f.line ? ` line ${f.line}` : ""}
- Severity claimed: ${f.severity}
- Description: ${f.description}
- Evidence: ${f.evidence}

Steps:
1. Read the actual file(s) involved. If the file/line does not exist or does not contain what is claimed, refute.
2. Read ${ROOT}/AGENTS.md and check whether this is a documented carve-out or intentional decision (the file documents MANY: raw useMutation sites, raw <table> surfaces, unsafe*Id boundaries, soft-delete-no-restore, /* tight */ spacing, dev-DB-is-prod, etc.). If documented as intentional, refute.
3. Check whether the claimed failure actually happens on a reachable path (not dead code, not already guarded upstream).
4. This is a single-user personal app — refute findings only relevant at multi-user scale.
If uncertain after reading the code, set isReal=false. Also re-grade severity honestly if confirmed.`,
    {
      label: `verify:${laneKey}:${f.file.split("/").pop()}`,
      phase: "Verify",
      schema: VERDICT_SCHEMA,
      model: "opus",
      effort: "high",
    },
  ).then((v) => (v ? { ...f, lane: laneKey, verdict: v } : null));

const laneResults = await pipeline(
  LANES,
  (lane) => {
    const options = {
      label: `audit:${lane.key}`,
      phase: "Audit",
      schema: FINDINGS_SCHEMA,
      model: lane.model,
    };
    if (lane.effort !== "default") options.effort = lane.effort;
    return agent(lane.prompt, options);
  },
  (result, lane) => {
    if (!result)
      return { lane: lane.key, summary: "(lane failed)", findings: [] };
    const fs = (result.findings || []).slice(0, 10);
    log(`${lane.key}: ${fs.length} findings → verifying`);
    return parallel(fs.map((f) => () => verifyFinding(f, lane.key))).then(
      (vs) => ({
        lane: lane.key,
        summary: result.laneSummary || "",
        findings: vs.filter(Boolean),
      }),
    );
  },
);

const lanes = laneResults.filter(Boolean);
const confirmed = lanes.flatMap((l) =>
  l.findings
    .filter((f) => f.verdict.isReal)
    .map((f) => ({ ...f, severity: f.verdict.severity })),
);
const refuted = lanes.flatMap((l) =>
  l.findings.filter((f) => !f.verdict.isReal),
);
log(`Confirmed ${confirmed.length} findings, refuted ${refuted.length}`);

phase("Synthesize");
const report = await agent(
  `You are synthesizing a full-repo audit of the cubby monorepo (${ROOT}) into a final report. Every finding below was adversarially verified against the code.

ROOT MECHANICAL GATES:
${JSON.stringify(ROOT_GATES, null, 2)}

ROOT GATE RESULTS:
${JSON.stringify(rootGateResults, null, 2)}

If ROOT GATE RESULTS is null, the report must call the audit incomplete and put
the root-gate requirement in the Verdict and Scorecard. Do not imply that
mechanical validation ran. When results are present, render their compact raw
evidence as root-owned ground truth; do not adversarially verify it.

LANE SUMMARIES:
${JSON.stringify(
  lanes.map((l) => ({ lane: l.lane, summary: l.summary })),
  null,
  2,
)}

CONFIRMED FINDINGS (${confirmed.length}):
${JSON.stringify(confirmed, null, 2)}

REFUTED (for context on what was checked and cleared — do not include as issues):
${JSON.stringify(
  refuted.map((r) => ({ lane: r.lane, title: r.title, why: r.verdict.note })),
  null,
  2,
)}

Tasks:
1. Dedupe findings that describe the same underlying issue from different lanes (keep the best-evidenced one, note the overlap).
2. Spot-check any finding that looks dubious despite verification by reading the file yourself; drop it if it does not hold.
3. Write a markdown report to ${REPORT_PATH} with this structure:
   - "# Cubby Repo Audit" (include the run date if you can determine it from repo state; otherwise omit)
   - "## Verdict" — 3-4 sentence overall health assessment (this repo has strong conventions; be honest about whether the findings are serious or polish)
   - "## Scorecard" — table of the audit lanes plus root mechanical gates, with a letter grade (A-F) and one-line rationale each
   - "## Findings" — grouped by severity (Critical, High, Medium, Low), each finding: title, file:line as a code span, what/why, and a concrete fix. Number them F1, F2, ...
   - "## Cleared" — brief bullet list of notable things checked and found solid (from refuted list + lane summaries)
   - "## Suggested attack order" — a short prioritized punch list (what to fix first and why, grouping related fixes into single PRs)
4. Return as your final output a JSON-ish summary: the verdict paragraph, counts by severity, and the top 5 findings (title + file + severity) — the full report lives in the file.`,
  {
    label: "synthesize-report",
    phase: "Synthesize",
    model: "opus",
    effort: "high",
  },
);

return {
  reportPath: REPORT_PATH,
  complete: rootGateResults !== null,
  rootGateRequired: rootGateResults === null ? ROOT_GATES : null,
  confirmedCount: confirmed.length,
  refutedCount: refuted.length,
  laneSummaries: lanes.map((l) => ({
    lane: l.lane,
    summary: l.summary,
    confirmed: l.findings.filter((f) => f.verdict.isReal).length,
    refuted: l.findings.filter((f) => !f.verdict.isReal).length,
  })),
  synthesis: report,
};
