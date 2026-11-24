import { useEffect, useState, type ReactNode } from "react";
import { bridgeInvoke, bridgeListen } from "../utils/tauriBridge";
import { isAppTintExcluded } from "../utils/iconTint";

const MAX_ICON_CACHE = 400;
const ICON_CACHE = new Map<string, string | null>();
const CACHE_LISTENERS = new Set<() => void>();
const EXCLUDED_LISTENERS = new Set<() => void>();
let cacheVersion = 0;
let excludedVersion = 0;
let globalListenersAttached = false;

function setBoundedIconCache(key: string, value: string | null) {
  if (!ICON_CACHE.has(key) && ICON_CACHE.size >= MAX_ICON_CACHE) {
    const oldest = ICON_CACHE.keys().next().value;
    if (oldest !== undefined) ICON_CACHE.delete(oldest);
  }
  ICON_CACHE.set(key, value);
}

function bumpExcludedListeners(raw?: unknown) {
  if (raw !== undefined) {
    try {
      if (raw === null) localStorage.removeItem("nectar-icon-tint-excluded");
      else if (typeof raw === "string") localStorage.setItem("nectar-icon-tint-excluded", raw);
      else localStorage.setItem("nectar-icon-tint-excluded", JSON.stringify(raw));
    } catch {
      // Ignore storage errors
    }
  }
  excludedVersion += 1;
  for (const fn of EXCLUDED_LISTENERS) fn();
}

function ensureGlobalListeners() {
  if (globalListenersAttached || typeof window === "undefined") return;
  globalListenersAttached = true;
  bridgeListen("icon-cache-cleared", () => {
    ICON_CACHE.clear();
    cacheVersion += 1;
    for (const fn of CACHE_LISTENERS) fn();
  }).catch(() => {});

  bridgeListen<{ key?: string; value?: unknown }>("settings-changed", (p) => {
    if (p?.key === "nectar-icon-tint-excluded") bumpExcludedListeners(p.value);
  }).catch(() => {});

  bridgeListen<{ entries?: Record<string, unknown> }>("settings-batch-changed", (p) => {
    const entries = p?.entries;
    if (entries && Object.prototype.hasOwnProperty.call(entries, "nectar-icon-tint-excluded")) {
      bumpExcludedListeners(entries["nectar-icon-tint-excluded"]);
    }
  }).catch(() => {});

  bridgeListen<{ key?: string; value?: unknown }>("settings-external-changed", (p) => {
    if (p?.key === "nectar-icon-tint-excluded") bumpExcludedListeners(p.value);
  }).catch(() => {});

  bridgeListen("settings-reset", () => {
    bumpExcludedListeners(null);
  }).catch(() => {});

  window.addEventListener("nectar-local-setting", (e: Event) => {
    const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
    if (!keys || keys.includes("nectar-icon-tint-excluded")) {
      bumpExcludedListeners();
    }
  });

  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === null || e.key === "nectar-icon-tint-excluded") {
      bumpExcludedListeners();
    }
  });
}

interface ShellAppIconProps {
  path?: string | null;
  name?: string | null;
  initialIcon?: string | null;
  hwnd?: number | null;
  skipLookup?: boolean;
  tintable?: boolean;
  tintExcluded?: boolean;
  className?: string;
  fallback: ReactNode;
}

export function ShellAppIcon({
  path,
  name,
  initialIcon,
  hwnd = null,
  skipLookup = false,
  tintable = true,
  tintExcluded,
  className,
  fallback,
}: ShellAppIconProps) {
  const [icon, setIcon] = useState<string | null>(initialIcon ?? null);
  const [version, setVersion] = useState(cacheVersion);
  const [, setExcludedVer] = useState(excludedVersion);

  useEffect(() => {
    ensureGlobalListeners();
    const onCacheBump = () => setVersion(cacheVersion);
    const onExclBump = () => setExcludedVer(excludedVersion);
    CACHE_LISTENERS.add(onCacheBump);
    EXCLUDED_LISTENERS.add(onExclBump);
    return () => {
      CACHE_LISTENERS.delete(onCacheBump);
      EXCLUDED_LISTENERS.delete(onExclBump);
    };
  }, []);

  useEffect(() => {
    ensureGlobalListeners();
    if (initialIcon) {
      setIcon(initialIcon);
      return;
    }
    if (skipLookup || !path) {
      setIcon(null);
      return;
    }
    const cacheKey = `${path.toLowerCase()}|${(name ?? "").toLowerCase()}|${hwnd ?? ""}`;
    if (ICON_CACHE.has(cacheKey)) {
      setIcon(ICON_CACHE.get(cacheKey) ?? null);
      return;
    }
    // Clear stale previous icon immediately before starting uncached lookup
    setIcon(null);
    let cancelled = false;
    bridgeInvoke<string | null>("get_app_icon", {
      path,
      name: name ?? null,
      hwnd,
    })
      .then((res) => {
        setBoundedIconCache(cacheKey, res || null);
        if (!cancelled) setIcon(res || null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, name, initialIcon, hwnd, skipLookup, version]);

  if (icon) {
    const tintKey = path || name;
    const isExcluded = tintExcluded ?? (tintable ? isAppTintExcluded(tintKey) : true);
    const resolvedClassName = [
      className,
      tintable && !isExcluded ? "nectar-tintable-icon" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <img
        src={icon}
        alt=""
        className={resolvedClassName || undefined}
        data-tint-excluded={isExcluded ? "true" : undefined}
        draggable={false}
      />
    );
  }
  return <>{fallback}</>;
}
