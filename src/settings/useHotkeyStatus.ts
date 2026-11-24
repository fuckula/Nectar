import { useCallback, useEffect, useRef, useState } from "react";
import { bridgeInvoke } from "../utils/tauriBridge";
import type { HotkeyStatus } from "./types";

/**
 * Checks whether a configured non-empty shortcut failed backend global registration.
 */
export function isHotkeyConflicted(
  configured: string,
  ok: boolean | undefined,
  reportedShortcut: string | undefined
): boolean {
  const trimmed = configured.trim();
  if (!trimmed || ok !== false) return false;
  if (!reportedShortcut || !reportedShortcut.trim()) return true;
  return reportedShortcut.trim().toLowerCase() === trimmed.toLowerCase();
}

/**
 * Queries backend hotkey registration status and re-polls shortly after shortcut
 * or toggle changes so background `hotkeys::reload()` finishes first.
 */
export function useHotkeyStatus(watchKey: string): [HotkeyStatus | null, () => void] {
  const [status, setStatus] = useState<HotkeyStatus | null>(null);
  const mountedRef = useRef(true);
  const timerRef = useRef<number | null>(null);

  const queryNow = useCallback(() => {
    bridgeInvoke<HotkeyStatus | null>("get_hotkey_status")
      .then((res) => {
        if (mountedRef.current && res && typeof res === "object") {
          setStatus(res);
        }
      })
      .catch(() => {});
  }, []);

  const refresh = useCallback(() => {
    queryNow();
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      queryNow();
    }, 180);
  }, [queryNow]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [watchKey, refresh]);

  return [status, refresh];
}
