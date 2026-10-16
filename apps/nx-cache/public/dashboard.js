const byId = (id) => document.getElementById(id);
const count = (value) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value);
const bytes = (value) => {
  const unit =
    value === 0 ? 0 : Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return (
    count(value / 1024 ** unit) + " " + ["B", "KiB", "MiB", "GiB", "TiB"][unit]
  );
};
const hour = (value) => value.replace("T", " ").slice(0, 16);
function message(id, value) {
  byId(id).hidden = !value;
  byId(id).textContent = value || "";
}
function row(parent, values) {
  const tr = document.createElement("tr");
  values.forEach((value, index) => {
    const cell = document.createElement(index === 0 ? "th" : "td");
    if (index === 0) cell.scope = "row";
    if (value instanceof Node) cell.append(value);
    else cell.textContent = value;
    tr.append(cell);
  });
  parent.append(tr);
}
const labels = {
  hit: "GET · Hit",
  miss: "GET · Miss",
  stored: "PUT · Stored",
  exists: "PUT · Already stored",
  error: "Storage error",
};
function activity(section) {
  message("activity-error", section.error);
  if (section.error) {
    if (!byId("activity").dataset.ready)
      for (const id of ["results", "hours"]) {
        byId(id).replaceChildren();
        row(byId(id), ["Statistics unavailable", "—", "—", "—"]);
      }
    return;
  }
  byId("activity").dataset.ready = "true";
  const data = section.data;
  byId("activity-empty").hidden = data.length > 0;
  const total = (outcome, key = "requests") =>
    data
      .filter((r) => r.outcome === outcome)
      .reduce((sum, r) => sum + r[key], 0);
  const hits = total("hit"),
    misses = total("miss");
  byId("hit-rate").textContent =
    hits + misses ? count((100 * hits) / (hits + misses)) + "%" : "—";
  byId("read-counts").textContent = count(hits) + " / " + count(misses);
  byId("served").textContent = bytes(total("hit", "bytes"));
  byId("errors").textContent = count(total("error"));
  const results = byId("results");
  results.replaceChildren();
  for (const [outcome, label] of Object.entries(labels)) {
    const items = data.filter((r) => r.outcome === outcome),
      requests = total(outcome);
    const latency = items.reduce((sum, r) => sum + r.requests * r.latency, 0);
    row(results, [
      label,
      count(requests),
      ["hit", "stored"].includes(outcome)
        ? bytes(total(outcome, "bytes"))
        : "—",
      requests ? count(latency / requests) + " ms" : "—",
    ]);
  }
  const hours = new Map();
  for (const item of data.filter((r) => ["hit", "miss"].includes(r.outcome))) {
    const value = hours.get(item.hour) || { hit: 0, miss: 0 };
    value[item.outcome] += item.requests;
    hours.set(item.hour, value);
  }
  const max = Math.max(1, ...[...hours.values()].map((v) => v.hit + v.miss));
  const tbody = byId("hours");
  tbody.replaceChildren();
  for (const [time, value] of [...hours].sort((a, b) =>
    b[0].localeCompare(a[0]),
  )) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 300 13");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    let x = 0;
    for (const [amount, fill] of [
      [value.hit, "#356f4d"],
      [value.miss, "#c8cfc2"],
    ]) {
      const rect = document.createElementNS(svg.namespaceURI, "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", 2);
      rect.setAttribute("width", (300 * amount) / max);
      rect.setAttribute("height", 9);
      rect.setAttribute("fill", fill);
      svg.append(rect);
      x += (300 * amount) / max;
    }
    row(tbody, [hour(time), svg, count(value.hit), count(value.miss)]);
  }
  if (!hours.size) row(tbody, ["No reads recorded", "—", "—", "—"]);
}
function storage(section) {
  message("storage-error", section.error);
  if (section.error) return;
  byId("storage").dataset.ready = "true";
  const latest = section.data[0];
  byId("storage-empty").hidden = !!latest;
  byId("objects").textContent = latest ? count(latest.objects) : "—";
  byId("stored-bytes").textContent = latest ? bytes(latest.bytes) : "—";
  byId("observed").textContent = latest ? hour(latest.hour) : "—";
  const tbody = byId("storage-hours");
  tbody.replaceChildren();
  for (const item of section.data)
    row(tbody, [hour(item.hour), count(item.objects), bytes(item.bytes)]);
}
async function refresh() {
  const button = byId("refresh");
  button.disabled = true;
  button.textContent = "Refreshing…";
  for (const id of ["activity", "storage"])
    byId(id).setAttribute("aria-busy", "true");
  message("page-error", "");
  try {
    const response = await fetch("/stats.json");
    const snapshot = await response.json();
    if (!response.ok || snapshot.error)
      throw new Error(snapshot.error || "HTTP " + response.status);
    activity(snapshot.activity);
    storage(snapshot.storage);
    byId("updated").textContent =
      (snapshot.activity.error || snapshot.storage.error
        ? "Partial snapshot "
        : "Snapshot ") +
      new Date(snapshot.generatedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
  } catch (error) {
    message(
      "page-error",
      "Statistics could not refresh. " +
        error.message +
        ". Use Refresh to retry; any previous values remain visible.",
    );
    if (!byId("activity").dataset.ready) {
      for (const id of ["results", "hours"]) {
        byId(id).replaceChildren();
        row(byId(id), ["Statistics unavailable", "—", "—", "—"]);
      }
    }
    byId("updated").textContent = "Statistics unavailable";
  } finally {
    button.disabled = false;
    button.textContent = "Refresh";
    for (const id of ["activity", "storage"])
      byId(id).setAttribute("aria-busy", "false");
  }
}
byId("refresh").addEventListener("click", refresh);
refresh();
