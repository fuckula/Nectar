import { useEffect, useRef } from "react";
import { bridgeListen } from "../utils/tauriBridge";

const localWriteUntilByKey = new Map<string, number>();

export function markLocalSettingWrites(keys: string[], ttlMs = 700): void {
  const until = Date.now() + ttlMs;
  for (const key of keys) {
    localWriteUntilByKey.set(key, until);
  }
}

export function isLocalSettingWriteActive(key: string): boolean {
  const until = localWriteUntilByKey.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  localWriteUntilByKey.delete(key);
  return false;
}

export function clearLocalSettingWrites(): void {
  localWriteUntilByKey.clear();
}

function serializeForStorage(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return String(value);
}

function convertSettingValue(value: any): any {
  if (value === null || value === undefined) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value))) {
    return Number(value);
  }
  return value;
}

/**
 * Centralized settings sync hook. Listens to `settings-changed`, `settings-batch-changed`, and
 * `settings-external-changed` using `bridgeListen` (safe in both Tauri runtime and standalone browser preview)
 * with StrictMode-safe async listener disposal.
 */
export function useSettingsSync(
  handlers: Record<string, (value: any) => void>,
  deps?: React.DependencyList,
  options?: { shouldIgnoreKey?: (key: string) => boolean; onReset?: () => void }
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const shouldIgnoreRef = useRef(options?.shouldIgnoreKey);
  shouldIgnoreRef.current = options?.shouldIgnoreKey;
  const onResetRef = useRef(options?.onReset);
  onResetRef.current = options?.onReset;

  useEffect(() => {
    let cancelled = false;
    let stopSC: (() => void) | undefined;
    let stopSBC: (() => void) | undefined;
    let stopSEC: (() => void) | undefined;
    let stopReset: (() => void) | undefined;

    const applyEntry = (key: string, value: any, checkIgnore: boolean) => {
      if (checkIgnore && shouldIgnoreRef.current?.(key)) {
        return;
      }
      try {
        const serialized = serializeForStorage(value);
        if (serialized !== null) {
          localStorage.setItem(key, serialized);
        } else {
          localStorage.removeItem(key);
        }
      } catch {
        /* storage unavailable */
      }
      const handler = handlersRef.current[key];
      if (handler) {
        handler(convertSettingValue(value));
      }
    };

    const handlePayload = (
      payload: { key: string; value: any } | null | undefined,
      checkIgnore: boolean
    ) => {
      if (!payload) return;
      applyEntry(payload.key, payload.value, checkIgnore);
    };

    bridgeListen<{ key: string; value: any }>("settings-changed", (p) =>
      handlePayload(p, true)
    ).then((fn) => {
      if (cancelled) fn();
      else stopSC = fn;
    });

    bridgeListen<{ entries: Record<string, any> }>("settings-batch-changed", (p) => {
      const entries = p?.entries;
      if (!entries || typeof entries !== "object") return;
      for (const [key, value] of Object.entries(entries)) {
        applyEntry(key, value, true);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else stopSBC = fn;
    });

    bridgeListen<{ key: string; value: any }>("settings-external-changed", (p) =>
      handlePayload(p, false)
    ).then((fn) => {
      if (cancelled) fn();
      else stopSEC = fn;
    });

    bridgeListen<unknown>("settings-reset", () => {
      if (onResetRef.current) {
        onResetRef.current();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else stopReset = fn;
    });

    return () => {
      cancelled = true;
      stopSC?.();
      stopSBC?.();
      stopSEC?.();
      stopReset?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps ?? []);
}
