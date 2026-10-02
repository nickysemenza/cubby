/** Pack independently laid-out components without stretching smaller grid cells. */
export function packGraphSvgs(svgs: readonly string[]): string {
  const gap = 24;
  const components = svgs
    .map((svg, index) => {
      const opening = svg.match(/<svg\b[^>]*>/)?.[0];
      const viewBox = opening?.match(/viewBox="([^"]+)"/)?.[1];
      const [, , width, height] = (viewBox ?? "").split(/\s+/).map(Number);
      if (!width || !height || !Number.isFinite(width + height))
        throw new Error("Graph component has no measurable bounds");
      const content = svg
        .slice(
          svg.indexOf(opening!) + opening!.length,
          svg.lastIndexOf("</svg>"),
        )
        .replace(/\bid="([^"]+)"/g, `id="component-${index}-$1"`);
      return { width, height, viewBox, content, index };
    })
    .sort((a, b) => b.height - a.height || a.index - b.index);
  const targetWidth = Math.max(
    ...components.map((component) => component.width),
    Math.sqrt(
      components.reduce(
        (sum, component) =>
          sum + (component.width + gap) * (component.height + gap),
        0,
      ) * 1.6,
    ),
  );
  const shelves: { y: number; height: number; width: number }[] = [];
  let height = 0;
  let width = 0;
  const placed = components.map((component) => {
    let shelf = shelves.find(
      (candidate) => candidate.width + gap + component.width <= targetWidth,
    );
    if (!shelf) {
      shelf = { y: height, height: component.height, width: 0 };
      shelves.push(shelf);
      height += component.height + gap;
    }
    const x = shelf.width === 0 ? 0 : shelf.width + gap;
    shelf.width = x + component.width;
    width = Math.max(width, shelf.width);
    return `<svg x="${x}" y="${shelf.y}" width="${component.width}" height="${component.height}" viewBox="${component.viewBox}">${component.content}</svg>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${Math.max(0, height - gap)}" viewBox="0 0 ${width} ${Math.max(0, height - gap)}">${placed.join("")}</svg>`;
}
