import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { useTabParam } from "./useTabParam";

const tabSchema = z.enum(["details", "history"]);

describe("useTabParam", () => {
  it("passes a parsed owner tab to the route", () => {
    const setParam = vi.fn();
    const tabs = useTabParam(undefined, "details", tabSchema, setParam);

    tabs.onValueChange("history");

    expect(setParam).toHaveBeenCalledWith("history");
  });

  it("omits the default tab from the route", () => {
    const setParam = vi.fn();
    const tabs = useTabParam("history", "details", tabSchema, setParam);

    tabs.onValueChange("details");

    expect(setParam).toHaveBeenCalledWith(undefined);
  });

  it("refuses a tab outside the owner schema", () => {
    const setParam = vi.fn();
    const tabs = useTabParam(undefined, "details", tabSchema, setParam);

    tabs.onValueChange("admin");

    expect(setParam).not.toHaveBeenCalled();
  });
});
