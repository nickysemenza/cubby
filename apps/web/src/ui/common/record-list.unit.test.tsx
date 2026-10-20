import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import {
  RecordDetail,
  recordColumnsOf,
  RecordList,
  RecordRow,
} from "./record-list";

it("opens and closes a disclosure, default-open or not", async () => {
  render(
    <RecordList>
      <RecordRow
        primary="Synthetic document"
        detail={
          <RecordDetail summary="2 citations">Synthetic quote</RecordDetail>
        }
      />
      <RecordRow
        primary="Synthetic lone document"
        detail={
          <RecordDetail summary="1 citation" defaultOpen>
            Synthetic lone quote
          </RecordDetail>
        }
      />
    </RecordList>,
  );
  expect(screen.queryByText("Synthetic quote")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "2 citations" }));
  await expect.poll(() => screen.getByText("Synthetic quote")).toBeVisible();
  expect(screen.getByText("Synthetic lone quote")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "1 citation" }));
  await expect
    .poll(() => screen.queryByText("Synthetic lone quote"))
    .toBeNull();
});

it("derives columns from rows' facts in first-seen order", () => {
  expect(
    recordColumnsOf([
      { facts: [{ label: "Amount", value: "2 each" }] },
      {
        facts: [
          { label: "Location", value: "Synthetic shelf" },
          { label: "Amount", value: "3 each" },
        ],
      },
      {},
    ]),
  ).toEqual([
    { id: "Amount", label: "Amount" },
    { id: "Location", label: "Location" },
  ]);
});
