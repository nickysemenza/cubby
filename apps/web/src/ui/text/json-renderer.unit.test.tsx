import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import JsonRenderer from "./json-renderer";

it("reveals nested JSON without interpreting strings as markup", async () => {
  const { container } = render(
    <JsonRenderer
      input={{ record: { note: "<script>synthetic</script>", count: 0 } }}
      pretty
    />,
  );
  expect(screen.queryByText(/<script>/)).toBeNull();
  fireEvent.click(screen.getByText(/record.*2 fields/));
  expect(await screen.findByText('"<script>synthetic</script>"')).toBeVisible();
  expect(screen.getByText("0")).toBeVisible();
  expect(container.querySelector("script")).toBeNull();
});
