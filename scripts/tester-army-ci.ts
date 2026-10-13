import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

const env = process.env;
async function github(route: string) {
  const response = await fetch(
    `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/${route}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub ${route}: ${response.status}`);
  return JSON.parse(await response.text());
}

if (process.argv[2] === "route") {
  const selected = { web: false, ios: false, imports: false, simulator: false };
  const journey = env.TESTER_ARMY_JOURNEY;
  const automatic =
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    journey === "tester-army-pr";
  const pull =
    automatic && env.TESTER_ARMY_PULL_REQUEST
      ? await github(`pulls/${env.TESTER_ARMY_PULL_REQUEST}`)
      : undefined;
  if (env.GITHUB_EVENT_NAME === "schedule") {
    selected.web = selected.ios = selected.imports = true;
  } else if (env.GITHUB_EVENT_NAME === "workflow_dispatch" && !automatic) {
    selected.web = [
      "tester-army-web",
      "tester-army-both",
      "tester-army-all",
      "tester-army-visual",
      "tester-army-explore",
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
    pull?.state === "open" &&
    pull.head.sha === env.TESTER_ARMY_REVISION &&
    pull.head.repo.full_name === env.GITHUB_REPOSITORY
  ) {
    const files: string[] = [];
    for (let page = 1; ; page++) {
      const batch = await github(
        `pulls/${pull.number}/files?per_page=100&page=${page}`,
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
    const labels = pull.labels.map((label: { name: string }) => label.name);
    selected.web = code.length > 0 || labels.includes("tester-army");
    selected.ios = labels.includes("tester-army:ios");
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
  appendFileSync(
    env.GITHUB_OUTPUT!,
    `ref=${pull?.head.sha ?? env.GITHUB_SHA}\n`,
  );
  appendFileSync(
    env.GITHUB_OUTPUT!,
    `pull-request=${pull ? JSON.stringify({ number: pull.number, head: { sha: pull.head.sha } }) : ""}\n`,
  );
  for (const [lane, run] of Object.entries(selected))
    appendFileSync(env.GITHUB_OUTPUT!, `${lane}=${run}\n`);
  const include = [
    ...(selected.web
      ? [
          {
            lane: "web",
            harness: "standard",
            mode:
              journey === "tester-army-visual"
                ? "visual"
                : journey === "tester-army-explore"
                  ? "explore"
                  : "agent",
            timeout: automatic ? 10 : 25,
            journeys: automatic
              ? "product-rename,receive-purchase,field-product-tags"
              : "",
          },
        ]
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
