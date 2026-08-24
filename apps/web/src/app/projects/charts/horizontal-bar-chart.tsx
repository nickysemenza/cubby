// Absorbed into the shared chart kit — re-exported here so the several
// call sites across projects/ and expenses/ that still import this path
// (trade-cost-aggregate, cost-vs-estimate, trade-activity, trade-bars,
// planned-actual-bar) don't need touching.
export { HorizontalBarChart } from "~/app/_components/charts/kit";
