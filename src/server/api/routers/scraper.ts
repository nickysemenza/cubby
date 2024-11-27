import {
  parse_scraped_recipe,
  WCompactRecipe,
} from "recipebridge/pkg/recipebridge";
import { type Span, trace } from "@opentelemetry/api";
import { CompactRecipe } from "~/codec/codec";

export const scrapeRecipe = async (url: string) => {
  let json = false;
  if (url.includes("chefsteps.com")) {
    // transform https://www.chefsteps.com/activities/rich-and-moist-cornbread
    // into https://www.chefsteps.com/api/v0/activities/rich-and-moist-cornbread
    const activityId = url.split("/").pop();
    url = `https://www.chefsteps.com/api/v0/activities/${activityId}`;
  }
  console.log("scrapeRecipe: fetching", url);
  const options = {
    method: "GET",
  };
  const response = await fetch(url, options);
  const html = await response.text();
  const tracer = trace.getTracer("wasm");

  return tracer.startActiveSpan(`parse_scraped_recipe`, async (span: Span) => {
    span.setAttributes({ url });
    const res = parse_scraped_recipe(html, url);
    return res;
  });
};

export const scrapeToCompact = async (url: string): Promise<CompactRecipe> => {
  const scraped = await scrapeRecipe(url);
  const compact: CompactRecipe = WCompactToCompact(scraped);
  return compact;
};
const WCompactToCompact = (wCompact: WCompactRecipe): CompactRecipe => {
  return {
    name: wCompact.name ?? "",
    sections: [
      {
        ingredients: wCompact.ingredients,
        instructions: wCompact.instructions,
      },
    ],
  };
};
