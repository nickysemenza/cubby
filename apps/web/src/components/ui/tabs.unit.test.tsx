import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tabs, TabsList, TabsTrigger } from "./tabs";

describe("Tabs phone sizing", () => {
  it("keeps each tab on the 44px touch floor", () => {
    render(
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
      </Tabs>,
    );

    expect(screen.getByRole("tab", { name: "Overview" })).toHaveClass(
      "min-h-11",
      "min-w-11",
      "md:min-h-0",
      "md:min-w-0",
    );
  });
});
