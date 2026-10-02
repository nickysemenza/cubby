import { transformedImageUrl } from "~/lib/image-url";

export interface GraphImage {
  id: string;
  url: string;
}

/** Images occupy reserved label space; they never participate in worker layout. */
export function appendGraphImages(
  svg: SVGSVGElement,
  images: readonly GraphImage[],
) {
  const byId = new Map(images.map((image) => [image.id, image.url]));
  for (const node of svg.querySelectorAll<SVGGElement>(".node")) {
    const url = byId.get(node.querySelector("title")?.textContent ?? "");
    const boundary = node.querySelector<SVGGraphicsElement>(
      "polygon, path, ellipse",
    );
    if (!url || !boundary) continue;
    const bounds = boundary.getBBox();
    const image = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "image",
    );
    image.setAttribute("href", transformedImageUrl(url, 56));
    image.setAttribute("x", String(bounds.x + 16));
    image.setAttribute("y", String(bounds.y + (bounds.height - 56) / 2));
    image.setAttribute("width", "56");
    image.setAttribute("height", "56");
    image.setAttribute("preserveAspectRatio", "xMidYMid meet");
    image.setAttribute("aria-hidden", "true");
    image.setAttribute("pointer-events", "none");
    image.addEventListener("error", () => image.remove(), { once: true });
    node.append(image);
  }
}
