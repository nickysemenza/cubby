#!/usr/bin/env node
// @ts-check
/**
 * Regression-guard for cubby conventions. Runs in `pnpm check` alongside
 * biome + typecheck. No dependencies; uses git ls-files (falls back to a
 * recursive walk) so it only scans tracked source.
 *
 * Checks:
 *  1. Hardcoded chromatic Tailwind colors in apps/web/src tsx — protects the
 *     Phase 1 color sweep (use design tokens, never `text-red-500` etc.).
 *  2. Reintroduction of a TS `calculateTotals` costing engine — costing must
 *     stay in the Rust/WASM crate (recipebridge), never reimplemented in TS.
 *  3. Off-scale Tailwind spacing — gap/space/padding/margin must use the strict
 *     {1,2,4,6} scale. Exempts components/ui (design-system primitives), the
 *     UI primitives and any line marked `/* tight *\/` (intentional density).
 *  4. Response schema sidecars — list/detail/hydrated variants live in owning
 *     entity modules; do not reintroduce *-responses.ts files.
 *  5. Schema contract derivation — schema contract modules must not compose
 *     response/input variants via `.extend()`, `.shape`, `.pick()`, `.omit()`,
 *     or `.partial()`; use private field maps plus explicit exported schemas.
 *  6. Query invalidation boundaries — app code must use the typed helpers in
 *     apps/web/src/lib/query-keys.ts instead of raw React Query invalidation.
 *  7. Raw Tailwind shadow utilities (shadow-sm|md|lg|xl|2xl, drop-shadow) in
 *     apps/web/src tsx — the Warm-Paper Ledger is zero-shadow; separation is a
 *     border hairline. (Bracket `shadow-[var(--token)]` syntax is NOT matched,
 *     so surviving flattened tokens don't false-positive.)
 *  8. bg-gradient-to-* surface washes in apps/web/src tsx — the matte-paper
 *     system uses flat tones; the audit-log timeline fade connector is exempt.
 *  9. Arbitrary text-[Npx] font sizes — snap to the sub-xs tokens
 *     (text-2xs / text-3xs) so the type scale stays closed.
 * 10. Untested services — every server/services/*.service.ts needs a sibling
 *     test file (a fixed legacy exemption list may only shrink).
 * 11. getDb() used outside server/repo/ — the opaque-Database boundary
 *     (CLAUDE.md "Opaque Database Type") only permits the unwrap in repos.
 * 12. Dead package.json scripts — a `tsx <path>`/`node <path>` script entry
 *     whose path doesn't exist on disk.
 * 13. Unstable hook-destructure defaults — `const { data = [] } = useQuery(...)`
 *     style inline `[]`/`{}`/`new …` defaults mint a fresh reference every
 *     render whenever the value is undefined (loading / disabled queries),
 *     destabilizing downstream memo/effect deps (infinite-render-loop hazard;
 *     froze the labels page). Use a module-level constant instead.
 * 14. Adjacent equal `h-N w-N` / `w-N h-N` Tailwind pairs in apps/web tsx — use
 *     the `size-N` shorthand. Keeps icon sizing single-token and greppable (the
 *     density pass normalized ~540 of these). No exemptions.
 *
 * (Numbering above has already drifted — see the two blocks both labelled
 * "Rule 11" — so newer checks are referenced by slug, not number.)
 *
 * uuid-entity-href: a link to a shortcode-bearing entity's detail page built
 *     from a uuid — either the pre-cutover `$id` route param (`/products/$id`)
 *     or a server-side template literal (`/tasks/${row.id}`). Shortcodes are
 *     the public id; a uuid must never reach a URL. Most call sites are caught
 *     by the router's typed params, but two classes are NOT: stringly-typed
 *     paths, and hrefs built as strings on the server (repo/project/attention.ts
 *     shipped eight of these). `usda`/`images` are exempt — they are the two
 *     detail routes that legitimately key on something other than a shortcode.
 *
 * hand-rolled-array-overlap: `&& ${arr}` in a raw `sql` template inside
 *     server/repo/ — drizzle interpolates a JS array into raw SQL as a ROW
 *     CONSTRUCTOR (`&& ($1, $2)`), not a `text[]`, so `sql`${col} && ${arr}``
 *     silently matches nothing at every input size. Use `arrayOverlaps(col,
 *     arr)` instead (see CLAUDE.md / dashboard-shared.ts).
 *
 * raw-control-byte: a literal C0 control character in tracked source (tab, LF
 *     and CR excepted). Written as a raw byte rather than an escape, it makes
 *     the whole file BINARY to the grep family — `file` reports "data", ripgrep
 *     skips it, and `grep -c` returns nothing for a symbol `git grep` finds 16
 *     times. Two `\0` composite-key separators did that to a 1,776-line repo
 *     file; nothing caught it, because this script and its siblings read via
 *     `git ls-files` + `readFileSync` and are unaffected, and in a diff a raw
 *     NUL renders as a space.
 *
 * strict-router-output: explicit tRPC router output schemas must be wrapped in
 *     `strictOutput(...)`. tRPC otherwise checks the resolver against the Zod
 *     schema's input type; shortcode brands exist only in its parsed output, so
 *     a UUID brand is still assignable to the accepted plain string.
 *
 * fixed-table-column-width: a static UI `<Table>` using the primitive's
 *     default fixed layout must give every `<TableHead>` an unconditional
 *     `w-*` class. An unsized or conditionally-unsized head can collapse to
 *     zero while its nowrap content paints over adjacent columns. Explicit
 *     `table-auto` tables and the dynamic TanStack `<RTable>` orchestrator are
 *     exempt because they own sizing through different contracts.
 *
 * Exit 1 + a report on any violation; exit 0 + one-line OK when clean.
 */

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webSrc = join(repoRoot, "apps", "web", "src");
const upcLookupSrc = join(repoRoot, "apps", "upc-lookup", "src");
const schemasSrc = join(repoRoot, "packages", "schemas", "src");
const servicesDir = join(webSrc, "server", "services");

/** @returns {string[]} absolute paths */
function gitTrackedSources() {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "apps/web/src/**/*.tsx",
      "apps/web/src/**/*.ts",
      "apps/upc-lookup/src/**/*.ts",
      "packages/schemas/src",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((p) => join(repoRoot, p));
}

/** Recursive fallback if git is unavailable. @returns {string[]} */
function walk(dir: string): string[] {
  /** @type {string[]} */
  const found = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) found.push(...walk(full));
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) found.push(full);
  }
  return found;
}

function listFiles() {
  try {
    const files = gitTrackedSources();
    if (files.length > 0) return files;
  } catch {
    // fall through to walk
  }
  try {
    return [...walk(webSrc), ...walk(upcLookupSrc), ...walk(schemasSrc)];
  } catch {
    return [];
  }
}

// Files allowed to use raw chromatic colors for authored illustration paint.
const COLOR_EXCLUDE_BASENAMES = new Set([
  "IsometricPantry.tsx",
]);

const COLOR_RE =
  /\b(text|bg|border|ring|from|to|via|fill|stroke|decoration|outline)-(red|green|amber|yellow|emerald|rose|orange|lime|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink)-[0-9]{2,3}\b/;

// Raw Tailwind box-shadow / drop-shadow utilities. The ledger is zero-shadow:
// card separation is a `border border-[var(--border)]` hairline, not elevation.
// Word-boundary + explicit named steps so the legit bracket-arbitrary token
// syntax `shadow-[var(--token)]` (and bare `shadow`/`shadow-none`) don't match.
const SHADOW_RE = /\b(shadow-(sm|md|lg|xl|2xl)|drop-shadow)\b/;

// bg-gradient-to-* surface washes fight the matte-paper system — use a flat
// tone (e.g. bg-muted/30). The one deliberate gradient is the audit-log
// timeline fade connector, exempted by basename below.
const GRADIENT_RE = /\bbg-gradient-to-[a-z]/;

// Files allowed a deliberate gradient (the audit-log timeline fade hairline is
// a fade-out connector, not a surface wash).
const GRADIENT_EXCLUDE_BASENAMES = new Set(["audit-log-entry.tsx"]);

// Arbitrary text-[Npx] font sizes bypass the closed type scale. The sub-xs
// steps have tokens: text-[8px]→text-3xs, text-[9/10/11px]→text-2xs.
const TEXT_PX_RE = /\btext-\[[0-9]+px\]/;

// A `<NoneValue />` reached through a TRUTHINESS test rather than a null check.
//
// `NoneValue` renders the muted `—`, which this codebase reserves for "we do not
// know". Gating it on truthiness hands that marker to `0`, `false`, and `""`
// as well — all of which are values somebody recorded. That is how a genuine
// $0 warranty replacement, a product reviewed as deliberately not stock-tracked,
// and a shelf with zero bins in service all came to display as "unknown", and how
// `expense.future === false` became visually identical to a decision never made.
// `view-manifest.ts` states the rule the other way round: "a dash reads as
// 'unknown' when the actual fact is 'none'".
//
// Matches `x ? … : <NoneValue`, `x ? <NoneValue`, and `x || <NoneValue`, but not
// `x != null ? …` / `x == null ? …` / `x === null` — an explicit null test is the
// fix, so it must not trip the rule.
const FALSY_NONE_VALUE_RE =
  /(?:\?|\|\|)[^?]*<NoneValue|<NoneValue\s*\/>\s*\)?\s*:/;
const NULL_CHECKED_RE = /[!=]==?\s*(?:null|undefined)|isNil|\?\?/;

// Adjacent equal height/width Tailwind pairs (`h-4 w-4`, `w-3.5 h-3.5`) — the
// `size-4` shorthand is the single-token form. The backreference enforces the
// numbers are EQUAL and the two branches enforce one h + one w, so unequal
// pairs (`h-4 w-full`) and same-axis noise (`h-4 h-4`) don't match.
const HW_PAIR_RE =
  /\bh-(\d+(?:\.\d+)?)\s+w-\1\b|\bw-(\d+(?:\.\d+)?)\s+h-\2\b/;

// An icon glyph inside a DropdownMenuItem carrying its own margin/size. The
// primitive supplies gap-2 and a size-3.5 icon default, so these only ever
// duplicate the gap or enlarge the glyph past what the shared row-action
// column renders.
const MENU_ITEM_ICON_RE =
  /className="(?:mr-2 size-[\d.]+|size-[\d.]+ mr-2|mr-2|size-[\d.]+)"/;

/**
 * Labels declared in the action-verb registry, read from source so the guard
 * can't fall behind it. A verb whose wording lives in one place is the whole
 * point — Print Label previously shipped in three casings with four icons.
 */
const ACTION_VERBS_PATH = "apps/web/src/app/_components/actions/action-verbs.ts";
/**
 * The visible text of a menu-item line, with JSX tags and `{…}` expressions
 * stripped.
 *
 * Comparing the raw trimmed line only caught a label sitting alone on its own
 * line — the shape every converted site happens to use. A single-line
 * `<DropdownMenuItem><Trash /> Delete</DropdownMenuItem>` would have walked
 * straight past the rule it exists to enforce.
 */
const menuItemText = (line: string) =>
  line
    // Braces FIRST. `<[^>]*>` stops at the first `>`, so an attribute holding
    // one — `onSelect={() => x()}`, `disabled={x > 0}` — truncates the tag
    // strip and leaves the label glued to attribute debris, re-opening the
    // single-line hole this rule exists to close. Removing the brace
    // expressions first makes the tag strip unambiguous.
    .replace(/\{[^}]*\}/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.\.\.$/, "")
    .trim()
    .toLowerCase();

const actionVerbLabelSet = (() => {
  try {
    const src = readFileSync(join(repoRoot, ACTION_VERBS_PATH), "utf8");
    const body = src.slice(src.indexOf("export const actionVerbs"));
    return new Set(
      [...body.matchAll(/label:\s*"([^"]+)"/g)].flatMap((m) =>
        m[1] ? [m[1].replace(/\.\.\.$/, "").trim().toLowerCase()] : [],
      ),
    );
  } catch (error) {
    // Not a soft failure: an empty set makes the rule below match nothing and
    // pass vacuously, which is exactly how a guard rots unnoticed.
    throw new Error(
      `check-conventions: could not read action verbs from ${ACTION_VERBS_PATH}: ${error}`,
    );
  }
})();

// Hand-rolled `&& ${arr}` array-overlap in a raw `sql` template — drizzle
// interpolates a JS array into raw SQL as a ROW CONSTRUCTOR (`&& ($1, $2)`),
// not a `text[]`, so this silently matches nothing at every input size. This
// exact trap shipped in project/dashboard-shared.ts's location filter and
// recipe/crud.ts's tag filter before both were fixed to use `arrayOverlaps`.
// Deliberately loose (just `&&` followed by an interpolation) so it catches
// the pattern regardless of which side the array is on or what's inside the
// `sql` tag.
const HAND_ROLLED_ARRAY_OVERLAP_RE = /&&\s*\$\{/;

// The same row-constructor trap through `= ANY(${arr})`. Here it doesn't
// silently mismatch — postgres rejects `ANY(($1, $2))` outright ("op ANY/ALL
// requires array"), so every list call carrying the filter 500s, including the
// single-value form (`ANY(($1))`). This shipped on the financial-transaction
// `kind`/`status` filters, the financial-account `identityKind` filter, and the
// product picker's semantic-fallback id lookup. Use `eqAny`/`inArray` for a
// column, `matchesStringValues` for a SQL expression such as a jsonb field.
//
// Content-level (not per-line), like `unstable-hook-default`: a long `sql`
// template can be wrapped so `ANY(` and `${...}` land on different lines, and a
// per-line scan would wave that through.
// `uuidArrayParam(...)` is exempt: it is the single audited constructor for a
// bound array parameter (a Postgres array LITERAL bound as one text value and
// cast in SQL), so the row-constructor shape is unreachable through it. Any
// other interpolation still fails.
const HAND_ROLLED_ANY_ARRAY_RE = /\bANY\s*\(\s*\$\{(?!uuidArrayParam\()/g;

// An explicit router output without the parsed-output type narrowing. The empty
// `.output()` spelling in prose is excluded so comments do not false-positive.
const LOOSE_ROUTER_OUTPUT_RE = /\.output\((?!\s*(?:\)|strictOutput\())/g;

// Detail routes whose param is a shortcode. `usda` keys on an external fdc id
// and `images` on a uuid (image is the one entity with no public shortcode), so
// both are absent here rather than exempted case-by-case below.
const SHORTCODE_ROUTE_BASES = [
  "products",
  "recipes",
  "locations",
  "ingredients",
  "inventory",
  "meals",
  "projects",
  "tasks",
  "expenses",
  "purchases",
  "vendors",
  "cookbooks",
].join("|");

// `/products/$id` — the pre-cutover param name, including cookbook's old
// `$cookbookId` spelling. After the rename the only valid param is `$shortcode`
// (or `$shortcode_`, TanStack's "don't nest under the parent" suffix).
const UUID_ROUTE_PARAM_RE = new RegExp(
  `/(?:${SHORTCODE_ROUTE_BASES})/\\$(?!shortcode[_/"\`]|shortcode$)[A-Za-z]`,
);

// `/tasks/${row.id}` — a hand-built href, invisible to the router's types. An
// interpolation that names a shortcode is the correct shape and passes.
const UUID_TEMPLATE_HREF_RE = new RegExp(
  `/(?:${SHORTCODE_ROUTE_BASES})/\\$\\{(?![^}]*[Ss]hortcode)[^}]*\\}`,
);

// The same bug with a VARIABLE base: `/${entities[e].basePath}/${result.id}`.
// The literal-base regex above can't see these, and this exact shape shipped a
// create flow that navigated to a uuid URL — caught only by an E2E ZodError.
const UUID_BASEPATH_HREF_RE = /basePath\}\/\$\{(?![^}]*[Ss]hortcode)[^}]*\}/;

// The old deleted TS costing engine. Test fixtures/helpers legitimately wrap
// the WASM engine under this name, so exempt test + fixture files.
const CALC_TOTALS_RE = /\bfunction\s+calculateTotals\b|\bcalculateTotals\s*=/;

// Off-scale Tailwind spacing: gap / gap-x|y / space-x|y / p*/m* (+ directional).
// We flag the odd/half "rhythm drift" steps (1.5, 2.5, 3, 5, 7, 9, …) — the long
// tail that made spacing feel inconsistent. The scale itself is the doublings
// {0,1,2,4,6} plus the legit large steps {8,12,16,20} (wide gutters, big touch
// targets, hero padding), which are allowed. Arbitrary `-[…]` values and
// non-spacing utilities (h-/w-/top-) aren't matched.
const SPACING_RE =
  /\b(gap(-[xy])?|space-[xy]|[pm][xytblr]?)-(0\.5|1\.5|2\.5|3|3\.5|5|7|9|10|11|13|14)\b/;

const SCHEMA_DERIVATION_RE =
  /\.(extend|pick|omit|partial)\s*\(|\.shape\b/;

const DIRECT_QUERY_INVALIDATION_RE =
  /\bqueryClient\.(invalidateQueries|cancelQueries)\s*\(/;

const RESPONSE_FIELD_MAP_RE =
  /\b(?:const|let|var)\s+\w*(?:ResponseFields|responseFields)\b/;

const LOOSE_SORT_PAGINATION_RE = /\.\.\.sortPaginationFields\b/;

// components/ui and components/reui hold copied third-party primitives whose
// internal layout/accessibility implementation is maintained as vendored source.
function isUiPrimitive(path: string) {
  return (
    path.includes("/components/ui/") || path.includes("/components/reui/")
  );
}

function isCommentLine(line: string) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function basename(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function isTestOrFixture(path: string) {
  const b = basename(path);
  return (
    b.includes(".test.") ||
    b.includes(".spec.") ||
    b.includes(".fixtures.") ||
    b.includes(".fixture.")
  );
}

function isResponseSidecar(path: string) {
  const rel = relative(repoRoot, path);
  return rel.startsWith("packages/schemas/src/") && rel.endsWith("-responses.ts");
}

function isSchemaContractFile(path: string) {
  const rel = relative(repoRoot, path);
  if (!rel.endsWith(".ts") || rel.endsWith(".unit.test.ts")) return false;
  if (rel.startsWith("packages/schemas/src/")) return true;
  return (
    rel.startsWith("apps/upc-lookup/src/schemas/") ||
    rel.startsWith("apps/upc-lookup/src/openapi")
  );
}

function isQueryKeyHelperFile(path: string) {
  return relative(repoRoot, path) === "apps/web/src/lib/query-keys.ts";
}

function isPaginationHelperFile(path: string) {
  return relative(repoRoot, path) === "packages/schemas/src/pagination.ts";
}

function isCrudFactoryFile(path: string) {
  return relative(repoRoot, path) === "apps/web/src/server/api/crud-factory.ts";
}

function isRouterFile(path: string) {
  return relative(repoRoot, path).startsWith(
    "apps/web/src/server/api/routers/",
  );
}

// Rule 10: legacy services with no test yet. This list may only SHRINK (a
// service gaining tests should be removed here, never re-added) — see
// CLAUDE.md Required Helpers / audit F4-F5 follow-up.
const SERVICE_TEST_EXEMPTIONS = new Set([
  "ingredient.service.ts",
  "product.service.ts",
  "problems.service.ts",
  "location-valuation.service.ts",
]);

function checkServicesHaveTests(): Violation[] {
  const violations: Violation[] = [];
  let entries;
  try {
    entries = readdirSync(servicesDir);
  } catch {
    return violations;
  }
  const serviceFiles = entries.filter((f) => f.endsWith(".service.ts"));
  for (const serviceFile of serviceFiles) {
    if (SERVICE_TEST_EXEMPTIONS.has(serviceFile)) continue;
    const stem = serviceFile.slice(0, -".service.ts".length);
    const hasTest = entries.some(
      (f) => f !== serviceFile && f.startsWith(`${stem}.`) && f.endsWith(".test.ts"),
    );
    if (!hasTest) {
      violations.push({
        file: join(servicesDir, serviceFile),
        line: 1,
        snippet: serviceFile,
        rule: "service-needs-test",
      });
    }
  }
  return violations;
}

// Rule 11: getDb() unwraps the opaque Database type — CLAUDE.md "Opaque
// Database Type" restricts that unwrap to server/repo/. No exemptions: the
// one prior offender (a dev debug route) was fixed by moving the getDb call
// behind a repo helper.
const GETDB_RE = /\bgetDb\b/;

function isRepoFile(path: string) {
  return relative(repoRoot, path).startsWith("apps/web/src/server/repo/");
}

// Rule 12: package.json scripts referencing a `tsx <path>`/`node <path>` file
// that doesn't exist on disk (relative to that package's directory).
const SCRIPT_TARGET_RE = /\b(?:tsx|node)\s+([^\s"']+\.(?:ts|mjs|js))\b/g;

function checkPackageScriptTargets(): Violation[] {
  const violations: Violation[] = [];
  let packageJsonPaths;
  try {
    const out = execFileSync("git", ["ls-files", "*package.json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    packageJsonPaths = out
      .split("\n")
      .filter(Boolean)
      .filter((p) => !p.includes("node_modules/"))
      .map((p) => join(repoRoot, p));
  } catch {
    return violations;
  }

  for (const pkgPath of packageJsonPaths) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    const scripts = pkg.scripts;
    if (!scripts || typeof scripts !== "object") continue;
    const pkgDir = dirname(pkgPath);

    for (const [scriptName, command] of Object.entries(scripts)) {
      if (typeof command !== "string") continue;
      for (const match of command.matchAll(SCRIPT_TARGET_RE)) {
        const targetPath = match[1];
        if (!targetPath) continue;
        const resolved = resolve(pkgDir, targetPath);
        if (!existsSync(resolved)) {
          violations.push({
            file: pkgPath,
            line: 1,
            snippet: `"${scriptName}": "${command}"`,
            rule: "script-target-exists",
          });
        }
      }
    }
  }
  return violations;
}

// Rule 13: inline fresh-object defaults (`= []`, `= {}`, `= new X(...)`) in an
// object destructure of a hook result. When the underlying value is undefined
// (query loading/disabled, optional hook data) the default allocates a NEW
// reference every render, silently destabilizing every memo/effect keyed on it
// — the labels-page freeze was exactly this. Use a module-level constant
// (`const NO_ROWS: never[] = []`) as the default instead. Content-level (not
// per-line) because the destructure regularly spans lines after formatting.
const UNSTABLE_HOOK_DEFAULT_RE =
  /const\s*\{[^{}]*?=\s*(?:\[\]|\{\}|new\s+[A-Z][\w.]*\s*\([^)]*\))[^{}]*?\}\s*=\s*use[A-Z]\w*\s*\(/g;

// Rule 13b: the same hazard one position over — a fresh-object default on a
// DESTRUCTURED PARAMETER of a component or hook (`function C({ edges = [] })`,
// `useTableState({ initialFilter = [] })`). Every caller that omits the prop
// gets a new reference per render, so any memo/effect keyed on it re-runs
// unconditionally. That is usually just wasted work — but in `useTableState`
// it re-ran the URL-reconciliation effect on every render, which then read a
// stale search mid-write and reverted the filters a saved view had just set.
//
// Flagged ONLY when the identifier also appears inside a dependency array in
// the same file. Without that filter this fires on every server helper and
// render-only prop with a defaulted array, which is genuinely fine — the
// hazard is the dependency, not the default.
// `new Set<string>()` — the generic argument sits between the name and the
// call, so it has to be optional here or the `new …` arm misses every typed
// collection (which is most of them).
const UNSTABLE_PARAM_DEFAULT_RE =
  /([A-Za-z_$][\w$]*)\s*=\s*(?:\[\]|\{\}|new\s+[A-Z][\w.]*\s*(?:<[^<>()]*>)?\s*\([^)]*\))\s*,/g;

/**
 * `}, [a, b, c])` / `], [a, b])` — a hook dependency array's contents. The
 * trailing comma is optional because the formatter adds one on a wrapped call.
 */
const DEPENDENCY_ARRAY_RE = /[}\])]\s*,\s*\[([^\]]*)\]\s*,?\s*\)/g;

/** Identifiers named in any dependency array in this file. */
function dependencyIdentifiers(content: string) {
  const names = new Set();
  for (const match of content.matchAll(DEPENDENCY_ARRAY_RE)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part.trim().split(/[.?[]/)[0]?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

// `<Image>` (~/components/ui/image) only rewrites an R2 URL through Cloudflare
// Image Transformations when it's told the rendered width — omit `displayWidth`
// and the full-size original is served into whatever box the className sets.
// That's how the locations gallery ended up pulling 1.8MB photos into 32px
// tiles. Matches the component exactly, so ImageThumbnail / ImageWithPreview /
// ImageOff don't trip it. Passing the prop on a non-bucket URL is a harmless
// no-op, which is why this needs no per-site allowlist.
const IMAGE_ELEMENT_RE = /<Image(?=[\s/>])/g;

/**
 * The prop-list source of a JSX element starting at `open` (the `<`), i.e. up to
 * the first `>` at brace-depth 0 and outside a quoted JSX value. Tracking `{}`
 * depth is what keeps an arrow function (`=>`) or a nested element
 * (`fallback={<Icon />}`) in a prop from ending the scan early. Quotes matter
 * too: literal `>` and braces are ordinary attribute text, not JSX structure.
 *
 */
function jsxOpeningTag(content: string, open: number): string {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = open; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return content.slice(open, i + 1);
  }
  return content.slice(open);
}

const WIDTH_CLASS_RE = /(?:^|[\s"'`])w-(?:\[[^\]]+\]|[^\s"'`]+)/;

/**
 * The raw source of one JSX attribute value, including its quotes/braces.
 * Returns null when the attribute is absent.
 *
 * @param {string} tag @param {string} name @returns {string | null}
 */
function jsxAttributeValue(tag: string, name: string) {
  const match = new RegExp(`\\b${name}\\s*=`).exec(tag);
  if (!match) return null;
  let index = (match.index ?? 0) + match[0].length;
  while (/\s/.test(tag[index] ?? "")) index++;
  const opener = tag[index];
  if (opener === '"' || opener === "'") {
    let escaped = false;
    for (let i = index + 1; i < tag.length; i++) {
      const ch = tag[i];
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === opener) return tag.slice(index, i + 1);
    }
    return tag.slice(index);
  }
  if (opener !== "{") return null;

  let depth = 0;
  /** @type {'"' | "'" | "`" | null} */
  let quote = null;
  let escaped = false;
  for (let i = index; i < tag.length; i++) {
    const ch = tag[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return tag.slice(index, i + 1);
  }
  return tag.slice(index);
}

/**
 * Find a top-level conditional expression's two value branches. This is
 * deliberately small JSX-source parsing rather than a regex so quoted `?`/`:`
 * text and nested calls do not change the result.
 *
 * @param {string} expression @returns {[string, string] | null}
 */
function topLevelConditionalBranches(expression: string) {
  let question = -1;
  let nestedQuestions = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  /** @type {'"' | "'" | "`" | null} */
  let quote = null;
  let escaped = false;

  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") round++;
    else if (ch === ")") round--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === "{") curly++;
    else if (ch === "}") curly--;
    else if (round === 0 && square === 0 && curly === 0) {
      if (ch === "?") {
        if (question === -1) question = i;
        else nestedQuestions++;
      } else if (ch === ":" && question !== -1) {
        if (nestedQuestions > 0) nestedQuestions--;
        else
          return [
            expression.slice(question + 1, i),
            expression.slice(i + 1),
          ];
      }
    }
  }
  return null;
}

/**
 * Split a `cn(...)`/`clsx(...)` call into top-level arguments. Nested calls and
 * quoted commas stay inside their argument.
 *
 * @param {string} expression @returns {string[] | null}
 */
function topLevelClassArguments(expression: string) {
  const call = /^(?:cn|clsx)\s*\(/.exec(expression);
  if (!call || !expression.endsWith(")")) return null;
  const body = expression.slice(call[0].length, -1);
  const arguments_ = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  /** @type {'"' | "'" | "`" | null} */
  let quote = null;
  let escaped = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") round++;
    else if (ch === ")") round--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === "{") curly++;
    else if (ch === "}") curly--;
    else if (ch === "," && round === 0 && square === 0 && curly === 0) {
      arguments_.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  arguments_.push(body.slice(start).trim());
  return arguments_;
}

/** @param {string} expression @returns {boolean} */
function expressionHasUnconditionalWidth(expression: string): boolean {
  const branches = topLevelConditionalBranches(expression);
  if (branches)
    return branches.every((branch) =>
      expressionHasUnconditionalWidth(branch.trim()),
    );

  const arguments_ = topLevelClassArguments(expression);
  if (arguments_)
    return arguments_.some((argument) =>
      expressionHasUnconditionalWidth(argument),
    );

  const widthIndex = expression.search(WIDTH_CLASS_RE);
  if (widthIndex === -1) return false;
  const conjunction = expression.indexOf("&&");
  return conjunction === -1 || widthIndex < conjunction;
}

/** @param {string} source @returns {boolean} */
function hasUnconditionalWidthClass(source: string) {
  const value = jsxAttributeValue(source, "className");
  if (!value) return false;
  if (value[0] === '"' || value[0] === "'")
    return WIDTH_CLASS_RE.test(value.slice(1, -1));

  const expression = value.slice(1, -1).trim();
  return expressionHasUnconditionalWidth(expression);
}

/** @param {string} tableTag @returns {boolean} */
function hasUnconditionalTableAuto(tableTag: string) {
  const value = jsxAttributeValue(tableTag, "className");
  if (!value) return false;
  if (value[0] === '"' || value[0] === "'")
    return /(?:^|\s)table-auto(?:\s|$)/.test(value.slice(1, -1));
  const expression = value.slice(1, -1).trim();
  const autoIndex = expression.indexOf("table-auto");
  const conjunction = expression.indexOf("&&");
  return autoIndex !== -1 && (conjunction === -1 || autoIndex < conjunction);
}

/**
 * Offsets of fixed-layout table heads that can render without a width.
 *
 */
function fixedTableColumnWidthViolations(
  content: string,
  dynamicOrchestrator = false,
): Array<{ index: number; tag: string }> {
  if (dynamicOrchestrator) return [];
  const violations: Array<{ index: number; tag: string }> = [];
  for (const tableMatch of content.matchAll(/<Table(?=[\s>])/g)) {
    const tableIndex = tableMatch.index ?? 0;
    const line = content.slice(0, tableIndex).split("\n").at(-1) ?? "";
    if (isCommentLine(line)) continue;
    const tableTag = jsxOpeningTag(content, tableIndex);
    if (hasUnconditionalTableAuto(tableTag)) continue;
    const close = content.indexOf("</Table>", tableIndex + tableTag.length);
    if (close === -1) continue;
    const body = content.slice(tableIndex + tableTag.length, close);
    for (const headMatch of body.matchAll(/<TableHead(?=[\s/>])/g)) {
      const headIndex =
        tableIndex + tableTag.length + (headMatch.index ?? 0);
      const headTag = jsxOpeningTag(content, headIndex);
      if (!hasUnconditionalWidthClass(headTag))
        violations.push({ index: headIndex, tag: headTag });
    }
  }
  return violations;
}

// Keep this parser's edge cases adjacent to the guard it protects. The script
// is dependency-free and runs in CI, so these regressions run with every scan.
const jsxOpeningTagCases: Array<[source: string, expected: string]> = [
  [
    '<Image alt="{" displayWidth={32} /><div />',
    '<Image alt="{" displayWidth={32} />',
  ],
  [
    '<Image alt="literal > with { braces }" displayWidth={32} />',
    '<Image alt="literal > with { braces }" displayWidth={32} />',
  ],
  [
    "<Image alt='literal > with { braces }' displayWidth={32} />",
    "<Image alt='literal > with { braces }' displayWidth={32} />",
  ],
  [
    String.raw`<Image alt="an escaped quote: \" > { }" displayWidth={32} />`,
    String.raw`<Image alt="an escaped quote: \" > { }" displayWidth={32} />`,
  ],
];
for (const [source, expected] of jsxOpeningTagCases) {
  assert.equal(jsxOpeningTag(source, 0), expected);
}

const fixedTableCases: Array<[source: string, dynamicOrchestrator: boolean, expected: number]> = [
  [
    '<Table><TableHead className="w-40">Name</TableHead></Table>',
    false,
    0,
  ],
  ['<Table><TableHead>Name</TableHead></Table>', false, 1],
  ['<Table className="table-auto"><TableHead>Name</TableHead></Table>', false, 0],
  [
    '<Table><TableHead className={raw ? "w-[30%]" : "w-1/2"}>Name</TableHead></Table>',
    false,
    0,
  ],
  [
    '<Table><TableHead className={raw && "w-[30%]"}>Name</TableHead></Table>',
    false,
    1,
  ],
  [
    '<Table><TableHead className={cn(selected && "bg-muted", "w-40")}>Name</TableHead></Table>',
    false,
    0,
  ],
  [
    '<Table><TableHead className={cn(selected && "w-40", "bg-muted")}>Name</TableHead></Table>',
    false,
    1,
  ],
  ['<Table><TableHead className={styles.header}>Name</TableHead></Table>', true, 0],
];
for (const [source, dynamicOrchestrator, expected] of fixedTableCases) {
  assert.equal(
    fixedTableColumnWidthViolations(source, dynamicOrchestrator).length,
    expected,
    source,
  );
}

type Violation = { file: string; line: number; snippet: string; rule: string };

function scan(files: string[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    if (file.includes("/components/reui/")) continue;
    const isTsx = file.endsWith(".tsx");
    const base = basename(file);
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    // Reset per file: the icon rule below only fires between a
    // <DropdownMenuItem and its closing tag.
    let dropdownItemDepth = 0;

    // Rule (fixed-table-column-width): fixed-layout static tables need a real
    // width on every rendered head. `table-auto` explicitly chooses intrinsic
    // content sizing; the TanStack orchestrator derives dynamic widths.
    if (
      isTsx &&
      !isTestOrFixture(file) &&
      content.includes('from "~/components/ui/table"')
    ) {
      const isDynamicTableOrchestrator = relative(repoRoot, file) ===
        "apps/web/src/app/_components/data-table/Table.tsx";
      for (const finding of fixedTableColumnWidthViolations(
        content,
        isDynamicTableOrchestrator,
      )) {
        violations.push({
          file,
          line: content.slice(0, finding.index).split("\n").length,
          snippet: finding.tag.replaceAll(/\s+/g, " ").slice(0, 120),
          rule: "fixed-table-column-width",
        });
      }
    }

    // Rule (untransformed-image): an <Image> that never declares its rendered
    // width. Content-level — the prop list spans lines.
    if (isTsx && !isTestOrFixture(file)) {
      for (const match of content.matchAll(IMAGE_ELEMENT_RE)) {
        const tag = jsxOpeningTag(content, match.index);
        if (/\bdisplayWidth\b/.test(tag)) continue;
        violations.push({
          file,
          line: content.slice(0, match.index).split("\n").length,
          snippet: tag.replaceAll(/\s+/g, " ").slice(0, 120),
          rule: "untransformed-image",
        });
      }
    }

    // Rule 13: unstable hook-destructure defaults (content-level — the
    // destructure can span lines). Tests are exempt like the other rules.
    if (!isTestOrFixture(file)) {
      for (const match of content.matchAll(UNSTABLE_HOOK_DEFAULT_RE)) {
        const line = content.slice(0, match.index).split("\n").length;
        violations.push({
          file,
          line,
          snippet: match[0].replaceAll(/\s+/g, " ").slice(0, 120),
          rule: "unstable-hook-default",
        });
      }

      // Rule 13b: the parameter-position form, narrowed to identifiers this
      // file actually feeds to a dependency array.
      const deps = dependencyIdentifiers(content);
      if (deps.size > 0) {
        for (const match of content.matchAll(UNSTABLE_PARAM_DEFAULT_RE)) {
          const name = match[1];
          if (!name || !deps.has(name)) continue;
          const line = content.slice(0, match.index).split("\n").length;
          if (isCommentLine(lines[line - 1] ?? "")) continue;
          violations.push({
            file,
            line,
            snippet: (lines[line - 1] ?? "").trim(),
            rule: "unstable-param-default",
          });
        }
      }
    }

    // Rule (raw-control-byte): a literal C0 control character in source.
    // Written as a raw byte rather than an escape (`\0`), it makes the whole
    // file BINARY to the grep family: `file` reports "data", ripgrep skips it,
    // and `grep -c` returns nothing for a symbol `git grep` finds 16 times.
    // Two composite-key separators did exactly that to a 1,776-line repo file,
    // and nothing caught it — this script and its siblings read via
    // `git ls-files` + `readFileSync`, so they were unaffected, and in a diff a
    // raw NUL renders as a space. Tabs/newlines/CR are excluded, obviously.
    for (const match of content.matchAll(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
    )) {
      violations.push({
        file,
        line: content.slice(0, match.index).split("\n").length,
        snippet: `raw \\u${match[0].charCodeAt(0).toString(16).padStart(4, "0")} — write it as an escape (\\0, \\u001b, …)`,
        rule: "raw-control-byte",
      });
    }

    // Rule (hand-rolled-any-array): raw `= ANY(${arr})` SQL — the
    // row-constructor trap, as a hard 500 rather than a silent mismatch.
    // Content-level so a wrapped `sql` template can't hide it; comment-only
    // references (this repo documents the trap in prose) are filtered out.
    if (!isTestOrFixture(file)) {
      for (const match of content.matchAll(HAND_ROLLED_ANY_ARRAY_RE)) {
        const line = content.slice(0, match.index).split("\n").length;
        if (isCommentLine(lines[line - 1] ?? "")) continue;
        violations.push({
          file,
          line,
          snippet: (lines[line - 1] ?? "").trim(),
          rule: "hand-rolled-any-array",
        });
      }
    }

    // Explicit router outputs must type-check resolvers against z.output, not
    // z.input (whose plain strings also accept branded private UUIDs).
    if (isRouterFile(file) && !isTestOrFixture(file)) {
      for (const match of content.matchAll(LOOSE_ROUTER_OUTPUT_RE)) {
        const line = content.slice(0, match.index).split("\n").length;
        violations.push({
          file,
          line,
          snippet: lines[line - 1]?.trim() ?? ".output(",
          rule: "strict-router-output",
        });
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";

      // Rule 1: hardcoded chromatic Tailwind colors (tsx only, non-comment).
      if (
        isTsx &&
        !COLOR_EXCLUDE_BASENAMES.has(base) &&
        !isCommentLine(line) &&
        COLOR_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "hardcoded-color",
        });
      }

      // Rule 2: reintroduced TS calculateTotals engine (any non-test source).
      if (
        !isTestOrFixture(file) &&
        !isCommentLine(line) &&
        CALC_TOTALS_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "ts-calculateTotals",
        });
      }

      // Rule 3: off-scale spacing (tsx only). Exempt UI primitives, the design
      // gallery, comment lines, and lines marked `/* tight */` (intentional).
      if (
        isTsx &&
        !isUiPrimitive(file) &&
        !COLOR_EXCLUDE_BASENAMES.has(base) &&
        !isCommentLine(line) &&
        // The `/* tight */` (or `/* tight: reason */`) marker only — the `/*`
        // prefix means Tailwind's leading-tight/tracking-tight don't match.
        !line.includes("/* tight") &&
        SPACING_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "off-scale-spacing",
        });
      }

      // Rule 4: response contracts live in their owning schema modules.
      if (i === 0 && isResponseSidecar(file)) {
        violations.push({
          file,
          line: i + 1,
          snippet: relative(repoRoot, file),
          rule: "schema-response-sidecar",
        });
      }

      // Rule 5: schema contract modules should compose reusable field maps, not
      // derive exported contracts from other schemas or their `.shape`.
      if (
        isSchemaContractFile(file) &&
        !isCommentLine(line) &&
        SCHEMA_DERIVATION_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "schema-contract-derivation",
        });
      }

      // Rule 6: all raw React Query invalidation/cancellation goes through the
      // typed query-key helpers so tRPC's nested query-key shape stays correct.
      if (
        !isQueryKeyHelperFile(file) &&
        !isCommentLine(line) &&
        DIRECT_QUERY_INVALIDATION_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "direct-query-invalidation",
        });
      }

      // Rule 7: response field maps must be canonical entity field maps, not
      // duplicated `*ResponseFields` objects beside exported response schemas.
      if (
        isSchemaContractFile(file) &&
        !isCommentLine(line) &&
        RESPONSE_FIELD_MAP_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "schema-response-field-map",
        });
      }

      // Rule 8: entity list schemas should use createSortPaginationFields with
      // owner-module sort enums; the loose sortPaginationFields fallback is only
      // allowed in the helper itself and crud-factory compatibility path.
      if (
        !isPaginationHelperFile(file) &&
        !isCrudFactoryFile(file) &&
        !isCommentLine(line) &&
        LOOSE_SORT_PAGINATION_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "loose-sort-pagination-fields",
        });
      }

      // Rule 9: raw Tailwind shadow utilities (tsx only). Same exemption set as
      // colors/spacing (UI primitives, design gallery, IsometricPantry canvas).
      if (
        isTsx &&
        !isUiPrimitive(file) &&
        !COLOR_EXCLUDE_BASENAMES.has(base) &&
        !isCommentLine(line) &&
        SHADOW_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "raw-shadow",
        });
      }

      // Rule 10: bg-gradient-to-* surface washes (tsx only). Exempts the shared
      // authored illustration paint plus the audit-log timeline fade connector.
      if (
        isTsx &&
        !isUiPrimitive(file) &&
        !COLOR_EXCLUDE_BASENAMES.has(base) &&
        !GRADIENT_EXCLUDE_BASENAMES.has(base) &&
        !isCommentLine(line) &&
        GRADIENT_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "surface-gradient",
        });
      }

      // Rule 11: arbitrary text-[Npx] sizes (tsx only). Snap to the sub-xs
      // tokens (text-2xs / text-3xs) so the type scale stays closed.
      if (
        isTsx &&
        !isUiPrimitive(file) &&
        !COLOR_EXCLUDE_BASENAMES.has(base) &&
        !isCommentLine(line) &&
        TEXT_PX_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "arbitrary-text-px",
        });
      }

      // Rule 11 (getdb-outside-repo): getDb() unwraps the opaque Database
      // type; only server/repo/ files may import or call it.
      if (!isRepoFile(file) && !isCommentLine(line) && GETDB_RE.test(line)) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "getdb-outside-repo",
        });
      }

      // Rule (falsy-none-value): the unknown-marker `—` reached by truthiness.
      // Guards the one-marker-one-meaning rule described at FALSY_NONE_VALUE_RE.
      if (
        isTsx &&
        !isCommentLine(line) &&
        FALSY_NONE_VALUE_RE.test(line) &&
        !NULL_CHECKED_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "falsy-none-value",
        });
      }

      // Rule 14: adjacent equal h-N/w-N pairs (tsx only). Use `size-N`. No
      // exemptions — the density pass normalized components/ui too.
      if (isTsx && !isCommentLine(line) && HW_PAIR_RE.test(line)) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "hw-pair-shorthand",
        });
      }

      // Rule (menu-item-icon-override): an explicit icon size/margin on a glyph
      // inside a DropdownMenuItem. The primitive already sets gap-2 and a
      // size-3.5 icon default, so `mr-2 size-4` is redundant AND larger than
      // the shared row-action column renders — which is exactly how the
      // bespoke per-entity row menus drifted away from `createActionsColumn`.
      if (isTsx && line.includes("<DropdownMenuItem")) dropdownItemDepth += 1;
      if (
        isTsx &&
        dropdownItemDepth > 0 &&
        !isCommentLine(line) &&
        MENU_ITEM_ICON_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "menu-item-icon-override",
        });
      }
      // Rule (hand-rolled-verb-label): a menu item whose text is a registered
      // verb, written out by hand instead of rendered from the registry. This
      // is how the same operation ended up spelled three ways across row menus
      // — and twice within a single file, once on the row and once on the bulk
      // bar. `VerbMenuItem` / `verbBulkAction` render the canonical wording.
      if (
        isTsx &&
        dropdownItemDepth > 0 &&
        !isCommentLine(line) &&
        !file.endsWith("action-verb-ui.tsx") &&
        actionVerbLabelSet.has(menuItemText(line))
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "hand-rolled-verb-label",
        });
      }

      if (isTsx && line.includes("</DropdownMenuItem>") && dropdownItemDepth > 0)
        dropdownItemDepth -= 1;

      // Rule (uuid-entity-href): a detail-page link keyed on a uuid rather than
      // the entity's shortcode. Applies everywhere, including the server —
      // `attention.ts` builds hrefs as plain strings, which no typed router
      // param can protect. routeTree.gen.ts is generated, so it's skipped.
      if (
        !isTestOrFixture(file) &&
        !isCommentLine(line) &&
        !file.endsWith("routeTree.gen.ts") &&
        (UUID_ROUTE_PARAM_RE.test(line) ||
          UUID_TEMPLATE_HREF_RE.test(line) ||
          UUID_BASEPATH_HREF_RE.test(line))
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "uuid-entity-href",
        });
      }

      // Rule (hand-rolled-array-overlap): raw `&& ${arr}` SQL in
      // server/repo/ — the row-constructor trap. Use `arrayOverlaps` instead.
      if (
        isRepoFile(file) &&
        !isTestOrFixture(file) &&
        !isCommentLine(line) &&
        HAND_ROLLED_ARRAY_OVERLAP_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "hand-rolled-array-overlap",
        });
      }
    }
  }

  return violations;
}

const files = listFiles();
const violations = [
  ...scan(files),
  ...checkServicesHaveTests(),
  ...checkPackageScriptTargets(),
];

if (violations.length === 0) {
  console.log(
    `OK: check-conventions passed (${files.length} files scanned, 0 violations).`,
  );
  process.exit(0);
}

const byRule: Record<string, string> = {
  "hardcoded-color":
    "Hardcoded chromatic Tailwind colors — use design tokens in apps/web/src/styles.css (see CLAUDE.md Colors).",
  "off-scale-spacing":
    "Off-scale spacing — use the {1,2,4,6} scale (see CLAUDE.md Spacing). Mark genuinely-dense exceptions with an inline /* tight */ comment.",
  "schema-response-sidecar":
    "Response schema sidecar — response contracts live in owner modules; do not add *-responses.ts files.",
  "schema-contract-derivation":
    "Schema contract derivation — use private field maps plus explicit z.object contracts instead of `.extend()`, `.shape`, `.pick()`, `.omit()`, or `.partial()`.",
  "direct-query-invalidation":
    "Direct React Query invalidation — use invalidateTRPCQueries/cancelTRPCQueries/invalidateAllQueries from apps/web/src/lib/query-keys.ts.",
  "schema-response-field-map":
    "Duplicated response field map — use canonical owner-module field maps, not *ResponseFields objects.",
  "loose-sort-pagination-fields":
    "Loose sort pagination fields — use createSortPaginationFields with owner-module sortable field enums.",
  "raw-shadow":
    "Raw Tailwind shadow — the Warm-Paper Ledger is zero-shadow; drop the shadow-*/drop-shadow and let the `border border-[var(--border)]` hairline carry separation.",
  "surface-gradient":
    "bg-gradient-to-* surface wash — the matte-paper system is flat; use a solid tone (e.g. bg-muted/30) instead of a gradient.",
  "arbitrary-text-px":
    "Arbitrary text-[Npx] size — use the sub-xs tokens (text-[8px]→text-3xs, text-[9/10/11px]→text-2xs) so the type scale stays closed.",
  "service-needs-test":
    "Untested service — add a sibling *.test.ts for this server/services/*.service.ts (or add it to the shrink-only SERVICE_TEST_EXEMPTIONS list in check-conventions.mjs with a reason).",
  "getdb-outside-repo":
    "getDb() used outside server/repo/ — the opaque Database type may only be unwrapped in the repo layer (CLAUDE.md Opaque Database Type); move the query behind a repo helper.",
  "hw-pair-shorthand":
    "Adjacent equal h-N/w-N pair — use the `size-N` shorthand (e.g. `h-4 w-4` → `size-4`) so icon sizing stays single-token (CLAUDE.md Colors / Design Tokens).",
  "untransformed-image":
    "<Image> without `displayWidth` — the Cloudflare Image Transformation is opt-in, so an omitted width serves the full-size R2 original into the rendered box (multi-MB photos into 32px tiles). Pass the rendered CSS width; `srcSet` handles retina, and it's a harmless no-op on non-bucket URLs.",
  "hand-rolled-verb-label":
    "Hand-written label inside a DropdownMenuItem that duplicates a registered action verb — render it with `VerbMenuItem` (or `verbBulkAction` / `VerbButton`) so one operation keeps one wording and one icon everywhere it is offered (apps/web/src/app/_components/actions/action-verbs.ts).",
  "menu-item-icon-override":
    "Icon size/margin override inside a DropdownMenuItem — the primitive already applies gap-2 and a size-3.5 icon default, so `mr-2 size-4` both duplicates the gap and renders larger than the shared row-action column (CLAUDE.md Colors / Design Tokens). Drop the className.",
  "uuid-entity-href":
    "Entity link keyed on a uuid — shortcodes are the public id, so a detail-page URL is `/products/$shortcode`, never `/products/$id` or a `/tasks/${row.id}` template. Route through `entities[e].routes.detail` + `entityDetailParams`.",
  "hand-rolled-array-overlap":
    "Hand-rolled `&& ${arr}` array overlap — drizzle interpolates a JS array into raw SQL as a row constructor (`($1,$2)`), not a `text[]`, so this silently matches nothing at every input size. Use `arrayOverlaps(col, arr)` instead.",
  "strict-router-output":
    "Loose tRPC output typing — wrap explicit router schemas in `strictOutput(...)` so resolvers are checked against parsed/brand-preserving z.output rather than permissive z.input.",
  "script-target-exists":
    "Dead package.json script — the tsx/node target file doesn't exist; delete the script or fix the path.",
  "unstable-hook-default":
    "Unstable hook-destructure default — an inline `= []`/`= {}`/`= new …` default on a hook result mints a new reference every render while the value is undefined, destabilizing memo/effect deps (render-loop hazard). Default to a module-level constant instead (see CLAUDE.md React Hooks).",
  "unstable-param-default":
    "Unstable parameter default — an inline `= []`/`= {}`/`= new …` default on a destructured component/hook parameter mints a new reference every render for every caller that omits it, and this identifier is named in a dependency array. Default to a module-level constant instead (see CLAUDE.md React Hooks).",
  "ts-calculateTotals":
    "TS costing engine — recipe totals live in the Rust/WASM crate (recipebridge); call the WASM instead of reimplementing calculateTotals in TS (CLAUDE.md Where logic lives).",
  "hand-rolled-any-array":
    "Hand-rolled `= ANY(${arr})` — drizzle interpolates a JS array into raw SQL as a row constructor, so this is a hard 500 rather than a silent mismatch. Use `eqAny(col, arr)` / `inArray(col, arr)`.",
  "falsy-none-value":
    'Truthiness-gated <NoneValue /> — the muted `—` means "we do not know", so gating it on truthiness hands that marker to `0`, `false` and `""`, which are recorded values. A genuine $0, a `stockTracked: false`, and a zero count all read as unknown this way. Test explicitly: `x == null ? <NoneValue /> : …`.',
  "raw-control-byte":
    'Raw C0 control byte in source — a literal 0x00/0x1b/… makes the WHOLE FILE binary to the grep family (`file` reports "data", ripgrep skips it, `grep -c` returns nothing for a symbol `git grep` finds). Write it as an escape (`\\0`, `\\u001b`, …).',
};

console.error(
  `check-conventions: ${violations.length} violation(s) found.\n`,
);

// Iterate the rules that actually fired, not the description map — a rule
// missing from `byRule` used to exit 1 with a bare count and no file, line, or
// snippet, which is worst for exactly the rules whose violations are hard to
// see unaided. Three rules had silently been in that state.
for (const rule of [...new Set(violations.map((v) => v.rule))].sort()) {
  const hits = violations.filter((v) => v.rule === rule);
  console.error(`▸ ${byRule[rule] ?? `${rule} (no description registered)`}`);
  for (const v of hits) {
    console.error(`    ${relative(repoRoot, v.file)}:${v.line}: ${v.snippet}`);
  }
  console.error("");
}

process.exit(1);
