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
// include does and no `!` exclude does; `deleted:` includes match only
// deletions.
type Parsed = { include: string[]; exclude: string[]; deleted: string[] };
const groups = new Map<string, Parsed>();
let current: Parsed | undefined;
for (const line of readFileSync(LANES_FILE, "utf8").split("\n")) {
  const name = /^([\w.+-]+):$/u.exec(line)?.[1];
  if (name)
    groups.set(name, (current = { include: [], exclude: [], deleted: [] }));
  else if (line.startsWith("  - deleted: ") && current)
    current.deleted.push(String(JSON.parse(line.slice(13))));
  else if (line.startsWith("  - ") && current) {
    const pattern = String(JSON.parse(line.slice(4)));
    if (pattern.startsWith("!")) current.exclude.push(pattern.slice(1));
    else current.include.push(pattern);
  }
}
const never = () => false;
const matchers = [...groups].map(([name, group]) => ({
  lanes: name.replace(/\.\d+$/u, "").split("+"),
  include: group.include.length
    ? picomatch(group.include, { dot: true })
    : never,
  deleted: group.deleted.length
    ? picomatch(group.deleted, { dot: true })
    : never,
  exclude: group.exclude.length
    ? picomatch(group.exclude, { dot: true })
    : never,
}));
const lanesFor = (file: string, status: "modified" | "deleted" = "modified") =>
  [
    ...new Set(
      matchers
        .filter(
          (group) =>
            (group.include(file) ||
              (status === "deleted" && group.deleted(file))) &&
            !group.exclude(file),
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
  assert.deepEqual(lanesFor("docs/ci.md"), ["docs"]);
  // The Worker bundles the guide pages.
  assert.deepEqual(
    lanesFor("docs/guide/terminology.md"),
    [...web, "docs", "validation"].sort(),
  );
  // Any deletion can break a relative link.
  assert.ok(!lanesFor("apps/apple/scripts/example.sh").includes("docs"));
  assert.ok(
    lanesFor("apps/apple/scripts/example.sh", "deleted").includes("docs"),
  );
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
    ["apple", "apple-lint", ...web, "validation"].sort(),
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

test("each lane's ci.yaml commands run only tasks routed to that lane", async () => {
  const graph = await createProjectGraphAsync({ exitOnError: true });
  const withTarget = (target: string) =>
    Object.keys(graph.nodes).filter(
      (name) => graph.nodes[name]!.data.targets?.[target],
    );
  const concrete = (task: string) => {
    const { project, name } = splitTask(task);
    return (project === "*" ? withTarget(name) : [project]).map(
      (each) => `${each}:${name}`,
    );
  };
  const scripts: Record<string, string> = JSON.parse(
    readFileSync("package.json", "utf8"),
  ).scripts;
  const tasksIn = (command: string) => {
    const words = command
      .replace(/pnpm (check:all)/u, (_, name: string) => scripts[name] ?? "")
      .split(/[\s=]+/u);
    const tasks: string[] = [];
    words.forEach((word, index) => {
      if (word === "run" && words[index - 1] === "nx")
        tasks.push(words[index + 1]!);
      if (word !== "run-many" || words[index - 1] !== "nx") return;
      const values = (flags: string[]) => {
        const start = words.findIndex(
          (each, at) => at > index && flags.includes(each),
        );
        if (start < 0) return [];
        const end = words.findIndex(
          (each, at) => at > start && each.startsWith("-"),
        );
        return words
          .slice(start + 1, end < 0 ? undefined : end)
          .flatMap((each) => each.split(","));
      };
      const projects = values(["-p", "--projects"]);
      for (const target of values(["-t", "--targets"]))
        tasks.push(
          ...(projects.length ? projects : ["*"])
            .flatMap((project) => concrete(`${project}:${target}`))
            .filter(
              (task) =>
                graph.nodes[splitTask(task).project]!.data.targets?.[
                  splitTask(task).name
                ],
            ),
        );
    });
    return tasks;
  };
  // Run alongside Validation's checks: format is routed to the docs lane.
  const elsewhere = new Set(["cubby-checks:format"]);
  const commands: [string, string][] = [];
  const workflow = readFileSync(".github/workflows/ci.yaml", "utf8");
  for (const job of workflow.split(/^ {2}(?=[\w-]+:$)/mu)) {
    for (const entry of job.matchAll(
      /\{lane: "([\w-]+)"[^}]*?run: "([^"]+)"/gu,
    ))
      commands.push([entry[1]!, entry[2]!]);
    const lane = /outputs\.lanes\), '([\w-]+)'/u.exec(job)?.[1];
    if (lane)
      for (const line of job.matchAll(/^\s+(?:- )?(?:run|command): (.+)$/gmu))
        commands.push([lane, line[1]!]);
  }
  const lanes: Record<string, LaneSpec> = LANES;
  let checked = 0;
  for (const [lane, command] of commands) {
    const routed = new Set((lanes[lane]?.tasks ?? []).flatMap(concrete));
    for (const task of tasksIn(command)) {
      checked++;
      assert.ok(
        routed.has(task) || elsewhere.has(task),
        `${lane} runs ${task} without routing it`,
      );
    }
  }
  assert.ok(checked > 20, `parsed ${checked} tasks from ci.yaml`);
});
