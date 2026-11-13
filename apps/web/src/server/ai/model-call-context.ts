import { AsyncLocalStorage } from "node:async_hooks";

/** A producer's transport calls share its one Ask claim, without a nested claim. */
const producing = new AsyncLocalStorage<boolean>();
export const insideModelAsk = () => producing.getStore() === true;
export const produceModel = <T>(work: () => Promise<T>): Promise<T> =>
  producing.run(true, work);
