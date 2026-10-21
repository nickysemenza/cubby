/**
 * A finite set of preparations. Waiting for a decision releases the item's
 * preparation slot; when every runnable item has reached a decision or ended,
 * dispatch that wave together. Resumption uses the same bounded admission.
 */
export async function settleDecisionWork<T, Q, A, V>(
  items: readonly T[],
  work: (item: T, ask: (question: Q) => Promise<A>) => Promise<V>,
  decide: (questions: readonly Q[]) => Promise<PromiseSettledResult<A>[]>,
  concurrency = 4,
): Promise<PromiseSettledResult<V>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("Decision preparation concurrency must be positive");
  type Owner = {
    phase: "queued" | "running" | "waiting" | "done";
    pending: number;
    queued: boolean;
    ready: (() => void)[];
  };
  type Pending = {
    owner: Owner;
    question: Q;
    resolve(value: A): void;
    reject(reason: unknown): void;
  };
  const queued: Owner[] = [];
  const waiting: Pending[] = [];
  let active = 0;
  let flushing = false;

  const enqueue = (owner: Owner) => {
    if (!owner.queued) {
      owner.queued = true;
      queued.push(owner);
    }
  };

  const deliver = (entry: Pending, result: PromiseSettledResult<A>) => {
    const owner = entry.owner;
    owner.pending--;
    const answer = () =>
      result.status === "fulfilled"
        ? entry.resolve(result.value)
        : entry.reject(result.reason);
    if (owner.phase === "done") answer();
    else {
      owner.ready.push(answer);
      if (!owner.pending) enqueue(owner);
    }
  };

  const pump = () => {
    while (queued.length && active < concurrency) {
      const owner = queued.shift()!;
      owner.queued = false;
      if (owner.phase === "done" || owner.pending) continue;
      if (owner.phase !== "running") {
        owner.phase = "running";
        active++;
      }
      for (const resume of owner.ready.splice(0)) resume();
    }
    if (active || queued.length || flushing || !waiting.length) return;
    flushing = true;
    const wave = waiting.splice(0);
    void Promise.resolve()
      .then(() => decide(wave.map((entry) => entry.question)))
      .then(
        (results) => {
          wave.forEach((entry, index) => {
            deliver(
              entry,
              results[index] ?? {
                status: "rejected",
                reason: new Error("Decision batch omitted an answer"),
              },
            );
          });
        },
        (error: unknown) => {
          for (const entry of wave)
            deliver(entry, { status: "rejected", reason: error });
        },
      )
      .finally(() => {
        flushing = false;
        pump();
      });
  };

  const results = items.map((item) => {
    const owner: Owner = {
      phase: "queued",
      pending: 0,
      queued: false,
      ready: [],
    };
    return new Promise<V>((resolve, reject) => {
      owner.ready.push(() => {
        const ask = (question: Q) =>
          new Promise<A>((answer, fail) => {
            if (owner.phase === "done") {
              fail(new Error("Decision work item has already settled"));
              return;
            }
            if (owner.phase === "running") active--;
            owner.phase = "waiting";
            owner.pending++;
            waiting.push({ owner, question, resolve: answer, reject: fail });
            pump();
          });
        void Promise.resolve()
          .then(() => work(item, ask))
          .then(resolve, reject)
          .finally(() => {
            if (owner.phase === "running") active--;
            owner.phase = "done";
            pump();
          });
      });
      enqueue(owner);
    });
  });
  const settled = Promise.allSettled(results);
  pump();
  return settled;
}
