export interface VisibleIntervalOptions {
  active?: boolean;
}

export interface VisibleIntervalController {
  stop: () => void;
  setActive: (active: boolean) => void;
  isActive: () => boolean;
}

interface ManagedIntervalEntry {
  handler: () => void;
  ms: number;
  active: boolean;
  stopped: boolean;
  nativeTimerId: ReturnType<typeof setInterval> | undefined;
  stop: () => void;
}

const managedEntries = new Map<number, ManagedIntervalEntry>();
const allEntries = new Set<ManagedIntervalEntry>();
let nextHandleId = 900_000_000;
let visibilityListenerAttached = false;
let clearIntervalPatched = false;

const hasWindow = typeof window !== "undefined";
const hasDocument = typeof document !== "undefined";

const nativeSetInterval: typeof globalThis.setInterval = hasWindow
  ? window.setInterval.bind(window)
  : globalThis.setInterval.bind(globalThis);
const nativeClearInterval: typeof globalThis.clearInterval = hasWindow
  ? window.clearInterval.bind(window)
  : globalThis.clearInterval.bind(globalThis);

function isPageHidden(): boolean {
  return hasDocument ? document.hidden : false;
}

function disarmEntry(entry: ManagedIntervalEntry): void {
  if (entry.nativeTimerId !== undefined) {
    nativeClearInterval(entry.nativeTimerId);
    entry.nativeTimerId = undefined;
  }
}

function syncEntryTimer(entry: ManagedIntervalEntry): void {
  if (entry.stopped || !entry.active || isPageHidden()) {
    disarmEntry(entry);
    return;
  }
  if (entry.nativeTimerId === undefined) {
    entry.nativeTimerId = nativeSetInterval(() => {
      if (entry.stopped || !entry.active || isPageHidden()) {
        disarmEntry(entry);
        return;
      }
      entry.handler();
    }, entry.ms);
  }
}

function onVisibilityChange(): void {
  for (const entry of allEntries) {
    syncEntryTimer(entry);
  }
}

function ensureVisibilityListener(): void {
  if (!hasDocument || visibilityListenerAttached) return;
  document.addEventListener("visibilitychange", onVisibilityChange);
  visibilityListenerAttached = true;
}

function maybeDetachVisibilityListener(): void {
  if (!hasDocument || !visibilityListenerAttached || allEntries.size > 0) return;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  visibilityListenerAttached = false;
}

function ensureClearIntervalInterception(): void {
  if (!hasWindow || clearIntervalPatched) return;
  clearIntervalPatched = true;
  // Ensures legacy callers passing the handle from `setVisibleInterval` to `clearInterval`
  // also cancel the visibility listener and avoid re-arming after unmount.
  window.clearInterval = ((id?: number) => {
    if (typeof id === "number" && managedEntries.has(id)) {
      clearVisibleInterval(id);
      return;
    }
    nativeClearInterval(id);
  }) as typeof window.clearInterval;
}

/**
 * Creates a visibility- and activity-aware interval that clears its underlying
 * timer whenever `document.hidden` or `!active` and re-arms on restore.
 */
export function createVisibleInterval(
  handler: () => void,
  ms: number,
  options?: VisibleIntervalOptions | boolean
): VisibleIntervalController {
  const initialActive =
    typeof options === "boolean" ? options : (options?.active ?? true);

  const entry: ManagedIntervalEntry = {
    handler,
    ms,
    active: initialActive,
    stopped: false,
    nativeTimerId: undefined,
    stop: () => {},
  };

  const stop = () => {
    if (entry.stopped) return;
    entry.stopped = true;
    disarmEntry(entry);
    allEntries.delete(entry);
    maybeDetachVisibilityListener();
  };
  entry.stop = stop;

  allEntries.add(entry);
  ensureVisibilityListener();
  syncEntryTimer(entry);

  return {
    stop,
    setActive(nextActive: boolean) {
      if (entry.stopped || entry.active === nextActive) return;
      entry.active = nextActive;
      syncEntryTimer(entry);
    },
    isActive() {
      return !entry.stopped && entry.active;
    },
  };
}

/**
 * Clears an interval created by `setVisibleInterval` (both handle-based and
 * standard `clearInterval` cleanup remain supported).
 */
export function clearVisibleInterval(handle: number | undefined): void {
  if (handle === undefined) return;
  const entry = managedEntries.get(handle);
  if (entry) {
    managedEntries.delete(handle);
    entry.stop();
    return;
  }
  nativeClearInterval(handle);
}

/**
 * Backwards-compatible `setInterval` replacement that disarms completely while
 * `document.hidden` or `!active` and re-arms on `visibilitychange`.
 */
export function setVisibleInterval(
  handler: () => void,
  ms: number,
  options?: VisibleIntervalOptions | boolean
): number {
  ensureClearIntervalInterception();
  const initialActive =
    typeof options === "boolean" ? options : (options?.active ?? true);
  const handle = ++nextHandleId;

  const entry: ManagedIntervalEntry = {
    handler,
    ms,
    active: initialActive,
    stopped: false,
    nativeTimerId: undefined,
    stop: () => {},
  };

  entry.stop = () => {
    if (entry.stopped) return;
    entry.stopped = true;
    disarmEntry(entry);
    managedEntries.delete(handle);
    allEntries.delete(entry);
    maybeDetachVisibilityListener();
  };

  managedEntries.set(handle, entry);
  allEntries.add(entry);
  ensureVisibilityListener();
  syncEntryTimer(entry);

  return handle;
}
