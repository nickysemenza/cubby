const REQUEST_ITEM_LIMIT = 2048;
const REQUEST_BYTES_LIMIT = 300_000;
const INPUT_BYTES_LIMIT = 8_192;

export function uploadChunks<T extends { text: string }>(
  items: readonly T[],
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
    bytes = 0;
  };
  for (const item of items) {
    const size = new TextEncoder().encode(item.text).length;
    if (
      current.length &&
      (current.length >= REQUEST_ITEM_LIMIT ||
        bytes + size > REQUEST_BYTES_LIMIT)
    )
      flush();
    if (size > INPUT_BYTES_LIMIT) {
      flush();
      chunks.push([item]);
      continue;
    }
    current.push(item);
    bytes += size;
  }
  flush();
  return chunks;
}
