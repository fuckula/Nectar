import { bridgeInvoke } from "./tauriBridge";

const PRESERVED_RUNTIME_KEYS = new Set(["nectar-first-run", "nectar-tour-seen"]);

export function clearSettingsPreservingOnboarding(): void {
  const preserved: Array<[string, string]> = [];
  for (const key of PRESERVED_RUNTIME_KEYS) {
    const val = localStorage.getItem(key);
    if (val !== null) preserved.push([key, val]);
  }
  localStorage.clear();
  for (const [key, val] of preserved) {
    localStorage.setItem(key, val);
  }
}
const SETTINGS_CACHE_TTL_MS = 500;

let inFlightSettingsLoad: Promise<Record<string, unknown>> | null = null;
let cachedSettings: { data: Record<string, unknown>; timestamp: number } | null = null;

export function isThemeSettingKey(key: string): boolean {
  return (
    key.startsWith("nectar-theme-") ||
    key.startsWith("nectar-glass-") ||
    key.startsWith("nectar-icon-tint-") ||
    key === "nectar-icon-tile-shape" ||
    key === "nectar-wallpaper-accent" ||
    key === "nectar-edge-intensity" ||
    key === "nectar-radius-scale" ||
    key === "nectar-ui-density" ||
    key === "nectar-motion-speed" ||
    key === "nectar-motion-preset" ||
    key === "nectar-menu-style" ||
    key === "nectar-menu-hover-style" ||
    key === "nectar-dock-indicator" ||
    key === "nectar-font-family" ||
    key === "nectar-perf-profile" ||
    key === "nectar-ram-saver" ||
    key === "nectar-selection-color" ||
    key === "nectar-legacy-mode" ||
    key === "nectar-scale"
  );
}

export function invalidateSettingsCache(): void {
  cachedSettings = null;
}

export function notifyLocalSettingChanges(keys: string[], sourceId?: symbol): void {
  if (keys.length === 0 || typeof window === "undefined") return;
  invalidateSettingsCache();
  window.dispatchEvent(
    new CustomEvent("nectar-local-setting", {
      detail: { keys, key: keys[0], sourceId },
    })
  );
  if (keys.some(isThemeSettingKey)) {
    window.dispatchEvent(
      new CustomEvent("theme-setting-changed", {
        detail: { keys },
      })
    );
  }
}

/**
 * Deduplicates concurrent `load_settings` IPC calls per window using a shared
 * in-flight promise (and brief micro-cache), with `force` to bypass cache.
 */
export function loadSettingsFromBackend(
  force = false
): Promise<Record<string, unknown>> {
  if (force) {
    cachedSettings = null;
    inFlightSettingsLoad = null;
  } else {
    if (inFlightSettingsLoad) {
      return inFlightSettingsLoad;
    }
    if (
      cachedSettings &&
      Date.now() - cachedSettings.timestamp < SETTINGS_CACHE_TTL_MS
    ) {
      return Promise.resolve(cachedSettings.data);
    }
  }

  const promise = bridgeInvoke<Record<string, unknown>>("load_settings")
    .then((settings) => {
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        return {};
      }
      cachedSettings = { data: settings, timestamp: Date.now() };
      return settings;
    })
    .catch(() => ({} as Record<string, unknown>))
    .finally(() => {
      if (inFlightSettingsLoad === promise) {
        inFlightSettingsLoad = null;
      }
    });

  if (!force) {
    inFlightSettingsLoad = promise;
  }
  return promise;
}

/**
 * Mirrors backend settings into `localStorage`.
 * Non-null `nectar-*` primitives/objects are written; `null`/`undefined` entries are removed.
 * When `pruneMissing` is true, existing `localStorage` `nectar-*` keys absent from `map`
 * (except client-only runtime markers like `nectar-first-run`) are deleted.
 */
export function syncSettingsMapToLocalStorage(
  map: Record<string, unknown>,
  pruneMissing = false
): void {
  if (typeof localStorage === "undefined" || !map || typeof map !== "object") return;

  const changedKeys: string[] = [];

  try {
    for (const [key, value] of Object.entries(map)) {
      if (!key.startsWith("nectar-")) continue;
      if (value === null || value === undefined) {
        if (localStorage.getItem(key) !== null) {
          localStorage.removeItem(key);
          changedKeys.push(key);
        }
      } else {
        let serialized: string;
        if (
          typeof value === "string" ||
          typeof value === "boolean" ||
          typeof value === "number"
        ) {
          serialized = String(value);
        } else {
          try {
            serialized = JSON.stringify(value);
          } catch {
            continue;
          }
        }
        if (localStorage.getItem(key) !== serialized) {
          localStorage.setItem(key, serialized);
          changedKeys.push(key);
        }
      }
    }

    if (pruneMissing) {
      const existingKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) existingKeys.push(key);
      }
      for (const key of existingKeys) {
        if (
          key.startsWith("nectar-") &&
          !PRESERVED_RUNTIME_KEYS.has(key) &&
          !Object.prototype.hasOwnProperty.call(map, key)
        ) {
          localStorage.removeItem(key);
          changedKeys.push(key);
        }
      }
    }
  } catch {
    // Ignore storage access errors in restricted webviews
  }

  if (changedKeys.length > 0) {
    notifyLocalSettingChanges(changedKeys);
  }
}

/**
 * Loads settings from the Tauri backend (or browser preview bridge), mirrors them to
 * `localStorage`, and returns the resulting settings map (never throws).
 */
export async function hydrateSettingsFromBackend(
  pruneMissing = false,
  forceOrOptions: boolean | { force?: boolean } = false
): Promise<Record<string, unknown>> {
  const force =
    typeof forceOrOptions === "boolean"
      ? forceOrOptions
      : !!forceOrOptions?.force;
  try {
    const settings = await loadSettingsFromBackend(force);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return {};
    }
    syncSettingsMapToLocalStorage(settings, pruneMissing);
    return settings;
  } catch {
    return {};
  }
}
