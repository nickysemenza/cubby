import { plantTaskConnection } from "./connected-records-contract";
import { test } from "./e2e-test";

test("Plant detail shows the task path through its planting", async ({
  page,
}) => {
  await plantTaskConnection(page);
});
