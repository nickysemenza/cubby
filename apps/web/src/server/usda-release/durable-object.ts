import type { DurableObjectState } from "@cloudflare/workers-types";
import type { FoodLookupParam } from "@cubby/usda";
import {
  foodSearchArgs,
  manifestKey,
  releaseFromObjectName,
  releaseManifest,
  ShardLoadError,
  UsdaReleaseStore,
  type FoodSearchArgs,
  type ReleaseId,
  type ReleaseManifest,
} from "@cubby/usda/release";
import { DurableObject } from "cloudflare:workers";

import { getErrorMessage } from "~/lib/error-utils";

import type { UsdaReleaseRpc } from "./rpc";

const RETRY_DELAY_MS = 30_000;

/**
 * One immutable USDA release (ADR 0008). The first touch reads the release
 * manifest and starts an alarm loop that loads one R2 shard per alarm; reads
 * throw the raw load state until every shard is in.
 */
export class UsdaReleaseDurableObject
  extends DurableObject<Env>
  implements UsdaReleaseRpc
{
  private readonly release: ReleaseId;
  private readonly store: UsdaReleaseStore;
  private alarmRunning = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.release = releaseFromObjectName(ctx.id.name ?? "");
    this.store = new UsdaReleaseStore(ctx.storage.sql, (fn) =>
      ctx.storage.transactionSync(fn),
    );
    this.store.init();
  }

  // Every call re-checks that a loading release still has an alarm: one the
  // platform gave up retrying after a killed invocation is not rescheduled
  // by anything else.
  private async start() {
    if (!this.store.hasStarted()) {
      const manifest = await this.readManifest();
      // Another call may have started the load while the manifest read awaited.
      if (!this.store.hasStarted()) this.store.begin(this.release, manifest);
    }
    if (
      this.store.isLoading() &&
      !this.alarmRunning &&
      (await this.ctx.storage.getAlarm()) === null
    )
      await this.ctx.storage.setAlarm(Date.now());
  }

  // Unreadable manifests are not persisted: the next call retries the read.
  private async readManifest(): Promise<ReleaseManifest> {
    const key = manifestKey(this.release);
    const object = await this.env.USDA_RELEASES.get(key);
    if (!object) throw new Error(`Missing USDA release manifest ${key}`);
    try {
      return releaseManifest.parse(await object.json());
    } catch (error) {
      throw new Error(
        `Unreadable USDA release manifest ${key}: ${getErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async alarm() {
    this.alarmRunning = true;
    try {
      await this.loadNextShard();
    } finally {
      this.alarmRunning = false;
    }
  }

  private async loadNextShard() {
    const key = this.store.beginShardAttempt();
    if (!key) return;
    try {
      const object = await this.env.USDA_RELEASES.get(key);
      if (!object) throw new Error(`Missing USDA release shard ${key}`);
      const text = await new Response(
        object.body.pipeThrough(new DecompressionStream("gzip")),
      ).text();
      this.store.applyShard(key, text);
    } catch (error) {
      const retry = this.store.recordShardFailure({
        message: getErrorMessage(error),
        permanent: error instanceof ShardLoadError,
      });
      if (retry) await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
      return;
    }
    if (this.store.isLoading()) await this.ctx.storage.setAlarm(Date.now());
  }

  /** Resumes a failed load from its last committed shard. */
  async resume() {
    await this.start();
    this.store.resume();
    await this.start();
    return this.store.status();
  }

  async status() {
    await this.start();
    return this.store.status();
  }

  async counts() {
    await this.start();
    return this.store.counts();
  }

  async getFood(fdcId: number) {
    await this.start();
    return this.store.getFood(fdcId);
  }

  async lookupBatch(lookups: FoodLookupParam[]) {
    await this.start();
    return this.store.lookupBatch(lookups);
  }

  async search(args: FoodSearchArgs) {
    await this.start();
    return this.store.search(foodSearchArgs.parse(args));
  }
}
