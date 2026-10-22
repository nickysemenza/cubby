import { createPrototype, A, B } from "./model.mjs";
let model;
let current = "rename";
let step = 0;
const el = (id) => document.getElementById(id);
const text = (tag, value) => {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
};
const scenarios = {
  rename: {
    title: "Rename everywhere",
    description:
      "One optimistic name appears in the loaded list, detail, and Project relationships. Accepting the write trims its spaces and applies the canonical receipt without another read.",
    steps: [
      [
        "Rename Task",
        () => model.rename(A, "  Inspect the canonical sample filter  "),
      ],
      ["Accept the write", () => model.settle(1, true)],
    ],
  },
  rollback: {
    title: "Failed delete + saved edit",
    description:
      "A failed deletion should restore its Task without erasing a different Task’s successful edit.",
    steps: [
      ["Delete first Task", () => model.remove()],
      ["Edit second Task", () => model.rename(B, "Successful sibling edit")],
      ["Accept second edit", () => model.settle(2, true)],
      ["Reject first deletion", () => model.settle(1, false)],
    ],
  },
  overlap: {
    title: "Two edits to one Task",
    description:
      "Accept the newer edit while the older edit is pending. Watch the older optimistic name temporarily return. Rejecting the older edit converges to the newer saved name.",
    steps: [
      ["Start older edit", () => model.rename(A, "Older pending name")],
      ["Start newer edit", () => model.rename(A, "Newer saved name")],
      ["Accept newer edit first", () => model.settle(2, true)],
      ["Reject older edit", () => model.settle(1, false)],
    ],
  },
  move: {
    title: "Move between Projects",
    description:
      "The loaded relationship join updates immediately. These are loaded rows only; the panel never claims to count every Task in a Project.",
    steps: [
      ["Move first Task", () => model.move()],
      ["Accept move", () => model.settle(1, true)],
    ],
  },
  refill: {
    title: "Delete and refill the page",
    description:
      "Deleting a loaded row does not tell the collection which unseen row replaces it. An explicit bounded refetch fills the window.",
    steps: [
      ["Delete first Task", () => model.remove()],
      ["Accept deletion", () => model.settle(1, true)],
      ["Refetch bounded page", () => model.refresh()],
    ],
  },
  background: {
    title: "Background changes",
    description:
      "A simulated background job changes server state. Local reactivity does not deliver that external change; refresh is still needed.",
    steps: [
      ["Change server Task", () => model.background()],
      ["Refresh loaded page", () => model.refresh()],
    ],
  },
};
function renderRows(id, rows, columns) {
  const container = el(id);
  container.replaceChildren();
  if (!rows.length) {
    container.append(text("p", "No loaded rows."));
    return;
  }
  const table = document.createElement("table");
  const head = document.createElement("tr");
  columns.forEach(([label]) => head.append(text("th", label)));
  table.append(head);
  for (const row of rows) {
    const tr = document.createElement("tr");
    columns.forEach(([, field]) => tr.append(text("td", row[field])));
    table.append(tr);
  }
  container.append(table);
}
function render() {
  if (!model) return;
  const state = model.snapshot();
  el("metrics").textContent =
    `${state.loadedCount} Tasks loaded / ${state.serverCount} on server · ${state.requests.length} simulated Task reads · ${state.requests.reduce((sum, r) => sum + r.bytes, 0)} JSON response bytes`;
  renderRows("list", state.list, [
    ["Task", "name"],
    ["Project", "projectId"],
    ["Saved revision", "revision"],
  ]);
  renderRows("detail", state.detail, [
    ["Selected Task", "name"],
    ["Project", "projectId"],
    ["Saved revision", "revision"],
  ]);
  renderRows("relationships", state.related, [
    ["Loaded Task", "name"],
    ["Project", "project"],
  ]);
  renderRows("server", state.server, [
    ["Task on server", "name"],
    ["Project", "projectId"],
    ["Revision", "revision"],
  ]);
  el("pending").replaceChildren();
  for (const write of state.pending) {
    const row = document.createElement("div");
    row.className = "pending";
    row.append(
      text(
        "span",
        `Write ${write.id}: ${write.kind} ${JSON.stringify(write.mutations)}`,
      ),
    );
    for (const [label, accept] of [
      ["Accept", true],
      ["Reject", false],
    ]) {
      const button = text("button", label);
      button.addEventListener("click", () =>
        run(() => model.settle(write.id, accept)),
      );
      row.append(button);
    }
    el("pending").append(row);
  }
  if (!state.pending.length)
    el("pending").append(text("p", "No writes waiting."));
  el("outcomes").textContent =
    state.outcomes.join("\n") || "No persistence outcomes yet.";
  el("requests").textContent = JSON.stringify(state.requests, null, 2);
  const scenario = scenarios[current];
  el("description").textContent = scenario.description;
  el("steps").replaceChildren();
  scenario.steps.forEach(([label, action], index) => {
    const button = text("button", `${index + 1}. ${label}`);
    button.disabled = index !== step;
    button.addEventListener("click", async () => {
      await run(action);
      step++;
      render();
    });
    el("steps").append(button);
  });
  document
    .querySelectorAll("[data-scenario]")
    .forEach((button) =>
      button.setAttribute(
        "aria-selected",
        String(button.dataset.scenario === current),
      ),
    );
  document.querySelectorAll("[data-action]").forEach((button) => {
    const action = button.dataset.action;
    button.disabled =
      ["rename", "move", "delete"].includes(action) &&
      !state.list.some((row) => row.id === A);
  });
}
async function run(action) {
  try {
    await action();
    await new Promise((resolve) => setTimeout(resolve, 0));
    el("error").textContent = "";
  } catch (error) {
    el("error").textContent = error.message;
  }
  render();
}
async function reset() {
  el("error").textContent = "";
  step = 0;
  if (model) await model.dispose();
  model = undefined;
  model = await createPrototype(() => queueMicrotask(render));
  render();
}
for (const [key, scenario] of Object.entries(scenarios)) {
  const button = text("button", scenario.title);
  button.dataset.scenario = key;
  button.setAttribute("role", "tab");
  button.addEventListener("click", () => {
    current = key;
    void reset();
  });
  el("tabs").append(button);
}
const actions = {
  rename: () => model.rename(A, "Free-play Task name"),
  move: () => model.move(),
  delete: () => model.remove(),
  sibling: () => model.rename(B, "Free-play sibling name"),
  background: () => model.background(),
  refresh: () => model.refresh(),
  reset,
};
document
  .querySelectorAll("[data-action]")
  .forEach((button) =>
    button.addEventListener("click", () => run(actions[button.dataset.action])),
  );
await reset();
// Read-only observations for disposable browser verification.
window.prototypeSnapshot = () => model.snapshot();
