type SynchronousKeys<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => infer Result
    ? Result extends PromiseLike<unknown>
      ? never
      : K
    : K;
}[keyof T];

type MethodArguments<Method> = Method extends (
  ...args: infer Args
) => infer Result
  ? Result extends PromiseLike<unknown>
    ? Args
    : never
  : never;
type MethodResult<Method> = Method extends (...args: never[]) => infer Result
  ? Result extends PromiseLike<unknown>
    ? Result
    : never
  : never;

/** Request-local async methods share one implementation; sync members stay explicit. */
export function deferredService<T extends object>(
  load: () => Promise<T>,
  synchronous: (loaded: () => Promise<T>) => Pick<T, SynchronousKeys<T>>,
): T {
  let pending: Promise<T> | undefined;
  const loaded = () => (pending ??= Promise.resolve().then(load));
  const target = synchronous(loaded);
  // SAFETY: the exhaustive synchronous-member map supplies every non-async
  // public member. Remaining methods delegate with the real instance as `this`.
  return new Proxy(target, {
    get(object, key) {
      if (key in object) {
        // SAFETY: the membership check includes inherited synchronous Object methods.
        const synchronousKey = key as keyof typeof object;
        return object[synchronousKey];
      }
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ECMAScript Proxy symbol/then probes are protocol lookups, not domain input.
      if (key === "then" || typeof key === "symbol") return undefined;
      return (...args: MethodArguments<T[keyof T]>) =>
        loaded().then((service) => {
          // SAFETY: synchronous members returned above; this branch contains
          // only async public methods and preserves their argument/result union.
          const method = service[key as keyof T] as (
            ...args: MethodArguments<T[keyof T]>
          ) => MethodResult<T[keyof T]>;
          return method.apply(service, args);
        });
    },
  }) as T;
}
