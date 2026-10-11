/* oxlint-disable anti-slop/no-runtime-typeof -- Routing reads GitHub JSON before dependency installation. */
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";

const env = process.env;
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, "utf8"));
async function github(route: string) {
  const response = await fetch(
    `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/${route}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub ${route}: ${response.status}`);
  return response.json();
}

if (process.argv[2] === "route") {
  const selected = { web: false, ios: false, imports: false, simulator: false };
  const journey = env.TESTER_ARMY_JOURNEY;
  if (env.GITHUB_EVENT_NAME === "schedule") {
    selected.web = selected.ios = selected.imports = true;
  } else if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    selected.web = [
      "tester-army-web",
      "tester-army-both",
      "tester-army-all",
    ].includes(journey!);
    selected.ios = [
      "tester-army-ios",
      "tester-army-both",
      "tester-army-all",
    ].includes(journey!);
    selected.imports = ["tester-army-import", "tester-army-all"].includes(
      journey!,
    );
    selected.simulator = journey?.startsWith("simulator-") ?? false;
  } else if (
    event.pull_request?.head.repo.full_name === env.GITHUB_REPOSITORY
  ) {
    const files: string[] = [];
    for (let page = 1; ; page++) {
      const batch = await github(
        `pulls/${event.number}/files?per_page=100&page=${page}`,
      );
      assert(Array.isArray(batch), "Invalid GitHub changed-file list");
      for (const file of batch) {
        assert(typeof file.filename === "string", "Invalid GitHub filename");
        files.push(file.filename);
        if (file.previous_filename) {
          assert(
            typeof file.previous_filename === "string",
            "Invalid previous GitHub filename",
          );
          files.push(file.previous_filename);
        }
      }
      if (batch.length < 100) break;
      if (page === 30)
        throw new Error("PR exceeds GitHub's complete-file-list limit");
    }
    const code = files.filter((file) => !/\.(?:md|mdx|markdown)$/iu.test(file));
    const shared = code.some((file) =>
      /^(?:packages\/|cubby-ffi\/|recipebridge\/|scripts\/|\.github\/|[^/]+$)|^apps\/web\/src\/(?:server|contracts|routes\/api)\//u.test(
        file,
      ),
    );
    const labels = event.pull_request.labels.map(
      (label: { name: string }) => label.name,
    );
    selected.web = code.length > 0 || labels.includes("tester-army");
    selected.ios =
      shared ||
      code.some((file) => file.startsWith("apps/apple/")) ||
      labels.includes("tester-army:ios");
    selected.imports =
      shared ||
      code.some((file) =>
        /^apps\/web\/(?:src\/.*(?:import|vendor|run)|tooling\/(?:tester-army|scenarios\/tester-army)|tests\/tester-army)/u.test(
          file,
        ),
      ) ||
      labels.includes("tester-army:import");
    selected.simulator = labels.includes("simulator-e2e");
  }
  for (const [lane, run] of Object.entries(selected))
    appendFileSync(env.GITHUB_OUTPUT!, `${lane}=${run}\n`);
  const include = [
    ...(selected.web
      ? [{ lane: "web", harness: "standard", timeout: 25 }]
      : []),
    ...(selected.imports
      ? [{ lane: "import", harness: "coupled", timeout: 30 }]
      : []),
  ];
  appendFileSync(
    env.GITHUB_OUTPUT!,
    `web-matrix=${JSON.stringify({ include })}\n`,
  );
} else throw new Error("Usage: tester-army-ci.ts route");
