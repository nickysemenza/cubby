/** Stable callback ref for controls that must receive focus when mounted. */
export function focusOnMount(element: HTMLElement | null) {
  element?.focus();
}
