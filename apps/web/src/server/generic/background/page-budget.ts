/** Background payloads share an isolate with other invocations and HTTP work. */
const ISOLATE_PAGE_LIMIT = 2;
export const BACKGROUND_RECHECK_MS = 15_000;

// Only synchronous ownership is global: another request never awaits our I/O.
let activePages = 0;
const tryAcquirePage = (): (() => void) | undefined => {
  if (activePages >= ISOLATE_PAGE_LIMIT) return undefined;
  activePages++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    activePages--;
  };
};

export type PageAdmission<T> =
  | { kind: "started"; value: T }
  | { kind: "held"; retryAt: Date };
export type PageWork = <T>(work: () => Promise<T>) => Promise<PageAdmission<T>>;

/** Standalone domain journeys may run without the production round's policy. */
export async function runBackgroundPage<T>(input: {
  work: () => Promise<T>;
  admit?: PageWork;
}): Promise<PageAdmission<T>> {
  return input.admit
    ? input.admit(input.work)
    : { kind: "started", value: await input.work() };
}
type WorkClass = "job" | "feature";
type PendingPage = {
  start(release: () => void): void;
  hold(): void;
};

export type BackgroundPageBudget = {
  jobs: PageWork;
  feature: PageWork;
  snapshot(): {
    started: number;
    held: number;
    peakLocalPages: number;
    peakIsolatePages: number;
    retryAt: Date | null;
  };
  finishFeatures(): void;
  close(): Promise<void>;
};

/** Count participating pages, not bytes; this does not bound total isolate heap. */
export function createBackgroundPageBudget(input: {
  deadline: number;
  featuresPending?: boolean;
}): BackgroundPageBudget {
  const pending = { job: Array<PendingPage>(), feature: Array<PendingPage>() };
  const running = new Set<Promise<void>>();
  let turn: WorkClass = "job";
  let localPages = 0;
  let localJobs = 0;
  let featuresPending = input.featuresPending ?? false;
  let started = 0;
  let held = 0;
  let peakLocalPages = 0;
  let peakIsolatePages = 0;
  let retryAt: Date | null = null;
  let closed = false;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const holdAll = () => {
    clearTimer();
    for (const queue of Object.values(pending))
      for (const page of queue.splice(0)) page.hold();
  };
  const schedule = () => {
    if (scheduled || closed) return;
    scheduled = true;
    // Register both work classes before choosing the first pair of pages.
    queueMicrotask(() => {
      scheduled = false;
      pump();
    });
  };
  const pump = () => {
    clearTimer();
    if (closed || Date.now() >= input.deadline) {
      holdAll();
      return;
    }
    while (pending.job.length || pending.feature.length) {
      // Pending feature children retain the traversal's opportunity beside its Job.
      const selected =
        featuresPending && localJobs > 0
          ? "feature"
          : pending[turn].length
            ? turn
            : turn === "job"
              ? "feature"
              : "job";
      if (!pending[selected].length) return;
      const release = tryAcquirePage();
      if (!release) {
        if (!localPages) holdAll();
        else
          // Poll only a scalar, under this request's lifetime and deadline.
          timer = setTimeout(
            schedule,
            Math.min(1_000, Math.max(1, input.deadline - Date.now())),
          );
        return;
      }
      const page = pending[selected].shift();
      if (!page) {
        release();
        break;
      }
      turn = selected === "job" ? "feature" : "job";
      localPages++;
      if (selected === "job") localJobs++;
      peakLocalPages = Math.max(peakLocalPages, localPages);
      peakIsolatePages = Math.max(peakIsolatePages, activePages);
      page.start(() => {
        localPages--;
        if (selected === "job") localJobs--;
        release();
        schedule();
      });
    }
  };
  const enqueue = <T>(
    kind: WorkClass,
    work: () => Promise<T>,
  ): Promise<PageAdmission<T>> =>
    new Promise((resolve, reject) => {
      const hold = () => {
        held++;
        retryAt ??= new Date(Date.now() + BACKGROUND_RECHECK_MS);
        resolve({ kind: "held", retryAt });
      };
      if (closed || Date.now() >= input.deadline) {
        hold();
        return;
      }
      pending[kind].push({
        hold,
        start: (release) => {
          const finished = Promise.withResolvers<void>();
          running.add(finished.promise);
          void (async () => {
            try {
              if (closed || Date.now() >= input.deadline) {
                hold();
                return;
              }
              started++;
              resolve({ kind: "started", value: await work() });
            } catch (error) {
              reject(error);
            } finally {
              release();
              running.delete(finished.promise);
              finished.resolve();
            }
          })();
        },
      });
      schedule();
    });
  return {
    jobs: (work) => enqueue("job", work),
    feature: (work) => enqueue("feature", work),
    snapshot: () => ({
      started,
      held,
      peakLocalPages,
      peakIsolatePages,
      retryAt,
    }),
    finishFeatures: () => {
      featuresPending = false;
      schedule();
    },
    close: async () => {
      closed = true;
      holdAll();
      await Promise.allSettled(running);
    },
  };
}
