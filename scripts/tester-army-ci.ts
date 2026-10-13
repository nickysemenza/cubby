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
  const labelDispatch =
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    journey === "tester-army-pr";
  const pull =
    labelDispatch && env.TESTER_ARMY_PULL_REQUEST
      ? await github(`pulls/${env.TESTER_ARMY_PULL_REQUEST}`)
      : undefined;
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch" && !labelDispatch) {
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
    const labels = pull.labels.map((label: { name: string }) => label.name);
    selected.web = labels.includes("tester-army");
    selected.ios = labels.includes("tester-army:ios");
    selected.imports = labels.includes("tester-army:import");
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
            timeout: labelDispatch ? 10 : 25,
            journeys: labelDispatch
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
