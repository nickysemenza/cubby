import { parse_scraped_recipe } from "recipebridge/pkg/recipebridge";

import { type Span, trace } from "@opentelemetry/api";
export const scrapeRecipe = async (url: string) => {
  const response = await fetch(url);
  const html = await response.text();
  const tracer = trace.getTracer("wasm");
  return tracer.startActiveSpan(`parse_scraped_recipe`, async (span: Span) => {
    span.setAttributes({ url });
    const res = parse_scraped_recipe(html, url);
    return res;
  });
};
