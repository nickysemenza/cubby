/**
 * A stand-in a popup trigger's popup anchors to while the trigger is drawn
 * elsewhere: the table spill-over's copied ⓘ, so an explanation opens under
 * the control that was pressed rather than under its clipped original.
 */
const proxies = new WeakMap<Element, Element>();

export function setAnchorProxy(trigger: Element, proxy: Element | null) {
  if (proxy) proxies.set(trigger, proxy);
  else proxies.delete(trigger);
}

/** The element a popup opened from `trigger` positions against. */
export function anchorOf(trigger: Element): Element {
  const proxy = proxies.get(trigger);
  return proxy?.isConnected ? proxy : trigger;
}
