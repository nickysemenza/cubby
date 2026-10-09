import type { DurableObjectState } from "@cloudflare/workers-types";
import type { FoodLookupParam } from "@cubby/usda";
import type { ListFoodsArgs } from "@cubby/usda/contract";
import {
  manifestKey,
  releaseFromObjectName,
  releaseManifest,
  ShardLoadError,
  UsdaReleaseStore,
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.release = releaseFromObjectName(ctx.id.name ?? "");
    this.store = new UsdaReleaseStore(ctx.storage.sql, (fn) =>
      ctx.storage.transactionSync(fn),
    );
    this.store.init();
  }

  private async start() {
    if (this.store.hasStarted()) return;
    const manifest = await this.readManifest();
    // Another call may have started the load while the manifest read awaited.
    if (this.store.hasStarted()) return;
    this.store.begin(this.release, manifest);
    if (!(manifest instanceof Error))
      await this.ctx.storage.setAlarm(Date.now());
  }

  private async readManifest(): Promise<ReleaseManifest | Error> {
    const key = manifestKey(this.release);
    try {
      const object = await this.env.USDA_RELEASES.get(key);
      if (!object) return new Error(`Missing USDA release manifest ${key}`);
      return releaseManifest.parse(await object.json());
    } catch (error) {
      return new Error(
        `Unreadable USDA release manifest ${key}: ${getErrorMessage(error)}`,
      );
    }
  }

  async alarm() {
    const key = this.store.nextShardKey();
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
    if (this.store.nextShardKey()) await this.ctx.storage.setAlarm(Date.now());
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

  async search(args: ListFoodsArgs) {
    await this.start();
    return this.store.search(args);
  }
}
