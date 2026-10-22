// Disposable observations, not a retained automated regression suite.
import { createPrototype, A, B } from "./model.mjs";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const observations = [];
let p = await createPrototype();
observations.push({
  case: "bounded page",
  loaded: p.snapshot().loadedCount,
  server: p.snapshot().serverCount,
  reads: p.snapshot().requests,
});
p.rename(A, "  Inspect canonical sample filter  ");
observations.push({
  case: "optimistic rename",
  list: p.snapshot().list[0].name,
  detail: p.snapshot().detail[0].name,
  relationship: p.snapshot().related[0].name,
});
p.settle(1, true);
await tick();
observations.push({
  case: "canonical receipt",
  row: p.snapshot().list[0],
  reads: p.snapshot().requests.length,
});
await p.dispose();
p = await createPrototype();
p.remove();
p.rename(B, "Successful sibling edit");
p.settle(2, true);
await tick();
p.settle(1, false);
await tick();
observations.push({
  case: "failed delete after sibling success",
  rows: p.snapshot().list,
  outcomes: p.snapshot().outcomes,
});
await p.dispose();
p = await createPrototype();
p.rename(A, "First edit fails");
p.rename(A, "Second edit succeeds");
p.settle(2, true);
await tick();
observations.push({
  case: "same-row overlap before failed predecessor",
  rows: p.snapshot().list,
  server: p.snapshot().server[0],
});
p.settle(1, false);
await tick();
observations.push({
  case: "same-row overlap after failed predecessor",
  row: p.snapshot().list[0],
  server: p.snapshot().server[0],
});
await p.dispose();
p = await createPrototype();
p.move();
observations.push({
  case: "move loaded relationship",
  related: p.snapshot().related,
});
p.settle(1, true);
await tick();
await p.dispose();
p = await createPrototype();
p.remove();
p.settle(1, true);
await tick();
observations.push({
  case: "accepted delete before refill",
  list: p.snapshot().list,
  reads: p.snapshot().requests.length,
});
await p.refresh();
observations.push({
  case: "accepted delete after bounded refill",
  list: p.snapshot().list,
  reads: p.snapshot().requests,
});
await p.dispose();
p = await createPrototype();
p.background();
observations.push({
  case: "external write before refresh",
  browser: p.snapshot().list[1].name,
  server: p.snapshot().server[1].name,
});
await p.refresh();
observations.push({
  case: "external write after refresh",
  browser: p.snapshot().list[1].name,
  reads: p.snapshot().requests.length,
});
const payload = JSON.parse(JSON.stringify(p.dehydrate()));
const second = await createPrototype(() => {}, { hydratedState: payload });
observations.push({
  case: "Query cache hydration",
  rows: second.snapshot().list,
  reads: second.snapshot().requests.length,
});
p.rename(A, "Private pending value");
observations.push({
  case: "request-scoped instances",
  first: p.snapshot().list[0].name,
  second: second.snapshot().list[0].name,
});
p.settle(1, false);
await tick();
await second.dispose();
await p.dispose();
console.log(JSON.stringify(observations, null, 2));
