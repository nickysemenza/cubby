import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import picomatch from "picomatch";
import { createProjectGraphAsync } from "nx/src/devkit-exports.js";
import { HashPlanInspector } from "nx/src/hasher/hash-plan-inspector.js";

import { LANES, LANES_FILE, splitTask, type LaneSpec } from "./ci-lanes.ts";

process.env.NX_DAEMON = "false";

// dorny/paths-filter's matcher: picomatch with `dot`, and with
// `predicate-quantifier: some-with-excludes` a group matches a file when an
// include does and no `!` exclude does.
const groups = new Map<string, { include: string[]; exclude: string[] }>();
let current: { include: string[]; exclude: string[] } | undefined;
for (const line of readFileSync(LANES_FILE, "utf8").split("\n")) {
  const name = /^([\w.+-]+):$/u.exec(line)?.[1];
  if (name) groups.set(name, (current = { include: [], exclude: [] }));
  else if (line.startsWith("  - ") && current) {
    const pattern = String(JSON.parse(line.slice(4)));
    if (pattern.startsWith("!")) current.exclude.push(pattern.slice(1));
    else current.include.push(pattern);
  }
}
const matchers = [...groups].map(([name, group]) => ({
  lanes: name.replace(/\.\d+$/u, "").split("+"),
  include: picomatch(group.include, { dot: true }),
  exclude: group.exclude.length
    ? picomatch(group.exclude, { dot: true })
    : () => false,
}));
const lanesFor = (...files: string[]) =>
  [
    ...new Set(
      matchers
        .filter((group) =>
          files.some((file) => group.include(file) && !group.exclude(file)),
        )
        .flatMap((group) => group.lanes),
    ),
  ].sort();

test("every file Nx hashes for a lane's tasks selects that lane", async () => {
  const graph = await createProjectGraphAsync({ exitOnError: true });
  const inspector = new HashPlanInspector(graph);
  await inspector.init();
  for (const [lane, spec] of Object.entries<LaneSpec>(LANES))
    for (const task of spec.tasks ?? []) {
      const { project, name: target } = splitTask(task);
      const projects =
        project === "*"
          ? Object.keys(graph.nodes).filter(
              (name) => graph.nodes[name]!.data.targets?.[target],
            )
          : [project];
      for (const each of projects) {
        const inputs = inspector.inspectTaskInputs(
          { project: each, target },
          {},
          undefined,
          true,
        )[`${each}:${target}`];
        assert(inputs, `${each}:${target} has a hash plan`);
        // Nx's external dependency hashes come from the lockfile.
        const read =
          inputs.external.length > 0
            ? [...inputs.files, "pnpm-lock.yaml"]
            : inputs.files;
        const missed = read.filter((file) => !lanesFor(file).includes(lane));
        assert.deepEqual(
          missed,
          [],
          `${lane} misses inputs of ${each}:${target}`,
        );
      }
    }
});

test("changes route to the lanes whose tasks read them", () => {
  const web = ["aux", "build-worker", "e2e", "postgres", "purchase-import"];
  // Prose reaches only formatting and the link check.
  assert.deepEqual(lanesFor("docs/guide/terminology.md"), ["docs"]);
  assert.deepEqual(lanesFor("apps/apple/README.md"), ["docs"]);
  // Generation reads deferred MCP capabilities from the TODO list, and the
  // generated Swift is an Apple input.
  assert.deepEqual(lanesFor("docs/todos.md"), ["apple", "docs", "validation"]);
  // The Worker bundles purchase-import prompts.
  assert.deepEqual(
    lanesFor(".claude/skills/purchase-import/references/vendor.md"),
    ["apple", ...web, "docs", "validation"].sort(),
  );
  assert.deepEqual(
    lanesFor("apps/web/src/routes/example.tsx"),
    ["apple", ...web, "docs", "validation"].sort(),
  );
  assert.deepEqual(
    lanesFor("apps/apple/App/Example.swift"),
    ["apple", ...web, "validation"].sort(),
  );
  // Rust tests read the shared golden vectors directly.
  assert.deepEqual(
    lanesFor("packages/shared/golden-vectors/gtin.json"),
    ["apple", ...web, "docs", "rust", "validation"].sort(),
  );
  assert.ok(lanesFor("recipebridge/src/lib.rs").includes("rust"));
  // Cargo reads ancestor configuration but never JavaScript dependencies.
  assert.ok(lanesFor(".cargo/config.toml").includes("rust"));
  assert.ok(!lanesFor("pnpm-lock.yaml").includes("rust"));
  // A deploy-only workflow edit runs no test lane.
  assert.deepEqual(
    lanesFor(".github/workflows/deploy.yaml").filter((lane) =>
      [...web, "rust", "apple"].includes(lane),
    ),
    [],
  );
});

test("ci.yaml routes every lane", () => {
  const workflow = readFileSync(".github/workflows/ci.yaml", "utf8");
  for (const lane of Object.keys(LANES))
    assert.ok(new RegExp(`\\b${lane}\\b`, "u").test(workflow), lane);
});
