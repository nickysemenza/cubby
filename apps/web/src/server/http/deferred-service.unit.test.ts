import { describe, expect, it } from "vitest";

import { deferredService } from "./deferred-service";

// Failure modes: eager imports, duplicate initialization under concurrent use,
// a lost method receiver, state shared across requests, swallowed load errors,
// or synchronous transaction binding that accidentally uses the original DB.
class Service {
  constructor(readonly database: string) {}

  async read() {
    return this.database;
  }

  bindTo(database: string) {
    return new Service(database);
  }
}

const lazy = (load: () => Promise<Service>, database: string): Service =>
  deferredService(load, (loaded) => ({
    database,
    bindTo: (selected) =>
      lazy(async () => (await loaded()).bindTo(selected), selected),
  }));

describe("deferred service lifecycle", () => {
  it("initializes once on concurrent use and keeps the real receiver", async () => {
    let loads = 0;
    const service = lazy(async () => {
      loads++;
      return new Service("request");
    }, "request");
    expect(loads).toBe(0);
    expect(await Promise.all([service.read(), service.read()])).toEqual([
      "request",
      "request",
    ]);
    expect(loads).toBe(1);
  });

  it("keeps independent request state and deferred transaction binding", async () => {
    let loads = 0;
    const make = (database: string) =>
      lazy(async () => {
        loads++;
        return new Service(database);
      }, database);
    const first = make("first");
    const second = make("second");
    const transaction = first.bindTo("transaction");
    expect(transaction.database).toBe("transaction");
    expect(loads).toBe(0);
    expect(
      await Promise.all([first.read(), second.read(), transaction.read()]),
    ).toEqual(["first", "second", "transaction"]);
    expect(loads).toBe(2);
  });

  it("preserves the original load error", async () => {
    const error = new Error("synthetic module load failure");
    const service = lazy(async () => {
      throw error;
    }, "request");
    await expect(service.read()).rejects.toBe(error);
    await expect(service.read()).rejects.toBe(error);
  });
});
