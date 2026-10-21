class BrowserTestResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}

  observe(_target: Element, _options?: ResizeObserverOptions) {}

  unobserve(_target: Element) {}

  disconnect() {}
}

class BrowserTestMediaQueryList implements MediaQueryList {
  readonly matches = false;
  readonly media: string;
  onchange:
    | ((this: MediaQueryList, event: MediaQueryListEvent) => void)
    | null = null;

  constructor(media: string) {
    this.media = media;
  }

  addListener(
    _listener: (this: MediaQueryList, event: MediaQueryListEvent) => void,
  ) {}

  removeListener(
    _listener: (this: MediaQueryList, event: MediaQueryListEvent) => void,
  ) {}

  addEventListener(
    _type: string,
    _listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | AddEventListenerOptions,
  ) {}

  removeEventListener(
    _type: string,
    _listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | EventListenerOptions,
  ) {}

  dispatchEvent(_event: Event): boolean {
    return false;
  }
}

const BROWSER_TEST_VIEWPORT = { width: 1280, height: 800 } as const;
function installBrowserLayoutMetrics() {
  // jsdom has no layout engine. Virtualizers read client dimensions while
  // other controls read offsets; both must describe the same viewport.
  const metrics = {
    offsetWidth: BROWSER_TEST_VIEWPORT.width,
    offsetHeight: BROWSER_TEST_VIEWPORT.height,
    clientWidth: BROWSER_TEST_VIEWPORT.width,
    clientHeight: BROWSER_TEST_VIEWPORT.height,
  };
  const originals = Object.entries(metrics).map(([name, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      name,
    );
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get: () => value,
    });
    return { name, descriptor };
  });
  return () => {
    for (const { name, descriptor } of originals) {
      if (descriptor)
        Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  };
}

function installBrowserScrollIntoView() {
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  // jsdom omits this browser method, but section navigation deliberately uses
  // it before focusing the target. A no-op keeps the browser interaction
  // contract testable without inventing a scroll-position model.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });

  return () => {
    if (originalScrollIntoView)
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        originalScrollIntoView,
      );
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  };
}

function installBrowserMatchMedia() {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = (media) => new BrowserTestMediaQueryList(media);

  return () => {
    window.matchMedia = originalMatchMedia;
  };
}

/** jsdom alone owns emulated geometry; native preview providers never install it. */
export function installUiBrowserApis() {
  const needsResizeObserver = globalThis.ResizeObserver === undefined;
  if (needsResizeObserver)
    globalThis.ResizeObserver = BrowserTestResizeObserver;
  const restoreLayoutMetrics = installBrowserLayoutMetrics();
  const restoreScrollIntoView = installBrowserScrollIntoView();
  const restoreMatchMedia = installBrowserMatchMedia();
  return () => {
    restoreLayoutMetrics();
    restoreScrollIntoView();
    restoreMatchMedia();
    if (needsResizeObserver)
      Reflect.deleteProperty(globalThis, "ResizeObserver");
  };
}
