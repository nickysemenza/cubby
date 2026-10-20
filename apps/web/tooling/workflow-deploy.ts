import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify, stripVTControlCharacters } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { forEachConcurrently } from "../src/lib/concurrency-limiter";
import { describeErrorCauses } from "../src/lib/error-diagnostics";
import { RUN_WORKFLOWS } from "../src/lib/workflows/run-workflows";
import type { Database } from "../src/server/db";
import { createDatabase } from "../src/server/db/database-runtime";
import * as schema from "../src/server/db/schema";
import {
  activateWorkflowDeployment,
  readWorkflowDeployment,
  recordWorkflowWakePage,
  WORKFLOW_CONTROL_EVENT,
  type WorkflowDeploymentActivation,
} from "../src/server/workflows/runs/activation";
import { resolveTargetUrl } from "./db-migrate";
import { createPostgresPool } from "./postgres-pool";
import {
  readWebBuildProvenance,
  type WebBuildProvenance,
} from "./web-build-provenance";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CF_CLI = fileURLToPath(
  new URL("../node_modules/cf/bin/cf", import.meta.url),
);
const WAKE_PAGE_SIZE = 100;
const MAX_WAKE_PAGES = 1_000;
const WAKE_CONCURRENCY = 4;

const deployMode = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deploy") }),
  z.object({
    kind: z.literal("activate"),
    deploymentId: z.uuid(),
    workerVersion: z.uuid(),
  }),
  z.object({ kind: z.literal("rollback"), workerVersion: z.uuid() }),
]);

export type WorkflowDeployPorts = {
  connect(url: string): Promise<{ db: Database; close(): Promise<void> }>;
  readProvenance(): WebBuildProvenance;
  runCf(args: readonly string[]): Promise<string>;
  request(url: URL, init?: RequestInit): Promise<Response>;
};

const providerDeployment = z.object({
  id: z.uuid(),
  versions: z.array(
    z.object({ version_id: z.uuid(), percentage: z.number().min(0).max(100) }),
  ),
});
const providerVersion = z.object({
  id: z.uuid(),
  annotations: z.record(z.string(), z.string()).default({}),
});
const providerInstance = z.object({
  id: z.string().min(1),
  status: z.enum([
    "queued",
    "running",
    "paused",
    "errored",
    "terminated",
    "complete",
    "waitingForPause",
    "waiting",
    "rollingBack",
  ]),
});
const providerEnvelope = z.object({
  success: z.boolean(),
  result: z.unknown(),
  errors: z.array(z.unknown()).default([]),
  result_info: z
    .object({ cursor: z.string().nullable().optional() })
    .optional(),
});
type ServingDeployment = Pick<
  WorkflowDeploymentActivation,
  "deploymentId" | "workerVersion"
>;
type DeployInput = {
  accountId: string;
  apiToken: string;
  mode: z.infer<typeof deployMode>;
};

function provider(input: DeployInput, ports: WorkflowDeployPorts) {
  const account = `/accounts/${encodeURIComponent(input.accountId)}`;
  const script = `/workers/scripts/${encodeURIComponent(RUN_WORKFLOWS.STEP_RUN.worker)}`;
  async function request<T>(
    path: string,
    resultSchema: z.ZodType<T>,
    init: RequestInit = {},
  ): Promise<{ result: T; cursor: string | null }> {
    const url = new URL(
      `https://api.cloudflare.com/client/v4${account}${path}`,
    );
    const response = await ports.request(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${input.apiToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    const failure = (cause?: unknown) =>
      new Error(
        `Cloudflare HTTP ${response.status} ${init.method ?? "GET"} ${url.pathname}: ${body}`,
        { cause },
      );
    if (!response.ok) throw failure();
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch (error) {
      throw failure(error);
    }
    const envelope = providerEnvelope.safeParse(raw);
    if (
      !envelope.success ||
      !envelope.data.success ||
      envelope.data.errors.length
    )
      throw failure();
    try {
      return {
        result: resultSchema.parse(envelope.data.result),
        cursor: envelope.data.result_info?.cursor || null,
      };
    } catch (error) {
      throw failure(error);
    }
  }
  function singleVersion(
    deployment: z.infer<typeof providerDeployment>,
  ): ServingDeployment {
    const version = deployment.versions[0];
    if (
      deployment.versions.length !== 1 ||
      !version ||
      version.percentage !== 100
    )
      throw new Error(
        `Deployment ${deployment.id} must serve exactly one version at 100% before activation`,
      );
    return { deploymentId: deployment.id, workerVersion: version.version_id };
  }
  return {
    async serving() {
      // Cloudflare defines the first listed deployment as the one serving traffic.
      // https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
      const { result } = await request(
        `${script}/deployments?per_page=1`,
        z.object({ deployments: z.array(providerDeployment) }),
      );
      const listed = result.deployments[0];
      if (!listed)
        throw new Error("Cloudflare returned no serving Worker deployment");
      const expected = singleVersion(listed);
      const { result: actual } = await request(
        `${script}/deployments/${encodeURIComponent(listed.id)}`,
        providerDeployment,
      );
      const served = singleVersion(actual);
      if (
        served.deploymentId !== expected.deploymentId ||
        served.workerVersion !== expected.workerVersion
      )
        throw new Error(
          "Latest serving deployment changed between provider list and get",
        );
      return served;
    },
    async version(id: string) {
      const { result } = await request(
        `${script}/versions/${encodeURIComponent(id)}`,
        providerVersion,
      );
      if (result.id !== id)
        throw new Error(
          `Cloudflare returned a different Worker version for ${id}`,
        );
      return result;
    },
    async rollback(workerVersion: string) {
      const { result } = await request(
        `${script}/deployments`,
        providerDeployment,
        {
          method: "POST",
          body: JSON.stringify({
            strategy: "percentage",
            versions: [{ version_id: workerVersion, percentage: 100 }],
          }),
        },
      );
      const deployed = singleVersion(result);
      if (deployed.workerVersion !== workerVersion)
        throw new Error("Rollback deployed a different Worker version");
      return deployed;
    },
    async instances(
      workflow: string,
      cursor: string | null,
      activatedAt: string,
    ) {
      // Keep the result set stable as wakes finish instances. Never paginate a
      // shrinking status-filtered queue, and stop at this activation's snapshot.
      // https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/list/
      const query = new URLSearchParams({
        per_page: String(WAKE_PAGE_SIZE),
        direction: "asc",
        date_end: activatedAt,
      });
      if (cursor) query.set("cursor", cursor);
      return request(
        `/workflows/${encodeURIComponent(workflow)}/instances?${query}`,
        z.array(providerInstance).max(WAKE_PAGE_SIZE),
      );
    },
    async wake(
      workflow: string,
      instance: string,
      activation: WorkflowDeploymentActivation,
    ) {
      await request(
        `/workflows/${encodeURIComponent(workflow)}/instances/${encodeURIComponent(instance)}/events/${WORKFLOW_CONTROL_EVENT}`,
        z.unknown(),
        {
          method: "POST",
          body: JSON.stringify({
            epoch: activation.epoch,
            deploymentId: activation.deploymentId,
          }),
        },
      );
    },
  };
}

const sameDeployment = (left: ServingDeployment, right: ServingDeployment) =>
  left.deploymentId === right.deploymentId &&
  left.workerVersion === right.workerVersion;

async function wakeWorkflows(
  db: Database,
  activation: WorkflowDeploymentActivation,
  cloudflare: ReturnType<typeof provider>,
) {
  for (const workflow of Object.values(RUN_WORKFLOWS)) {
    const saved = activation.wakes[workflow.name];
    if (saved?.complete) continue;
    let cursor = saved?.cursor ?? null;
    const visited = new Set<string | null>();
    let complete = false;
    for (let page = 0; page < MAX_WAKE_PAGES; page++) {
      visited.add(cursor);
      const current = await readWorkflowDeployment(db);
      if (
        !current ||
        current.epoch !== activation.epoch ||
        !sameDeployment(current, activation)
      )
        throw new Error(
          "Workflow wake cutover was superseded by a newer activation",
        );
      if (!sameDeployment(await cloudflare.serving(), activation))
        throw new Error(
          "Latest serving deployment changed during Workflow wake cutover",
        );
      const instances = await cloudflare.instances(
        workflow.name,
        cursor,
        activation.activatedAt,
      );
      if (instances.cursor !== null && visited.has(instances.cursor))
        throw new Error(
          `Cloudflare repeated a Workflow pagination cursor for ${workflow.name}`,
        );
      await forEachConcurrently(
        instances.result,
        WAKE_CONCURRENCY,
        async (instance) => {
          if (["complete", "errored", "terminated"].includes(instance.status))
            return;
          await cloudflare.wake(workflow.name, instance.id, activation);
        },
      );
      complete = instances.cursor === null;
      if (
        !(await recordWorkflowWakePage(db, {
          epoch: activation.epoch,
          workflow: workflow.name,
          cursor: instances.cursor,
          complete,
        }))
      )
        throw new Error(
          "Workflow wake cutover was superseded before its checkpoint committed",
        );
      activation.wakes[workflow.name] = { cursor: instances.cursor, complete };
      cursor = instances.cursor;
      if (complete) break;
    }
    if (!complete)
      throw new Error(
        `Workflow wake pagination exceeded ${MAX_WAKE_PAGES} pages for ${workflow.name}; resume activation`,
      );
  }
  return activation;
}

function builtVersion(output: string) {
  const versions = [
    ...stripVTControlCharacters(output).matchAll(
      /Current Version ID:\s*([a-f\d-]{36})/giu,
    ),
  ];
  if (versions.length !== 1)
    throw new Error(
      "cf deploy did not report exactly one Current Version ID; activation was not written",
    );
  return z.uuid().parse(versions[0]?.[1]);
}

/** Provider verification precedes the activation CAS; wake receipts follow successful whole pages. */
export async function deployWorkflowWorker(
  input: DeployInput,
  ports: WorkflowDeployPorts,
): Promise<WorkflowDeploymentActivation> {
  const connection = await ports.connect(resolveTargetUrl("production"));
  try {
    const prior = await readWorkflowDeployment(connection.db);
    const cloudflare = provider(input, ports);
    let workerVersion: string;
    let deploymentId: string | null = null;
    let build: { tag: string; message: string } | null = null;
    switch (input.mode.kind) {
      case "deploy": {
        const provenance = ports.readProvenance();
        if (!provenance.sourceFresh || provenance.details.previewBuild)
          throw new Error(
            `Unverified build provenance (${provenance.details.reason}); rebuild production output before deploying`,
          );
        const source = z
          .object({
            fingerprint: z.string().regex(/^[a-f\d]{64}$/u),
            details: z.object({
              sourceCommit: z.string().regex(/^[a-f\d]{40}$/u),
              sourceFingerprint: z.string().regex(/^[a-f\d]{64}$/u),
            }),
          })
          .parse(provenance);
        build = {
          tag: source.details.sourceCommit,
          message: `cubby-build:${source.fingerprint};source:${source.details.sourceFingerprint}`,
        };
        workerVersion = builtVersion(
          await ports.runCf([
            "deploy",
            "--prebuilt",
            "--mode",
            "production",
            "--tag",
            build.tag,
            "--message",
            build.message,
          ]),
        );
        break;
      }
      case "activate":
        ({ workerVersion, deploymentId } = input.mode);
        break;
      case "rollback": {
        workerVersion = input.mode.workerVersion;
        await cloudflare.version(workerVersion);
        deploymentId = (await cloudflare.rollback(workerVersion)).deploymentId;
        break;
      }
      default: {
        const exhaustive: never = input.mode;
        throw new Error(
          `Unknown Workflow deployment mode: ${String(exhaustive)}`,
        );
      }
    }
    const serving = await cloudflare.serving();
    if (
      serving.workerVersion !== workerVersion ||
      (deploymentId && serving.deploymentId !== deploymentId)
    )
      throw new Error(
        `Latest serving deployment/version does not match the intended target ${deploymentId ?? "cf deploy"}/${workerVersion}`,
      );
    const version = await cloudflare.version(workerVersion);
    if (
      build &&
      (version.annotations["workers/tag"] !== build.tag ||
        version.annotations["workers/message"] !== build.message)
    )
      throw new Error(
        `Serving Worker version ${workerVersion} does not match the built source provenance`,
      );
    if (!sameDeployment(await cloudflare.serving(), serving))
      throw new Error(
        "Latest serving deployment changed before activation; no activation was written",
      );
    const activation = await activateWorkflowDeployment(connection.db, {
      ...serving,
      expectedEpoch: prior?.epoch ?? 0,
    });
    try {
      return await wakeWorkflows(connection.db, activation, cloudflare);
    } catch (error) {
      throw new Error(
        `Workflow cutover incomplete after activation epoch ${activation.epoch}. Resume with --activate-only=${activation.deploymentId} --version=${activation.workerVersion}. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  } finally {
    await connection.close();
  }
}

const productionPorts: WorkflowDeployPorts = {
  connect: async (url) => {
    const pool = createPostgresPool({ connectionString: url, max: 1 });
    const client = drizzle(pool, { schema });
    return {
      db: createDatabase(() => ({
        client,
        withConnection: (work) => work(client),
      })),
      close: () => pool.end(),
    };
  },
  readProvenance: () => readWebBuildProvenance(REPO_ROOT),
  runCf: async (args) => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [CF_CLI, ...args],
      {
        cwd: WEB_ROOT,
        env: process.env,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    return stdout;
  },
  request: (url, init) => fetch(url, init),
};

async function main() {
  const { values } = parseArgs({
    options: {
      "activate-only": { type: "string" },
      rollback: { type: "string" },
      version: { type: "string" },
    },
  });
  if (
    (values["activate-only"] && values.rollback) ||
    (values.rollback && values.version) ||
    (values.version && !values["activate-only"])
  )
    throw new Error(
      "Use default deploy, --activate-only=deployment --version=version, or --rollback=version",
    );
  const mode = deployMode.parse(
    values["activate-only"]
      ? {
          kind: "activate",
          deploymentId: values["activate-only"],
          workerVersion: values.version,
        }
      : values.rollback
        ? { kind: "rollback", workerVersion: values.rollback }
        : { kind: "deploy" },
  );
  const credentials = z
    .object({ accountId: z.string().min(1), apiToken: z.string().min(1) })
    .parse({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
    });
  const activation = await deployWorkflowWorker(
    { ...credentials, mode },
    productionPorts,
  );
  console.log(
    `[workflow-deploy] Activated deployment ${activation.deploymentId}, version ${activation.workerVersion}, epoch ${activation.epoch}; Workflow wake cutover complete.`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(describeErrorCauses(error, { includeStacks: true }));
    process.exitCode = 1;
  }
}
