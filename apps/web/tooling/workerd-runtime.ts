import {
  createLocalGoogleProvider,
  type LocalGoogleProvider,
} from "./local-google-provider";
import { createE2EObjectStorage } from "./local-object-storage";
import type { DatabaseLease } from "./test-database-lease";
import {
  closeOnce,
  startWorkerdHarness,
  WORKERD_PROFILES,
  type WorkerdHarness,
  type WorkerdHarnessOptions,
  type WorkerdProfile,
} from "./workerd-harness";

export interface WorkerdRuntimeOptions {
  profile: WorkerdProfile;
  /**
   * `lease`: check out a database the runtime releases on close.
   * `borrowed`: a database its caller owns (a Vitest `withTestDb` context);
   * the runtime never closes it.
   */
  database: { lease: () => Promise<DatabaseLease> } | { borrowed: string };
  /**
   * Omitted: object storage is unreachable. Present: local S3-compatible
   * storage owned by the runtime; `publish` also serves it at a public origin, for live model
   * peers that fetch the Worker's public object URLs. A borrowed endpoint and
   * public URL belong to the caller and survive close or failed acquisition.
   */
  objectStorage?:
    | { borrowed: NonNullable<WorkerdHarnessOptions["objectStorage"]> }
    | {
        /** Public identity of a local bucket; a browser peer supplies its asset transport. */
        publicUrl?: string;
        publish?: (
          url: string,
        ) => Promise<{ origin: string; close(): Promise<void> }>;
      };
  models?: WorkerdHarnessOptions["models"];
  /** Called after each acquisition, to attribute a slow or failed start. */
  onPhase?: (phase: string) => void;
}

export interface WorkerdRuntime {
  profile: WorkerdProfile;
  harness: WorkerdHarness;
  /** Origin of the primary (web) Worker. */
  origin: string;
  databaseUrl: string;
  /** The leased database's name; absent for a borrowed database. */
  databaseName?: string;
  /** Present when `objectStorage` was requested. */
  objectStorageUrl?: string;
  /** Present when the profile has `googleProvider`. */
  googleProvider?: LocalGoogleProvider;
  /** Idempotent; releases everything the runtime acquired, newest first. */
  close(): Promise<void>;
}

/**
 * One listening Cubby Worker and everything it needs: a database, object
 * storage, the profile's external peers, and the workerd harness.
 *
 * Resources are acquired in that order and `close()` releases them newest
 * first, running every release even when one fails; it is idempotent and
 * never closes a borrowed database. `prepare` runs against the listening
 * runtime before it is returned (signing in, loading a scenario). If any
 * acquisition or `prepare` throws, everything acquired so far is released
 * before the error propagates, so a failed start leaks no workerd, lease, or
 * environment change.
 */
export async function openWorkerdRuntime<T>(
  options: WorkerdRuntimeOptions,
  prepare: (runtime: WorkerdRuntime) => Promise<T>,
): Promise<{ runtime: WorkerdRuntime; prepared: T }> {
  // Released on any throw below; `move()` hands ownership to `close()`.
  await using cleanup = new AsyncDisposableStack();
  const phase = options.onPhase ?? (() => {});
  let databaseUrl: string;
  let databaseName: string | undefined;
  if ("lease" in options.database) {
    const lease = await options.database.lease();
    cleanup.defer(lease.close);
    databaseUrl = lease.databaseUrl;
    databaseName = lease.name;
    phase("database checkout");
  } else {
    databaseUrl = options.database.borrowed;
  }

  let objectStorage: WorkerdHarnessOptions["objectStorage"];
  if (options.objectStorage && "borrowed" in options.objectStorage) {
    objectStorage = options.objectStorage.borrowed;
  } else if (options.objectStorage) {
    const storage = await createE2EObjectStorage();
    cleanup.defer(storage.close);
    let publicUrl = options.objectStorage.publicUrl ?? storage.url;
    if (options.objectStorage.publish) {
      const published = await options.objectStorage.publish(storage.url);
      cleanup.defer(published.close);
      publicUrl = published.origin;
    }
    objectStorage = { endpoint: storage.url, publicUrl };
    phase("object storage");
  }

  const googleProvider = WORKERD_PROFILES[options.profile].googleProvider
    ? await createLocalGoogleProvider()
    : undefined;
  if (googleProvider) cleanup.defer(googleProvider.close);

  const harness = await startWorkerdHarness({
    profile: options.profile,
    databaseUrl,
    objectStorage,
    googleProviderUrl: googleProvider?.url,
    models: options.models,
  });
  cleanup.defer(harness.close);
  const { url } = await harness.listen();
  phase("harness create+listen");

  let prepared: T;
  const runtime: WorkerdRuntime = {
    profile: options.profile,
    harness,
    origin: url.origin,
    databaseUrl,
    databaseName,
    objectStorageUrl: objectStorage?.endpoint,
    googleProvider,
    // Until `prepare` succeeds, the stack still owns every resource.
    close: () => cleanup.disposeAsync(),
  };
  try {
    prepared = await prepare(runtime);
  } catch (error) {
    harness.debug();
    throw error;
  }
  runtime.close = closeOnce(cleanup.move());
  return { runtime, prepared };
}

/**
 * Open a runtime, run `run` against it, and close it whether `run` succeeds
 * or throws. A failure in `run` comes first; a cleanup failure after it is
 * aggregated with it rather than replacing it.
 */
export async function withWorkerdRuntime<T>(
  options: WorkerdRuntimeOptions,
  run: (runtime: WorkerdRuntime) => Promise<T>,
): Promise<T> {
  const { runtime } = await openWorkerdRuntime(options, async () => undefined);
  let result: T;
  try {
    result = await run(runtime);
  } catch (error) {
    try {
      await runtime.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Workerd runtime run failed and its cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
  await runtime.close();
  return result;
}
