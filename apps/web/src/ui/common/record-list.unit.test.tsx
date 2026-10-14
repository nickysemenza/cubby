import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { RecordDetail, RecordList, RecordRow } from "./record-list";

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
  expect(screen.getByText("Synthetic quote")).not.toBeVisible();
  fireEvent.click(screen.getByText("2 citations"));
  await expect.poll(() => screen.getByText("Synthetic quote")).toBeVisible();
  expect(screen.getByText("Synthetic lone quote")).toBeVisible();
  fireEvent.click(screen.getByText("1 citation"));
  await expect
    .poll(() => screen.getByText("Synthetic lone quote"))
    .not.toBeVisible();
});
