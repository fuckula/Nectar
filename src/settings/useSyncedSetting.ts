import { useCallback, useEffect, useRef, useState } from "react";
import {
  isLocalSettingWriteActive,
  markLocalSettingWrites,
  useSettingsSync,
} from "../hooks/useSettingsSync";
import {
  invalidateSettingsCache,
  loadSettingsFromBackend,
  notifyLocalSettingChanges,
} from "../utils/settingsHydration";
import { bridgeInvoke } from "../utils/tauriBridge";

export interface UseSyncedSettingOptions {
  debounceMs?: number;
}

interface PendingDebouncedWrite {
  key: string;
  serialized: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
}

/**
 * Hydrates a setting from `localStorage` and backend `load_settings()`,
 * keeps it synchronized across windows via `useSettingsSync` (including `null` resets),
 * prevents echo reversion via `markLocalSettingWrites` / `shouldIgnoreKey`,
 * and optionally debounces backend writes while flushing pending edits on unmount.
 */
export function useSyncedSetting<T>(
  key: string,
  parse: (raw: unknown) => T,
  serialize: (val: T) => string,
  options?: UseSyncedSettingOptions
): [T, (next: T) => Promise<void>] {
  const parseRef = useRef(parse);
  parseRef.current = parse;
  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;
  const debounceMsRef = useRef(Math.max(0, options?.debounceMs ?? 0));
  debounceMsRef.current = Math.max(0, options?.debounceMs ?? 0);

  const sourceIdRef = useRef<symbol | null>(null);
  if (sourceIdRef.current === null) {
    sourceIdRef.current = Symbol("useSyncedSetting");
  }

  const pendingWriteRef = useRef<PendingDebouncedWrite | null>(null);

  const [value, setValue] = useState<T>(() => {
    try {
      return parseRef.current(localStorage.getItem(key));
    } catch {
      return parseRef.current(null);
    }
  });

  useEffect(() => {
    let cancelled = false;
    try {
      setValue(parseRef.current(localStorage.getItem(key)));
    } catch {
      setValue(parseRef.current(null));
    }

    const onLocalChange = (e: Event) => {
      const detail = (e as CustomEvent<{ keys?: string[]; sourceId?: symbol }>).detail;
      if (!detail || detail.sourceId === sourceIdRef.current) return;
      if (!detail.keys?.includes(key)) return;
      if (pendingWriteRef.current?.key === key) return;
      try {
        setValue(parseRef.current(localStorage.getItem(key)));
      } catch {
        // Ignore restricted storage errors
      }
    };

    if (typeof window !== "undefined") {
      window.addEventListener("nectar-local-setting", onLocalChange);
    }

    loadSettingsFromBackend()
      .then((s) => {
        if (
          cancelled ||
          pendingWriteRef.current?.key === key ||
          isLocalSettingWriteActive(key)
        ) {
          return;
        }
        if (!s || typeof s !== "object" || Array.isArray(s)) return;
        if (!Object.prototype.hasOwnProperty.call(s, key)) return;
        const raw = s[key];
        const parsed = parseRef.current(raw);
        setValue(parsed);
        try {
          if (raw === null || raw === undefined) {
            localStorage.removeItem(key);
          } else {
            localStorage.setItem(key, serializeRef.current(parsed));
          }
        } catch {
          // Ignore restricted storage errors
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("nectar-local-setting", onLocalChange);
      }
      const pending = pendingWriteRef.current;
      if (pending && pending.key === key) {
        clearTimeout(pending.timer);
        pendingWriteRef.current = null;
        markLocalSettingWrites([pending.key]);
        invalidateSettingsCache();
        bridgeInvoke("save_setting", {
          key: pending.key,
          value: pending.serialized,
        })
          .catch(() => {})
          .finally(() => pending.resolve());
      }
    };
  }, [key]);

  useSettingsSync(
    {
      [key]: (v) => {
        if (pendingWriteRef.current?.key === key) return;
        setValue(parseRef.current(v));
      },
    },
    [key],
    {
      shouldIgnoreKey: isLocalSettingWriteActive,
      onReset: () => {
        if (pendingWriteRef.current && pendingWriteRef.current.key === key) {
          clearTimeout(pendingWriteRef.current.timer);
          const prevResolve = pendingWriteRef.current.resolve;
          pendingWriteRef.current = null;
          prevResolve();
        }
        try {
          localStorage.removeItem(key);
        } catch {
          // Ignore storage errors
        }
        setValue(parseRef.current(null));
      },
    }
  );

  const update = useCallback(
    async (next: T): Promise<void> => {
      const serialized = serializeRef.current(next);
      const debounceMs = debounceMsRef.current;
      setValue(next);
      try {
        localStorage.setItem(key, serialized);
      } catch {
        // Ignore restricted storage errors
      }

      markLocalSettingWrites([key], Math.max(700, debounceMs + 700));
      notifyLocalSettingChanges([key], sourceIdRef.current ?? undefined);

      if (pendingWriteRef.current && pendingWriteRef.current.key === key) {
        clearTimeout(pendingWriteRef.current.timer);
        const prevResolve = pendingWriteRef.current.resolve;
        pendingWriteRef.current = null;
        prevResolve();
      }

      if (debounceMs <= 0) {
        await bridgeInvoke("save_setting", { key, value: serialized }).catch(() => {});
        return;
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (pendingWriteRef.current?.timer === timer) {
            pendingWriteRef.current = null;
          }
          markLocalSettingWrites([key]);
          invalidateSettingsCache();
          bridgeInvoke("save_setting", { key, value: serialized })
            .catch(() => {})
            .finally(() => resolve());
        }, debounceMs);

        pendingWriteRef.current = { key, serialized, timer, resolve };
      });
    },
    [key]
  );

  return [value, update];
}
