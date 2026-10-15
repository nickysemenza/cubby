#!/usr/bin/env node
// Writes .github/ci-lanes.yml: the dorny/paths-filter groups ci.yaml's `plan`
// job matches against the files changed since the last green main run
// (docs/adr/0014-path-routed-ci-lanes.md). A lane's groups are the Nx inputs
// of the tasks it runs, so a lane is skipped only when none of its tasks could
// miss the Nx cache.
//
//   node scripts/ci-lanes.ts          write the filter file
//   node scripts/ci-lanes.ts --check  fail when it is stale (cubby-checks:ci-lanes)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import picomatch from "picomatch";
import {
  createProjectGraphAsync,
  readJsonFile,
  type NxJsonConfiguration,
  type ProjectGraph,
  type TargetConfiguration,
} from "nx/src/devkit-exports.js";
import type { InputDefinition } from "nx/src/config/workspace-json-project-json.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LANES_FILE = ".github/ci-lanes.yml";

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

// Every Nx runtime input a lane task reads, keyed by its exact command, with
// the tracked files it hashes or the tasks whose ignored outputs it hashes.
// A new or edited command fails generation until it is classified here.
type RuntimeRoute = { files?: string[]; producedBy?: string[] };
const RUNTIME = new Map<string, RuntimeRoute>([
  // Toolchain versions never appear in a diff; the nightly run covers them.
  ["node --version", {}],
  ['node -p "process.platform + process.arch"', {}],
  ["rustc -V", {}],
  // Local Cargo packages (rust-fingerprint.ts) plus the wasm toolchain.
  [
    "node scripts/ensure.ts wasm --fingerprint",
    {
      files: [
        "Cargo.{toml,lock}",
        "rust-toolchain.toml",
        "recipebridge/**",
        "cubby-ffi/**",
      ],
    },
  ],
  [
    "git ls-files -z -co --exclude-standard -- docs/README.md docs/guide .claude/skills/purchase-import .claude/skills/product-enrichment .claude/skills/photo-inventory-import | xargs -0 shasum -a 256",
    {
      files: [
        "docs/README.md",
        "docs/guide/**",
        ".claude/skills/purchase-import/**",
        ".claude/skills/product-enrichment/**",
        ".claude/skills/photo-inventory-import/**",
      ],
    },
  ],
  // Ignored local env files: never committed, so never in a diff.
  [
    "git ls-files --others --ignored --exclude-standard -- ':(glob)**/.env*' | git hash-object --stdin-paths",
    {},
  ],
  // Generated output bytes decide cache reuse; producer inputs route the probe.
  ...["host", "app"].map((scope): [string, RuntimeRoute] => [
    `node scripts/apple/apple-inputs.ts ${scope}`,
    { producedBy: ["cubby-checks:generate"] },
  ]),
]);

type Input = string | InputDefinition;
type NamedInputs = Record<string, Input[]>;
// One dorny filter group: some include matches and no exclude does, the same
// rule Nx applies to one task's file inputs. `deleted` includes match only
// deletions.
type Group = { include: string[]; exclude: string[]; deleted?: string[] };

export const splitTask = (task: string) => {
  const [project, name, ...rest] = task.split(":");
  if (!project || !name || rest.length > 0)
    throw new Error(`Malformed Nx task ${task}`);
  return { project, name };
};

// A task's inputs with named inputs expanded.
const flatInputs = (inputs: readonly Input[], named: NamedInputs): Input[] =>
  inputs.flatMap((input) =>
    typeof input === "string" && input in named
      ? flatInputs(named[input] ?? [], named)
      : [input],
  );

// Sorted, deduplicated patterns, without a literal path another pattern
// already matches.
const tidy = (patterns: string[]) => {
  const unique = [
    ...new Set(
      patterns.map((pattern) => pattern.replace(/\/\*\*\/\*$/u, "/**")),
    ),
  ].sort();
  return unique.filter(
    (pattern) =>
      /[*?{[]/u.test(pattern) ||
      !unique.some(
        (other) =>
          other !== pattern && picomatch(other, { dot: true })(pattern),
      ),
  );
};

const resolvePattern = (root: string, pattern: string) =>
  pattern.startsWith("{workspaceRoot}/")
    ? pattern.slice("{workspaceRoot}/".length)
    : root + pattern.replace(/^\{projectRoot\}\//u, "");

async function laneGroups(
  graph: ProjectGraph,
  workspaceNamedInputs: NamedInputs,
): Promise<Record<string, Group[]>> {
  const projectRoot = (project: string) => {
    const root = graph.nodes[project]?.data.root;
    if (root === undefined) throw new Error(`Unknown Nx project ${project}`);
    return root === "." ? "" : `${root}/`;
  };
  const target = (task: string): [string, TargetConfiguration] => {
    const { project, name } = splitTask(task);
    const config = graph.nodes[project]?.data.targets?.[name];
    if (!config) throw new Error(`Unknown Nx task ${task}`);
    return [project, config];
  };

  const taskGroups = (task: string, seen: Set<string>): Group[] => {
    if (seen.has(task)) return [];
    seen.add(task);
    const [project, config] = target(task);
    const root = projectRoot(project);
    const named = {
      ...workspaceNamedInputs,
      ...graph.nodes[project]!.data.namedInputs,
    };
    const files: Group = { include: [], exclude: [] };
    // Nx hashes the task's own configuration, the ignore rules, and the
    // root TypeScript path mappings.
    const groups: Group[] = [
      {
        include: [
          "nx.json",
          ".gitignore",
          "tsconfig.json",
          `${root}project.json`,
          `${root}package.json`,
        ],
        exclude: [],
      },
    ];
    const resolve = (pattern: string) => resolvePattern(root, pattern);
    const expand = (inputs: readonly Input[], stack: string[]) => {
      for (const input of inputs) {
        if (typeof input === "string" || "fileset" in input) {
          const value = typeof input === "string" ? input : input.fileset;
          if (
            value.startsWith("^") ||
            (typeof input !== "string" && "dependencies" in input)
          )
            throw new Error(
              `${task}: dependency inputs (${value}) unsupported`,
            );
          if (value in named) {
            if (stack.includes(value))
              throw new Error(`${task}: named input cycle ${value}`);
            expand(named[value]!, [...stack, value]);
          } else if (value.startsWith("!"))
            files.exclude.push(resolve(value.slice(1)));
          else files.include.push(resolve(value));
        } else if ("runtime" in input) {
          const runtime = RUNTIME.get(input.runtime);
          if (!runtime)
            throw new Error(
              `${task}: classify runtime input in scripts/ci-lanes.ts: ${input.runtime}`,
            );
          if (runtime.files)
            groups.push({ include: runtime.files, exclude: [] });
          for (const producer of runtime.producedBy ?? [])
            groups.push(...taskGroups(producer, seen));
        } else if ("dependentTasksOutputFiles" in input) {
          // The dependency tasks producing these files key on their own inputs.
          const glob = input.dependentTasksOutputFiles;
          for (const dependency of config.dependsOn ?? []) {
            const { target: name, projects = [project] } =
              typeof dependency === "string"
                ? { target: dependency }
                : dependency;
            if (
              name.startsWith("^") ||
              (typeof dependency !== "string" && dependency.dependencies)
            )
              throw new Error(
                `${task}: unsupported dependsOn ${JSON.stringify(dependency)}`,
              );
            for (const dependencyProject of [projects].flat()) {
              const producer = `${dependencyProject}:${name}`;
              const [, producerConfig] = target(producer);
              const producerRoot = projectRoot(dependencyProject);
              if (
                (producerConfig.outputs ?? []).some((output) =>
                  glob.startsWith(resolvePattern(producerRoot, output)),
                )
              )
                groups.push(...taskGroups(producer, seen));
            }
          }
        } else if ("externalDependencies" in input) {
          if (input.externalDependencies.length > 0)
            files.include.push("pnpm-lock.yaml");
        } else if (!("env" in input))
          throw new Error(
            `${task}: unsupported input ${JSON.stringify(input)}`,
          );
      }
    };
    if (!config.inputs) throw new Error(`${task} declares no inputs`);
    expand(config.inputs, []);
    // Without an explicit `externalDependencies` input, Nx hashes every
    // external dependency.
    if (
      !flatInputs(config.inputs, named).some(
        (input) => typeof input !== "string" && "externalDependencies" in input,
      )
    )
      files.include.push("pnpm-lock.yaml");
    if (files.include.length > 0) groups.push(files);
    else if (files.exclude.length > 0)
      throw new Error(`${task}: exclusions without inclusions`);
    return groups;
  };

  const lanes: Record<string, Group[]> = {};
  for (const [lane, spec] of Object.entries<LaneSpec>(LANES)) {
    const groups: Group[] = [];
    for (const task of spec.tasks ?? []) {
      const { project, name } = splitTask(task);
      const projects =
        project === "*"
          ? Object.keys(graph.nodes).filter(
              (candidate) => graph.nodes[candidate]!.data.targets?.[name],
            )
          : [project];
      if (projects.length === 0) throw new Error(`No project has ${task}`);
      for (const each of projects)
        groups.push(...taskGroups(`${each}:${name}`, new Set()));
    }
    if (spec.files) groups.push({ include: spec.files, exclude: [] });
    // Include-only groups OR together, so they merge into one.
    const plain = groups.filter((group) => group.exclude.length === 0);
    const scoped = groups.filter((group) => group.exclude.length > 0);
    const unique = new Map<string, Group>();
    for (const group of [
      { include: plain.flatMap((each) => each.include), exclude: [] },
      ...scoped,
    ].filter((each) => each.include.length > 0)) {
      const normal = {
        include: tidy(group.include),
        exclude: tidy(group.exclude),
      };
      unique.set(JSON.stringify(normal), normal);
    }
    lanes[lane] = [...unique.values()];
    if (spec.deleted)
      lanes[lane].push({ include: [], exclude: [], deleted: spec.deleted });
  }
  return lanes;
}

// Lanes sharing a group share its entry: `<lane>+<lane>.<n>` selects each.
function render(lanes: Record<string, Group[]>) {
  const owners = new Map<string, { group: Group; lanes: string[] }>();
  for (const [lane, groups] of Object.entries(lanes))
    for (const group of groups) {
      const key = JSON.stringify(group);
      const entry = owners.get(key) ?? { group, lanes: [] };
      entry.lanes.push(lane);
      owners.set(key, entry);
    }
  const lines = [
    "# Generated by scripts/ci-lanes.ts from the Nx inputs of each CI lane's",
    "# tasks; run `pnpm generate` after changing them. ci.yaml's plan job runs",
    "# every lane named in a `<lane>+<lane>.<n>` group that matches a changed file.",
  ];
  const counts = new Map<string, number>();
  for (const { group, lanes: names } of owners.values()) {
    const name = names.join("+");
    counts.set(name, (counts.get(name) ?? 0) + 1);
    lines.push(`${name}.${counts.get(name)}:`);
    for (const pattern of group.include)
      lines.push(`  - ${JSON.stringify(pattern)}`);
    for (const pattern of group.deleted ?? [])
      lines.push(`  - deleted: ${JSON.stringify(pattern)}`);
    for (const pattern of group.exclude)
      lines.push(`  - ${JSON.stringify(`!${pattern}`)}`);
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  process.env.NX_DAEMON = "false";
  const graph = await createProjectGraphAsync({ exitOnError: true });
  const nxJson = readJsonFile<NxJsonConfiguration>(path.join(ROOT, "nx.json"));
  const groups = await laneGroups(graph, nxJson.namedInputs ?? {});
  if (process.argv[2] === "--explain") {
    const base = process.argv[3] ?? "origin/main";
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
    const diff = git(
      "diff",
      "--no-renames",
      "--name-status",
      "-z",
      base,
      "--",
    ).split("\0");
    const changed: { file: string; deleted: boolean }[] = [];
    for (let index = 0; index + 1 < diff.length; index += 2)
      changed.push({ file: diff[index + 1]!, deleted: diff[index] === "D" });
    for (const file of git("ls-files", "--others", "--exclude-standard", "-z")
      .split("\0")
      .filter(Boolean))
      changed.push({ file, deleted: false });
    const matches = (patterns: string[], file: string) =>
      patterns.length > 0 && picomatch(patterns, { dot: true })(file);
    console.log(
      JSON.stringify(
        {
          base,
          note: "CI candidates, not a local gate. Apple probes generated output hashes; unchanged output can replay. Choose focused local checks from docs/agents/validation.md.",
          lanes: Object.entries(groups).flatMap(([lane, filters]) => {
            const files = changed
              .filter(({ file, deleted }) =>
                filters.some(
                  (filter) =>
                    (matches(filter.include, file) ||
                      (deleted && matches(filter.deleted ?? [], file))) &&
                    !matches(filter.exclude, file),
                ),
              )
              .map(({ file }) => file);
            const spec = Object.entries(LANES).find(
              ([name]) => name === lane,
            )?.[1];
            return files.length
              ? [{ lane, ...spec, files: [...new Set(files)].sort() }]
              : [];
          }),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  const text = render(groups);
  const file = path.join(ROOT, LANES_FILE);
  if (process.argv[2] === "--check") {
    if (readFileSync(file, "utf8") !== text) {
      console.error(
        `${LANES_FILE} is stale; run \`node scripts/ci-lanes.ts\`.`,
      );
      process.exit(1);
    }
  } else writeFileSync(file, text);
}
