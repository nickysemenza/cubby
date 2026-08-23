import { test as base, expect } from "@playwright/test";

const test = base.extend({
  baseURL: async ({ browserName: _browserName }, use) => {
    const baseURL = process.env.E2E_BASE_URL;
    if (!baseURL) {
      throw new Error("E2E_BASE_URL was not provided by global setup");
    }
    await use(baseURL);
  },
});

export { expect, test };
