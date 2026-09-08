import { getMealPreparationsOut, mealOut } from "@cubby/schemas/meal";
import { testShortcode } from "@cubby/schemas/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import { ledgerParty } from "../../finance/finance.functions";
import { meal } from "../meal.functions";
import { useMealPreparationController } from "./use-meal-preparation-controller";

it("waits for meal detail when preparations resolve first, then uses the meal's date range", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const mealId = testShortcode("meal", "MEA-2222");
  const preparation = mock(getMealPreparationsOut, {
    overrides: { mealId, preparations: [] },
  });
  client.setQueryData(meal.getPreparations.queryKey({ mealId }), preparation);
  client.setQueryData(ledgerParty.options.queryKey(null), []);
  const target = mock(mealOut, {
    overrides: { id: mealId, date: "2026-03-15", recipes: [] },
  });
  client.setQueryData(
    meal.getByDateRange.queryKey({ from: "2026-02-13", to: "2026-04-14" }),
    [target],
  );
  client.setQueryData(
    meal.getByDateRange.queryKey({ from: "2026-02-13", to: "2026-03-15" }),
    [],
  );
  const requests: unknown[] = [];
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (
      event.query.queryKey[1] === meal.getByDateRange.id &&
      event.query.state.fetchStatus === "fetching"
    )
      requests.push(event.query.queryKey);
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  const hook = renderHook<
    ReturnType<typeof useMealPreparationController>,
    { date: string | undefined }
  >(
    ({ date }) =>
      useMealPreparationController({
        mealId,
        mealDate: date,
        invalidate: () => {},
      }),
    { initialProps: { date: undefined }, wrapper: Wrapper },
  );
  try {
    await act(async () => {});
    expect(hook.result.current.view).toEqual(preparation);
    expect(hook.result.current.targetMeals).toEqual([]);
    expect(requests).toEqual([]);
    hook.rerender({ date: "2026-03-15" });
    expect(hook.result.current.targetMeals.map((row) => row.id)).toEqual([
      mealId,
    ]);
    expect(requests).toEqual([]);
  } finally {
    hook.unmount();
    unsubscribe();
    client.clear();
  }
});
