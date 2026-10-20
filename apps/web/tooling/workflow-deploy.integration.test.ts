import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestDb } from "tooling/test-setup";
import { z } from "zod";

import { RUN_WORKFLOWS } from "../src/lib/workflows/run-workflows";
import {
  activateWorkflowDeployment,
  readWorkflowDeployment,
} from "../src/server/workflows/runs/activation";
import type { WebBuildProvenance } from "./web-build-provenance";
import {
  deployWorkflowWorker,
  type WorkflowDeployPorts,
} from "./workflow-deploy";

// Provider-boundary failures: activating an upload instead of the serving
// deployment; split traffic or wrong build/version; stale activation CAS;
// losing wake pagination after partial sends; rollback reusing an old epoch;
// malformed/auth failures becoming success; ambient/pooled production URLs;
// and leaked database connections after deploy or wake failures.
describe("Workflow deployment and activation", () => {
  const ctx = withTestDb();
  const deploymentA = "10000000-0000-4000-8000-000000000001";
  const deploymentB = "10000000-0000-4000-8000-000000000002";
  const deploymentC = "10000000-0000-4000-8000-000000000003";
  const versionA = "20000000-0000-4000-8000-000000000001";
  const versionB = "20000000-0000-4000-8000-000000000002";
  const sourceCommit = "a".repeat(40);
  const buildFingerprint = "b".repeat(64);
  const sourceFingerprint = "c".repeat(64);
  const buildMessage = `cubby-build:${buildFingerprint};source:${sourceFingerprint}`;
  const directUrl = "postgres://synthetic:synthetic@db.example.test/synthetic";

  beforeEach(() => vi.stubEnv("PRODUCTION_DIRECT_DATABASE_URL", directUrl));
  afterEach(() => vi.unstubAllEnvs());

  type Request = { url: URL; init: RequestInit | undefined };
  type InstancePage = {
    instances: { id: string; status: string }[];
    cursor: string | null;
  };
  function fixture() {
    const provenance: WebBuildProvenance = {
      fingerprint: buildFingerprint,
      sourceFresh: true,
      matchesSource: true,
      details: {
        reason: "verified",
        sourceCommit,
        sourceFingerprint,
        previewBuild: false,
      },
    };
    const deployments = new Map([
      [
        deploymentA,
        {
          id: deploymentA,
          versions: [{ version_id: versionA, percentage: 100 }],
        },
      ],
      [
        deploymentB,
        {
          id: deploymentB,
          versions: [{ version_id: versionB, percentage: 100 }],
        },
      ],
      [
        deploymentC,
        {
          id: deploymentC,
          versions: [{ version_id: versionA, percentage: 100 }],
        },
      ],
    ]);
    let serving = deploymentA;
    const requests: Request[] = [];
    const processes: string[][] = [];
    const urls: string[] = [];
    const events: string[] = [];
    const pages = new Map<string, InstancePage>();
    let closed = 0;
    let deployOutput = `Current Version ID: ${versionA}\n`;
    let override: (
      request: Request,
    ) => Promise<Response | undefined> = async () => undefined;
    let processFailure: Error | null = null;
    const annotations = {
      "workers/tag": sourceCommit,
      "workers/message": buildMessage,
    };
    const response = (result: unknown) =>
      Response.json({ success: true, errors: [], result });
    const ports: WorkflowDeployPorts = {
      connect: async (url) => {
        urls.push(url);
        return {
          db: ctx.db,
          close: async () => {
            closed++;
          },
        };
      },
      readProvenance: () => provenance,
      runCf: async (args) => {
        processes.push([...args]);
        if (processFailure) throw processFailure;
        return deployOutput;
      },
      request: async (url, init) => {
        const request = { url, init };
        requests.push(request);
        const overridden = await override(request);
        if (overridden) return overridden;
        const path = url.pathname;
        const id = path.split("/").at(-1)!;
        if (path.endsWith("/deployments") && init?.method === "POST") {
          const body = z
            .object({
              versions: z.array(
                z.object({ version_id: z.string(), percentage: z.number() }),
              ),
            })
            .parse(JSON.parse(String(init.body)));
          serving =
            body.versions[0]?.version_id === versionB
              ? deploymentB
              : deploymentC;
          return response(deployments.get(serving));
        }
        if (path.endsWith("/deployments"))
          return response({ deployments: [deployments.get(serving)] });
        if (path.includes("/deployments/"))
          return response(deployments.get(id));
        if (path.includes("/versions/")) return response({ id, annotations });
        if (path.endsWith("/instances")) {
          const workflow = path.split("/").at(-2)!;
          const cursor = url.searchParams.get("cursor") ?? "";
          const page = pages.get(`${workflow}:${cursor}`) ?? {
            instances: [],
            cursor: null,
          };
          return Response.json({
            success: true,
            errors: [],
            result: page.instances,
            result_info: { cursor: page.cursor },
          });
        }
        if (path.endsWith("/events/execution-control")) {
          const instance = path.split("/").at(-3)!;
          events.push(instance);
          return response({
            instanceId: instance,
            timestamp: "2026-05-04T00:00:00Z",
          });
        }
        throw new Error(`Unexpected synthetic provider request: ${path}`);
      },
    };
    const run = (
      mode: Parameters<typeof deployWorkflowWorker>[0]["mode"] = {
        kind: "deploy",
      },
    ) =>
      deployWorkflowWorker(
        { accountId: "synthetic-account", apiToken: "synthetic-token", mode },
        ports,
      );
    return {
      run,
      ports,
      requests,
      processes,
      urls,
      events,
      pages,
      provenance,
      deployments,
      annotations,
      closed: () => closed,
      serve: (id: string) => {
        serving = id;
      },
      output: (value: string) => {
        deployOutput = value;
      },
      failProcess: (error: Error) => {
        processFailure = error;
      },
      intercept: (handler: typeof override) => {
        override = handler;
      },
    };
  }

  it("verifies the built version and serving deployment before activating and waking", async () => {
    const f = fixture();
    f.pages.set(`${RUN_WORKFLOWS.STEP_RUN.name}:`, {
      instances: [
        { id: "synthetic-running", status: "running" },
        { id: "synthetic-complete", status: "complete" },
      ],
      cursor: null,
    });
    const result = await f.run();
    expect(result).toMatchObject({
      epoch: 1,
      deploymentId: deploymentA,
      workerVersion: versionA,
    });
    expect(await readWorkflowDeployment(ctx.db)).toMatchObject({
      epoch: 1,
      deploymentId: deploymentA,
    });
    expect(f.processes[0]).toEqual([
      "deploy",
      "--prebuilt",
      "--mode",
      "production",
      "--tag",
      sourceCommit,
      "--message",
      buildMessage,
    ]);
    expect(f.events).toEqual(["synthetic-running"]);
    for (const workflow of Object.values(RUN_WORKFLOWS))
      expect(result?.wakes[workflow.name]?.complete).toBe(true);
    expect(f.urls).toEqual([directUrl]);
    expect(f.closed()).toBe(1);
  });

  it.each([
    {
      status: 401,
      body: {
        success: false,
        errors: [{ code: 9000, message: "synthetic authorization failure" }],
      },
    },
    {
      status: 200,
      body: {
        success: false,
        errors: [{ code: 9001, message: "synthetic provider failure" }],
      },
    },
  ])(
    "preserves HTTP/provider failures without activating ($status)",
    async ({ status, body }) => {
      const f = fixture();
      f.intercept(async () => Response.json(body, { status }));
      await expect(f.run()).rejects.toThrow(JSON.stringify(body));
      expect(await readWorkflowDeployment(ctx.db)).toBeNull();
      expect(f.closed()).toBe(1);
    },
  );

  it.each(["split", "version", "source"] as const)(
    "refuses a mismatched serving target (%s)",
    async (kind) => {
      const f = fixture();
      if (kind === "split")
        f.deployments.set(deploymentA, {
          id: deploymentA,
          versions: [
            { version_id: versionA, percentage: 50 },
            { version_id: versionB, percentage: 50 },
          ],
        });
      if (kind === "version") f.output(`Current Version ID: ${versionB}\n`);
      if (kind === "source")
        f.annotations["workers/message"] = "synthetic-other-build";
      await expect(f.run()).rejects.toThrow(/100%|version|provenance|build/i);
      expect(await readWorkflowDeployment(ctx.db)).toBeNull();
      expect(f.events).toEqual([]);
      expect(f.closed()).toBe(1);
    },
  );

  it("revalidates the latest serving deployment immediately before activation", async () => {
    const f = fixture();
    let lists = 0;
    f.intercept(async ({ url }) => {
      if (url.pathname.endsWith("/deployments") && ++lists === 2)
        f.serve(deploymentB);
      return undefined;
    });
    await expect(f.run()).rejects.toThrow(
      /serving deployment changed|latest deployment changed/i,
    );
    expect(await readWorkflowDeployment(ctx.db)).toBeNull();
    expect(f.closed()).toBe(1);
  });

  it.each(["stale", "preview"] as const)(
    "refuses unverified local build output (%s)",
    async (kind) => {
      const f = fixture();
      if (kind === "stale") f.provenance.sourceFresh = false;
      else f.provenance.details.previewBuild = true;
      await expect(f.run()).rejects.toThrow(/provenance|rebuild|preview/i);
      expect(f.processes).toEqual([]);
      expect(f.requests).toEqual([]);
    },
  );

  it("refuses activate-only repair of a deployment that is no longer latest", async () => {
    const f = fixture();
    f.serve(deploymentB);
    await expect(
      f.run({
        kind: "activate",
        deploymentId: deploymentA,
        workerVersion: versionA,
      }),
    ).rejects.toThrow(/latest|serving/i);
    expect(await readWorkflowDeployment(ctx.db)).toBeNull();
    expect(f.processes).toEqual([]);
  });

  it("retains malformed provider response diagnostics", async () => {
    const f = fixture();
    f.intercept(async () => new Response("synthetic malformed provider body"));
    await expect(f.run()).rejects.toThrow("synthetic malformed provider body");
    expect(await readWorkflowDeployment(ctx.db)).toBeNull();
    expect(f.closed()).toBe(1);
  });

  it("retains the successful wake cursor and replays an interrupted page idempotently", async () => {
    const f = fixture();
    const workflow = RUN_WORKFLOWS.STEP_RUN.name;
    f.pages.set(`${workflow}:`, {
      instances: [{ id: "synthetic-first", status: "waiting" }],
      cursor: "second",
    });
    f.pages.set(`${workflow}:second`, {
      instances: [
        { id: "synthetic-second", status: "running" },
        { id: "synthetic-blocked", status: "running" },
      ],
      cursor: "third",
    });
    f.pages.set(`${workflow}:third`, {
      instances: [{ id: "synthetic-last", status: "queued" }],
      cursor: null,
    });
    let fail = true;
    f.intercept(async ({ url }) =>
      url.pathname.includes("/synthetic-blocked/") && fail
        ? new Response("synthetic wake outage", { status: 503 })
        : undefined,
    );
    await expect(f.run()).rejects.toThrow(/cutover incomplete/i);
    const incomplete = await readWorkflowDeployment(ctx.db);
    expect(incomplete).toMatchObject({
      epoch: 1,
      deploymentId: deploymentA,
      wakes: { [workflow]: { cursor: "second", complete: false } },
    });
    fail = false;
    const repaired = await f.run({
      kind: "activate",
      deploymentId: deploymentA,
      workerVersion: versionA,
    });
    expect(repaired?.epoch).toBe(1);
    expect(repaired?.wakes[workflow]).toEqual({ cursor: null, complete: true });
    const cursors = f.requests
      .filter(({ url }) => url.pathname.endsWith(`/${workflow}/instances`))
      .map(({ url }) => url.searchParams.get("cursor"));
    expect(cursors).toEqual([null, "second", "second", "third"]);
    expect(f.events.filter((id) => id === "synthetic-second")).toHaveLength(2);
    expect(f.processes).toHaveLength(1);
    for (const { url } of f.requests.filter(({ url }) =>
      url.pathname.endsWith("/instances"),
    )) {
      expect(url.searchParams.get("status")).toBeNull();
      expect(Number(url.searchParams.get("per_page"))).toBeLessThanOrEqual(100);
    }
    const sends = f.events.length;
    await f.run({
      kind: "activate",
      deploymentId: deploymentA,
      workerVersion: versionA,
    });
    expect(f.events).toHaveLength(sends);
    expect(f.closed()).toBe(3);
  });

  it("cannot overwrite a newer activation with a stale activator", async () => {
    const f = fixture();
    let lists = 0;
    f.intercept(async ({ url }) => {
      if (url.pathname.endsWith("/deployments") && ++lists === 2)
        await activateWorkflowDeployment(ctx.db, {
          deploymentId: deploymentB,
          workerVersion: versionB,
          expectedEpoch: 0,
        });
      return undefined;
    });
    await expect(f.run()).rejects.toThrow(/activation changed/i);
    expect(await readWorkflowDeployment(ctx.db)).toMatchObject({
      epoch: 1,
      deploymentId: deploymentB,
      workerVersion: versionB,
    });
    expect(f.events).toEqual([]);
  });

  it("accepts an empty terminal provider cursor without replaying the first page", async () => {
    const f = fixture();
    const workflow = RUN_WORKFLOWS.STEP_RUN.name;
    f.pages.set(`${workflow}:`, {
      instances: [{ id: "synthetic-terminal-cursor", status: "waiting" }],
      cursor: "",
    });
    const activation = await f.run();
    expect(activation.wakes[workflow]).toEqual({
      cursor: null,
      complete: true,
    });
    expect(
      f.requests.filter(({ url }) =>
        url.pathname.endsWith(`/${workflow}/instances`),
      ),
    ).toHaveLength(1);
    expect(f.events).toEqual(["synthetic-terminal-cursor"]);
  });

  it("activates rollback as a new deployment epoch even when returning to an earlier version", async () => {
    const f = fixture();
    expect((await f.run())?.epoch).toBe(1);
    expect(
      await f.run({ kind: "rollback", workerVersion: versionB }),
    ).toMatchObject({
      epoch: 2,
      deploymentId: deploymentB,
      workerVersion: versionB,
    });
    expect(
      await f.run({ kind: "rollback", workerVersion: versionA }),
    ).toMatchObject({
      epoch: 3,
      deploymentId: deploymentC,
      workerVersion: versionA,
    });
    expect(f.processes).toHaveLength(1);
    expect(f.closed()).toBe(3);
  });

  it("closes the database and leaves activation unchanged when cf deploy fails", async () => {
    const f = fixture();
    f.failProcess(new Error("synthetic deployment process failed"));
    await expect(f.run()).rejects.toThrow(
      "synthetic deployment process failed",
    );
    expect(await readWorkflowDeployment(ctx.db)).toBeNull();
    expect(f.requests).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  it.each([
    undefined,
    "postgres://synthetic:synthetic@db-pooler.example.test/synthetic",
  ])(
    "refuses missing or pooled explicit production URL before any effect",
    async (url) => {
      const f = fixture();
      vi.stubEnv("PRODUCTION_DIRECT_DATABASE_URL", url);
      vi.stubEnv("DATABASE_URL", directUrl);
      await expect(f.run()).rejects.toThrow(/PRODUCTION_DIRECT_DATABASE_URL/);
      expect(f.processes).toEqual([]);
      expect(f.requests).toEqual([]);
      expect(f.urls).toEqual([]);
    },
  );
});
