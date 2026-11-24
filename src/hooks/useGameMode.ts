import { useEffect, useState } from "react";
import { bridgeInvoke, bridgeListen } from "../utils/tauriBridge";

export interface GameModeState {
  gameModeActive: boolean;
  gameModeEnabled: boolean;
  shouldPausePolls: boolean;
  shouldMuteAgents: boolean;
  shouldSuppressToasts: boolean;
}

const GAME_MODE_KEYS = new Set([
  "nectar-game-mode",
  "nectar-game-mode-pause-polls",
  "nectar-game-mode-mute-agents",
  "nectar-game-mode-suppress-toasts",
]);

function readSettingBool(key: string, defaultVal: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultVal;
    return raw !== "false";
  } catch {
    return defaultVal;
  }
}

function parseGameModeActive(payload: unknown): boolean | null {
  if (typeof payload === "boolean") return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const k of ["game_mode_active", "gameModeActive", "game_mode", "active"]) {
      if (typeof obj[k] === "boolean") return obj[k] as boolean;
    }
  }
  return null;
}

function persistGameModeKey(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(key);
    } else if (typeof value === "object") {
      localStorage.setItem(key, JSON.stringify(value));
    } else {
      localStorage.setItem(key, String(value));
    }
  } catch {
    // Ignore storage restrictions
  }
}

let cachedGameModeActive = false;

export function isGameModeMuteAgentsActive(): boolean {
  return (
    cachedGameModeActive &&
    readSettingBool("nectar-game-mode", true) &&
    readSettingBool("nectar-game-mode-mute-agents", true)
  );
}

export function isGameModePausePollsActive(): boolean {
  return (
    cachedGameModeActive &&
    readSettingBool("nectar-game-mode", true) &&
    readSettingBool("nectar-game-mode-pause-polls", true)
  );
}

export function isGameModeSuppressToastsActive(): boolean {
  return (
    cachedGameModeActive &&
    readSettingBool("nectar-game-mode", true) &&
    localStorage.getItem("nectar-game-mode-suppress-toasts") === "true"
  );
}

export function useGameMode(): GameModeState {
  const [gameModeActive, setGameModeActive] = useState<boolean>(cachedGameModeActive);
  const [gameModeEnabled, setGameModeEnabled] = useState<boolean>(() =>
    readSettingBool("nectar-game-mode", true)
  );
  const [pausePolls, setPausePolls] = useState<boolean>(() =>
    readSettingBool("nectar-game-mode-pause-polls", true)
  );
  const [muteAgents, setMuteAgents] = useState<boolean>(() =>
    readSettingBool("nectar-game-mode-mute-agents", true)
  );
  const [suppressToasts, setSuppressToasts] = useState<boolean>(() => {
    try {
      return localStorage.getItem("nectar-game-mode-suppress-toasts") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let cancelled = false;

    const refreshSettings = () => {
      if (cancelled) return;
      setGameModeEnabled(readSettingBool("nectar-game-mode", true));
      setPausePolls(readSettingBool("nectar-game-mode-pause-polls", true));
      setMuteAgents(readSettingBool("nectar-game-mode-mute-agents", true));
      try {
        setSuppressToasts(localStorage.getItem("nectar-game-mode-suppress-toasts") === "true");
      } catch {
        setSuppressToasts(false);
      }
    };

    bridgeInvoke<unknown>("get_runtime_state")
      .then((state) => {
        if (cancelled) return;
        const next = parseGameModeActive(state);
        if (next !== null) {
          cachedGameModeActive = next;
          setGameModeActive(next);
        }
      })
      .catch(() => {});

    let stopGM: (() => void) | undefined;
    let stopSC: (() => void) | undefined;
    let stopSBC: (() => void) | undefined;
    let stopSEC: (() => void) | undefined;
    let stopReset: (() => void) | undefined;

    bridgeListen<unknown>("game-mode-changed", (payload) => {
      const next = parseGameModeActive(payload);
      if (next !== null) {
        cachedGameModeActive = next;
        if (!cancelled) setGameModeActive(next);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else stopGM = fn;
    });

    bridgeListen<{ key?: string; value?: unknown }>("settings-changed", (p) => {
      if (p?.key && GAME_MODE_KEYS.has(p.key)) {
        persistGameModeKey(p.key, p.value);
        refreshSettings();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else stopSC = fn;
    });

    bridgeListen<{ entries?: Record<string, unknown> }>("settings-batch-changed", (p) => {
      const entries = p?.entries;
      if (!entries) return;
      let hit = false;
      for (const [k, v] of Object.entries(entries)) {
        if (GAME_MODE_KEYS.has(k)) {
          persistGameModeKey(k, v);
          hit = true;
        }
      }
      if (hit) refreshSettings();
    }).then((fn) => {
      if (cancelled) fn();
      else stopSBC = fn;
    });

    bridgeListen<{ key?: string; value?: unknown }>("settings-external-changed", (p) => {
      if (p?.key && GAME_MODE_KEYS.has(p.key)) {
        persistGameModeKey(p.key, p.value);
        refreshSettings();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else stopSEC = fn;
    });

    bridgeListen<unknown>("settings-reset", () => {
      for (const k of GAME_MODE_KEYS) {
        persistGameModeKey(k, null);
      }
      refreshSettings();
    }).then((fn) => {
      if (cancelled) fn();
      else stopReset = fn;
    });

    const onLocal = (e: Event) => {
      const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (!keys || keys.some((k) => GAME_MODE_KEYS.has(k))) refreshSettings();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || GAME_MODE_KEYS.has(e.key)) refreshSettings();
    };
    window.addEventListener("nectar-local-setting", onLocal);
    window.addEventListener("storage", onStorage);

    return () => {
      cancelled = true;
      stopGM?.();
      stopSC?.();
      stopSBC?.();
      stopSEC?.();
      stopReset?.();
      window.removeEventListener("nectar-local-setting", onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const effectiveActive = gameModeActive && gameModeEnabled;

  return {
    gameModeActive: effectiveActive,
    gameModeEnabled,
    shouldPausePolls: effectiveActive && pausePolls,
    shouldMuteAgents: effectiveActive && muteAgents,
    shouldSuppressToasts: effectiveActive && suppressToasts,
  };
}
