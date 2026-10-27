import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  journeyReportSchema,
  journeyFailureBoundary,
  journeyPassed,
} from "../ci-report/records.ts";

const timing = z.object({
  setupMs: z.number(),
  journeyMs: z.number(),
  runnerMs: z.number(),
});
const diagnostic = z.object({
  origin: z.string().optional(),
  phase: z.string().optional(),
  startedAt: z.string().optional(),
});
const providerDiagnostic = z.object({
  timestamp: z.string(),
  provider: z.string(),
  status: z.number(),
  requestId: z.string().nullable(),
  body: z.string(),
});

/** Keep report rendering on the Nx dashboard's existing visual tokens. */
const styles = readFile(
  new URL("../../../nx-cache/public/styles.css", import.meta.url),
  "utf8",
);
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const seconds = (value: number) => `${(value / 1000).toFixed(1)}s`;
const localPath = (value: string) => {
  if (
    /^(?:[a-z]+:|[/\\])/iu.test(value) ||
    value.split(/[/\\]/u).includes("..")
  )
    return undefined;
  return value.split("/").map(encodeURIComponent).join("/");
};
const link = (href: string, label: string) =>
  `<a href="${escape(href)}">${escape(label)}</a>`;

export async function readJourneyEvidence(directory: string, prefix = "") {
  const report = journeyReportSchema.parse(
    JSON.parse(await readFile(path.join(directory, "run/report.json"), "utf8")),
  );
  const metrics = timing.parse(
    JSON.parse(await readFile(path.join(directory, "timings.json"), "utf8")),
  );
  const files = await readdir(path.join(directory, "fixtures")).catch(() => []);
  const diagnostics = await Promise.all(
    files.map(async (file) => ({
      file,
      ...diagnostic.parse(
        JSON.parse(
          await readFile(path.join(directory, "fixtures", file), "utf8"),
        ),
      ),
    })),
  );
  const issues: string[] = [];
  const availableArtifacts = new Set<string>();
  const artifactRoot = await realpath(
    path.join(directory, "run/results"),
  ).catch(() => undefined);
  for (const result of report.run.results.filter((result) => result.selected)) {
    const attempt = result.attempts.at(-1);
    if (!attempt) continue;
    const media = new Set<string>();
    for (const artifact of attempt.artifacts) {
      const relative = artifact.path;
      if (!relative || !localPath(relative)) {
        issues.push(
          `${result.titlePath.join(" / ")}: rejected ${artifact.kind} artifact path.`,
        );
        continue;
      }
      const file = path.join(directory, "run/results", relative);
      const resolved = await realpath(file).catch(() => undefined);
      const metadata = resolved
        ? await stat(resolved).catch(() => undefined)
        : undefined;
      if (
        !artifactRoot ||
        !resolved?.startsWith(`${artifactRoot}${path.sep}`) ||
        !metadata?.isFile() ||
        metadata.size === 0
      ) {
        issues.push(
          `${result.titlePath.join(" / ")}: missing or empty artifact ${relative}.`,
        );
        continue;
      }
      availableArtifacts.add(relative);
      media.add(artifact.kind);
    }
    // Startup failures can precede a browser; completed journey bodies require both.
    if (result.status === "passed" || attempt.error?.phase === "body") {
      for (const kind of ["screenshot", "video"])
        if (!media.has(kind))
          issues.push(
            `${result.titlePath.join(" / ")}: required ${kind} evidence is missing.`,
          );
    }
  }
  const providerFile = await readFile(
    path.join(directory, "provider-errors.jsonl"),
    "utf8",
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "";
    throw error;
  });
  const providerDiagnostics = providerFile
    .split("\n")
    .filter(Boolean)
    .map((line) => providerDiagnostic.parse(JSON.parse(line)));
  return {
    report,
    metrics,
    diagnostics,
    prefix,
    issues,
    availableArtifacts,
    providerDiagnostics,
  };
}

async function page(body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tester Army · Cubby CI</title><style>${await styles}
.report header{display:block}.report h2{margin:28px 0 12px}.report details{border-top:1px solid var(--line);padding:8px 0}.report summary{cursor:pointer;padding:8px 0;font-weight:650}.report pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:32rem;overflow:auto}.report .table{overflow:auto}.report table{width:100%;border-collapse:collapse}.report th,.report td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}.report .number{font-variant-numeric:tabular-nums;white-space:nowrap}.report .media{display:flex;flex-wrap:wrap;gap:16px}.report figure{margin:12px 0;flex:1 1 320px}.report img,.report video{width:100%;max-height:600px;object-fit:contain;background:inherit}.report .note{margin:12px 0}.report a,.report p,.report summary{overflow-wrap:anywhere}.report summary:focus-visible,.report a:focus-visible{outline:2px solid currentColor;outline-offset:3px}@media(max-width:600px){.report main{padding:20px 14px}.report .table{overflow:auto}.report summary{min-height:44px}.report th,.report td{padding:6px}}
</style><body class="report"><main>${body}</main></body></html>`;
}

/** One report view over real SDK documents; shard evidence stays unmodified. */
export async function writeJourneyHtml(
  output: string,
  sources: Awaited<ReturnType<typeof readJourneyEvidence>>[],
  missing: string[] = [],
  extraLinks: { href: string; label: string }[] = [],
) {
  missing = [
    ...new Set([...missing, ...sources.flatMap((source) => source.issues)]),
  ];
  const all = sources.flatMap((source) =>
    source.report.run.results
      .filter((result) => result.selected)
      .map((result) => ({ source, result })),
  );
  const passed =
    sources.length > 0 &&
    missing.length === 0 &&
    sources.every(({ report, diagnostics }) =>
      journeyPassed(report.run, diagnostics.length),
    );
  const counts = sources.reduce(
    (sum, { report }) => ({
      passed: sum.passed + report.run.summary.passed,
      failed: sum.failed + report.run.summary.failed,
      skipped: sum.skipped + report.run.summary.skipped,
    }),
    { passed: 0, failed: 0, skipped: 0 },
  );
  const setupMs = sources.reduce(
    (sum, source) => sum + source.metrics.setupMs,
    0,
  );
  const journeyMs = sources.reduce(
    (sum, source) => sum + source.metrics.journeyMs,
    0,
  );
  const calls = all.reduce(
    (sum, { result }) =>
      sum +
      result.attempts.reduce(
        (n, a) =>
          n +
          a.steps.reduce(
            (m, s) =>
              m + s.events.filter((event) => event.kind === "model").length,
            0,
          ),
        0,
      ),
    0,
  );
  const tokens = sources.reduce(
    (sum, { report }) => sum + (report.run.usage?.modelTokens ?? 0),
    0,
  );
  const rows = all
    .map(({ source, result }, index) => {
      const attempt = result.attempts.at(-1);
      const boundary =
        result.status === "passed"
          ? "—"
          : !attempt
            ? "not executed"
            : journeyFailureBoundary(attempt.error);
      const diagnostic = source.diagnostics.find(
        (entry) =>
          entry.origin &&
          attempt?.steps.some(
            (step) =>
              step.api === "app.open" &&
              step.label.startsWith(`${entry.origin}/`),
          ),
      );
      const media = (attempt?.artifacts ?? [])
        .flatMap((artifact) => {
          const safe = artifact.path && localPath(artifact.path);
          if (!safe || !source.availableArtifacts.has(artifact.path ?? ""))
            return [];
          const href = `${source.prefix}run/results/${safe}`;
          if (artifact.kind === "screenshot")
            return [
              `<figure>${link(href, "Open screenshot")}<a href="${escape(href)}"><img loading="lazy" src="${escape(href)}" alt="${escape(result.titlePath.join(" / "))} — end state"></a></figure>`,
            ];
          if (artifact.kind === "video")
            return [
              `<figure><figcaption>${link(href, "Open video")}</figcaption><video controls preload="none" src="${escape(href)}"></video></figure>`,
            ];
          return [`<p>${link(href, artifact.path ?? artifact.kind)}</p>`];
        })
        .join("");
      const tracePath = attempt?.artifacts
        .map((artifact) => artifact.path)
        .find((value) => value?.includes("/attempt-"))
        ?.split("/attempt-")[0];
      const trace = tracePath && localPath(tracePath);
      const steps =
        attempt?.steps
          .map(
            (step) =>
              `<tr><td class="number">${seconds(Date.parse(step.startedAt) - Date.parse(attempt.startedAt))}</td><td>${escape(step.api)} ${escape(step.label)}${
                step.events.some((event) => event.detail)
                  ? `<ul>${step.events
                      .filter((event) => event.detail)
                      .map((event) => `<li>${escape(event.detail ?? "")}</li>`)
                      .join("")}</ul>`
                  : ""
              }${step.cache ? `<pre>Action replay: ${escape(JSON.stringify(step.cache, null, 2))}</pre>` : ""}</td><td>${escape(step.status)}</td><td class="number">${seconds(step.durationMs)}</td></tr>`,
          )
          .join("") ?? "";
      return `<details id="journey-${index}"><summary>${escape(result.status)} · ${escape(result.titlePath.join(" / "))} · ${attempt ? seconds(attempt.durationMs) : "not executed"}</summary><p>${escape(result.file)} · ${escape(boundary)}</p>${attempt?.error ? `<pre>${escape(`${attempt.error.code}: ${attempt.error.message ?? ""}`)}</pre>` : ""}<p>${link(`${source.prefix}run/report.json`, "SDK JSON")}${trace ? ` · ${link(`${source.prefix}run/results/${trace}/trace.md`, "SDK trace and app logs")}` : ""}${diagnostic ? ` · ${link(`${source.prefix}fixtures/${encodeURIComponent(diagnostic.file)}`, "Worker logs and fixture timing")}` : ""}</p><div class="media">${media}</div><div class="table"><table><thead><tr><th>At</th><th>Step</th><th>Result</th><th>Time</th></tr></thead><tbody>${steps}</tbody></table></div></details>`;
    })
    .join("");
  const evidence = sources
    .map(
      (source) =>
        `<li>${source.prefix ? `Shard ${escape(source.prefix.split("/")[1] ?? "unknown")}` : "This run"}: executed ${escape(source.report.run.startedAt)} · ${link(`${source.prefix}run/report.json`, "SDK JSON")} · ${link(`${source.prefix}run/junit.xml`, "JUnit")} · ${link(`${source.prefix}timings.json`, "Timing JSON")}</li>`,
    )
    .join("");
  const unknown = sources.some(
    ({ report }) => report.run.usage?.modelTokens === undefined,
  );
  const providerFailures = sources
    .filter((source) => source.providerDiagnostics.length > 0)
    .map(
      (source) =>
        `<h2>Provider diagnostics</h2><p>${link(`${source.prefix}provider-errors.jsonl`, "Download upstream provider diagnostics")}</p>${source.providerDiagnostics.map((entry) => `<pre>${escape(`${entry.timestamp} · ${entry.provider} · HTTP ${entry.status}${entry.requestId ? ` · ${entry.requestId}` : ""}\n${entry.body}`)}</pre>`).join("")}`,
    )
    .join("");
  await writeFile(
    path.join(output, "index.html"),
    await page(
      `<header><h1>Tester Army web journeys</h1><p><strong>${passed ? "Passed" : "Failed / incomplete"}</strong> · informational, outside the merge gate</p><p>${all.length} selected · ${counts.passed} passed · ${counts.failed} failed · ${counts.skipped} skipped</p></header><p>${sources.length ? `Recorded setup ${seconds(setupMs)} · journey execution ${seconds(journeyMs)} · ${calls} model calls${unknown ? "" : ` · ${tokens.toLocaleString("en-US")} model tokens`}` : "Timing and usage evidence unavailable."}</p><p class="note">Missing shards have unknown timings, not zero. Whole-result caching preserves the original execution timestamps below. SDK action replay still runs outcome checks. Boundaries identify where execution stopped, not a proven root cause.</p>${missing.length ? `<h2>Missing evidence</h2><ul>${missing.map((message) => `<li>${escape(message)}</li>`).join("")}</ul>` : ""}<h2>Journeys</h2>${rows}<h2>Evidence</h2><ul>${evidence}${extraLinks.map((entry) => `<li>${link(entry.href, entry.label)}</li>`).join("")}</ul>${
        sources.flatMap(({ report }) => report.run.errors).length
          ? `<h2>Run errors</h2><pre>${escape(
              JSON.stringify(
                sources.flatMap(({ report }) => report.run.errors),
                null,
                2,
              ),
            )}</pre>`
          : ""
      }${providerFailures}`,
    ),
  );
  return passed;
}

export async function writeStartupHtml(
  output: string,
  phase: string,
  message: string,
) {
  await writeFile(
    path.join(output, "index.html"),
    await page(
      `<header><h1>Tester Army web journeys</h1><p><strong>Failed / incomplete</strong> during ${escape(phase)}. No passing result was established.</p></header><pre>${escape(message)}</pre><p>${link("startup-failure.json", "Startup diagnostics")}</p>`,
    ),
  );
}
