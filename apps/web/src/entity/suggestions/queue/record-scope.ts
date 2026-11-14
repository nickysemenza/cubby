/** Record surfaces share the queue's canonical record filter. */
export function recordSuggestionScope(id: string) {
  return { recordIds: [id] };
}
