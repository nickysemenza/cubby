import { AsyncLocalStorage } from "node:async_hooks";
const active = new AsyncLocalStorage<boolean>();
/** Background providers yield durable work rather than polling a sibling invocation. */
export const inWorkContext = (): boolean => active.getStore() === true;
export const withWorkContext = <T>(work: () => Promise<T>): Promise<T> =>
  active.run(true, work);
