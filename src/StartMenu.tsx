import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import {
  Search,
  ChevronRight,
  ChevronLeft,
  Power,
  Lock,
  LogOut,
  Moon,
  RotateCcw,
  Folder,
  FileText,
  Download,
  Image as ImageIcon,
  Settings as SettingsIcon,
  AppWindow,
  ExternalLink,
  Shield,
  FolderOpen,
  Info,
  Copy,
  Pin,
  PinOff,
  Trash2,
  Terminal,
  Wrench,
  Globe,
  Calculator,
  MoreHorizontal,
} from "lucide-react";
import { initTheme } from "./theme";
import { useT } from "./i18n";
import { useSettingsSync } from "./hooks/useSettingsSync";
import type { AppInfo } from "./types/shell";
import type { CalcCard, LauncherItem, LauncherSearchResponse } from "./launcher/types";
import type { RecommendedItem, StartPinItem, StartUserProfile } from "./start/types";
import { PinnedGrid } from "./start/PinnedGrid";
import { AllAppsList } from "./start/AllAppsList";
import { ShellAppIcon } from "./components/ShellAppIcon";
import { applyPreviewThemeParams, bridgeInvoke, bridgeListen, isTauriRuntime } from "./utils/tauriBridge";
import "./surfaces.css";

type ContextTarget = {
  name: string;
  path: string;
  args?: string | null;
  icon?: string | null;
  pinnedToStart: boolean;
  pinnedToDock: boolean;
  isFile?: boolean;
  kind?: string;
};

const POWER_OPTIONS = [
  { id: "lock", labelKey: "start.power.lock", icon: Lock, destructive: false },
  { id: "sign_out", labelKey: "start.power.signOut", icon: LogOut, destructive: true },
  { id: "sleep", labelKey: "start.power.sleep", icon: Moon, destructive: false },
  { id: "hibernate", labelKey: "start.power.hibernate", icon: Moon, destructive: true },
  { id: "restart", labelKey: "start.power.restart", icon: RotateCcw, destructive: true },
  { id: "shutdown", labelKey: "start.power.shutdown", icon: Power, destructive: true },
] as const;

function clampScale(raw: unknown): number {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? "1"));
  return Number.isFinite(n) ? Math.min(1.75, Math.max(0.75, n)) : 1;
}

function clampCols(raw: unknown): number {
  const n = parseInt(String(raw ?? "6"), 10);
  return Number.isFinite(n) ? Math.min(7, Math.max(5, n)) : 6;
}

type StartTileSize = "compact" | "normal" | "large";
function normTileSize(raw: unknown): StartTileSize {
  const s = String(raw ?? "normal").trim().toLowerCase();
  return s === "compact" || s === "large" ? s : "normal";
}

function clampRecCount(raw: unknown): number {
  const n = parseInt(String(raw ?? "6"), 10);
  if (n === 2 || n === 4 || n === 6) return n;
  if (!Number.isFinite(n)) return 6;
  return n <= 2 ? 2 : n <= 4 ? 4 : 6;
}

function supportsAdminAndLocation(path?: string | null): boolean {
  if (!path) return false;
  const lower = path.trim().toLowerCase();
  return (
    !lower.startsWith("ms-") &&
    !lower.startsWith("http") &&
    !lower.startsWith("shell:") &&
    lower !== "nectar-settings"
  );
}

export default function StartMenu() {
  const t = useT();
  const [surfaceOpen, setSurfaceOpen] = useState(() => !isTauriRuntime());
  const [query, setQuery] = useState("");
  const [pins, setPins] = useState<StartPinItem[]>([]);
  const [dockPins, setDockPins] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [allApps, setAllApps] = useState<AppInfo[]>([]);
  const [recommended, setRecommended] = useState<RecommendedItem[]>([]);
  const [launcherHits, setLauncherHits] = useState<LauncherItem[]>([]);
  const [launcherCalc, setLauncherCalc] = useState<CalcCard | null>(null);
  const [armedConfirmId, setArmedConfirmId] = useState<string | null>(null);
  const [profile, setProfile] = useState<StartUserProfile>({
    display_name: "User",
    avatar: null,
    folders: [],
  });

  const [allAppsOpen, setAllAppsOpen] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [powerOpen, setPowerOpen] = useState(false);
  const [powerConfirmId, setPowerConfirmId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: ContextTarget } | null>(
    null
  );
  const [ctxMoreOpen, setCtxMoreOpen] = useState(false);
  const ctxMoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelCtxMoreClose = useCallback(() => {
    if (ctxMoreTimerRef.current !== null) {
      window.clearTimeout(ctxMoreTimerRef.current);
      ctxMoreTimerRef.current = null;
    }
  }, []);
  const openCtxMore = useCallback(() => {
    cancelCtxMoreClose();
    setCtxMoreOpen(true);
  }, [cancelCtxMoreClose]);
  const scheduleCtxMoreClose = useCallback(() => {
    cancelCtxMoreClose();
    ctxMoreTimerRef.current = window.setTimeout(() => {
      ctxMoreTimerRef.current = null;
      setCtxMoreOpen(false);
    }, 170);
  }, [cancelCtxMoreClose]);
  useEffect(() => cancelCtxMoreClose, [cancelCtxMoreClose]);
  const [toast, setToast] = useState<string | null>(null);

  const [scale, setScale] = useState<number>(() =>
    clampScale(localStorage.getItem("nectar-scale"))
  );
  const [columns, setColumns] = useState<number>(() =>
    clampCols(localStorage.getItem("nectar-start-columns"))
  );
  const [showRecommended, setShowRecommended] = useState<boolean>(
    () => localStorage.getItem("nectar-start-show-recommended") !== "false"
  );
  const [launcherHotkey, setLauncherHotkey] = useState<string>(
    () => localStorage.getItem("nectar-launcher-hotkey") ?? "Alt+Space"
  );
  const [launcherEnabled, setLauncherEnabled] = useState<boolean>(
    () => localStorage.getItem("nectar-launcher-enabled") !== "false"
  );
  const [legacyMode, setLegacyMode] = useState<boolean>(
    () => localStorage.getItem("nectar-legacy-mode") === "true"
  );
  const [tileSize, setTileSize] = useState<StartTileSize>(() =>
    normTileSize(localStorage.getItem("nectar-start-tile-size"))
  );
  const [recCount, setRecCount] = useState<number>(() =>
    clampRecCount(localStorage.getItem("nectar-start-rec-count"))
  );
  const [, setTintExclVer] = useState(0);
  const [powerPos, setPowerPos] = useState<{ right: number; bottom: number }>({
    right: 18,
    bottom: 56,
  });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const powerBtnRef = useRef<HTMLButtonElement>(null);
  const powerMenuRef = useRef<HTMLDivElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const lastCtxTriggerRef = useRef<HTMLElement | null>(null);
  const revealRafRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    applyPreviewThemeParams();
    return initTheme({ backdrop: false });
  }, []);

  useEffect(() => {
    let cancelled = false;
    bridgeInvoke<Record<string, unknown>>("load_settings")
      .then((s) => {
        if (cancelled || !s) return;
        if (s["nectar-start-columns"] != null) {
          setColumns(clampCols(s["nectar-start-columns"]));
        }
        if (s["nectar-start-show-recommended"] != null) {
          setShowRecommended(String(s["nectar-start-show-recommended"]) !== "false");
        }
        if (s["nectar-scale"] != null) {
          setScale(clampScale(s["nectar-scale"]));
        }
        if (s["nectar-launcher-hotkey"] != null) {
          setLauncherHotkey(String(s["nectar-launcher-hotkey"]).trim());
        }
        if (s["nectar-launcher-enabled"] !== undefined && s["nectar-launcher-enabled"] !== null) {
          setLauncherEnabled(String(s["nectar-launcher-enabled"]) !== "false");
        }
        if (s["nectar-legacy-mode"] !== undefined && s["nectar-legacy-mode"] !== null) {
          setLegacyMode(String(s["nectar-legacy-mode"]) === "true");
        }
        if (s["nectar-start-tile-size"] != null) {
          setTileSize(normTileSize(s["nectar-start-tile-size"]));
        }
        if (s["nectar-start-rec-count"] != null) {
          setRecCount(clampRecCount(s["nectar-start-rec-count"]));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useSettingsSync(
    {
      "nectar-start-columns": (v) => setColumns(clampCols(v)),
      "nectar-start-show-recommended": (v) => setShowRecommended(v !== false && v !== "false"),
      "nectar-scale": (v) => setScale(clampScale(v)),
      "nectar-launcher-hotkey": (v) =>
        setLauncherHotkey(v === null || v === undefined ? "Alt+Space" : String(v).trim()),
      "nectar-launcher-enabled": (v) => setLauncherEnabled(v !== false && v !== "false"),
      "nectar-legacy-mode": (v) => setLegacyMode(v === true || v === "true"),
      "nectar-start-tile-size": (v) => setTileSize(normTileSize(v)),
      "nectar-start-rec-count": (v) => setRecCount(clampRecCount(v)),
      "nectar-icon-tint-excluded": () => setTintExclVer((v) => v + 1),
    },
    undefined,
    {
      onReset: () => {
        setColumns(6);
        setShowRecommended(true);
        setScale(1);
        setLauncherHotkey("Alt+Space");
        setLauncherEnabled(true);
        setLegacyMode(false);
        setTileSize("normal");
        setRecCount(6);
        setTintExclVer((v) => v + 1);
      },
    }
  );

  useEffect(() => {
    bridgeInvoke("resize_shell_window", { width: 620, height: 560 }).catch(() => {});
  }, [scale]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(id);
  }, [toast]);

  const loadData = useCallback(() => {
    Promise.allSettled([
      bridgeInvoke<StartPinItem[]>("get_start_pins").then((res) => {
        if (mountedRef.current && Array.isArray(res)) setPins(res);
      }),
      bridgeInvoke<AppInfo[]>("load_pinned_apps").then((res) => {
        if (mountedRef.current && Array.isArray(res)) setDockPins(res);
      }),
      bridgeInvoke<AppInfo[]>("get_start_all_apps").then((res) => {
        if (mountedRef.current && Array.isArray(res)) setAllApps(res);
      }),
      bridgeInvoke<RecommendedItem[]>("get_start_recommended").then((res) => {
        if (mountedRef.current && Array.isArray(res)) setRecommended(res);
      }),
      bridgeInvoke<StartUserProfile>("get_start_user_profile").then((res) => {
        if (mountedRef.current && res) setProfile(res);
      }),
    ]).finally(() => {
      if (mountedRef.current) setLoading(false);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadData();
    let unShown: (() => void) | undefined;
    let unHidden: (() => void) | undefined;
    let unPins: (() => void) | undefined;
    let unDockPins: (() => void) | undefined;

    const pShown = bridgeListen<{ scale?: number }>("shell-window-shown", (payload) => {
      if (cancelled) return;
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      setSurfaceOpen(false);
      setCtxMenu(null);
      setPowerOpen(false);
      setPowerConfirmId(null);
      setJumpOpen(false);
      setQuery("");
      if (typeof payload?.scale === "number") {
        setScale(clampScale(payload.scale));
      }
      revealRafRef.current = requestAnimationFrame(() => {
        revealRafRef.current = null;
        if (cancelled) return;
        setSurfaceOpen(true);
        searchInputRef.current?.focus({ preventScroll: true });
      });
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        if (!cancelled) loadData();
      }, 200);
    }).then((fn) => {
      if (cancelled) fn();
      else unShown = fn;
    }).catch(() => {});

    const pHidden = bridgeListen("shell-window-hidden", () => {
      if (cancelled) return;
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      setSurfaceOpen(false);
      setCtxMenu(null);
      setPowerOpen(false);
      setPowerConfirmId(null);
      setJumpOpen(false);
      setToast(null);
    }).then((fn) => {
      if (cancelled) fn();
      else unHidden = fn;
    }).catch(() => {});

    const pPins = bridgeListen("start-pins-updated", () => {
      if (cancelled) return;
      bridgeInvoke<StartPinItem[]>("get_start_pins")
        .then((res) => { if (!cancelled && Array.isArray(res)) setPins(res); })
        .catch(() => {});
    }).then((fn) => {
      if (cancelled) fn();
      else unPins = fn;
    }).catch(() => {});

    const pDockPins = bridgeListen("pinned-apps-updated", () => {
      if (cancelled) return;
      bridgeInvoke<AppInfo[]>("load_pinned_apps")
        .then((res) => { if (!cancelled && Array.isArray(res)) setDockPins(res); })
        .catch(() => {});
    }).then((fn) => {
      if (cancelled) fn();
      else unDockPins = fn;
    }).catch(() => {});

    Promise.all([pShown, pHidden, pPins, pDockPins]).then(() => {
      if (!cancelled) {
        bridgeInvoke("shell_surface_ready").catch(() => {});
      }
    });

    return () => {
      cancelled = true;
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      unShown?.();
      unHidden?.();
      unPins?.();
      unDockPins?.();
    };
  }, [loadData]);

  useEffect(() => {
    if (!ctxMenu) {
      cancelCtxMoreClose();
      setCtxMoreOpen(false);
    }
  }, [ctxMenu, cancelCtxMoreClose]);

  const ctxSubmenuLeft = useMemo(() => {
    if (!ctxMenu) return false;
    const maxW = typeof window !== "undefined" ? window.innerWidth / scale : 620;
    return ctxMenu.x + 196 + 215 > maxW;
  }, [ctxMenu, scale]);
  // Measure and clamp context menu within current viewport so long localized labels never clip
  useLayoutEffect(() => {
    if (!ctxMenu || !ctxMenuRef.current) return;
    const el = ctxMenuRef.current;
    const rect = el.getBoundingClientRect();
    const maxW = window.innerWidth / scale;
    const maxH = window.innerHeight / scale;
    const w = rect.width / scale;
    const h = rect.height / scale;
    const nx = Math.max(8, Math.min(ctxMenu.x, maxW - w - 8));
    const ny = Math.max(8, Math.min(ctxMenu.y, maxH - h - 8));
    if (Math.abs(nx - ctxMenu.x) > 1 || Math.abs(ny - ctxMenu.y) > 1) {
      setCtxMenu((prev) => (prev ? { ...prev, x: nx, y: ny } : null));
    }
    el.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [ctxMenu, scale]);

  useLayoutEffect(() => {
    if (!powerOpen || !powerBtnRef.current) return;
    const rect = powerBtnRef.current.getBoundingClientRect();
    const menuW = powerMenuRef.current?.getBoundingClientRect().width ?? 196 * scale;
    const vw = window.innerWidth / scale;
    const rightEdge = vw - rect.right / scale;
    const clampedRight = Math.max(8, Math.min(rightEdge, vw - menuW / scale - 8));
    const bottom = Math.max(8, (window.innerHeight - rect.top) / scale + 8);
    setPowerPos({ right: clampedRight, bottom });
  }, [powerOpen, scale, powerConfirmId]);

  useEffect(() => {
    if (!powerOpen) return;
    const rafId = requestAnimationFrame(() => {
      powerMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    return () => cancelAnimationFrame(rafId);
  }, [powerOpen]);

  const canUseLauncher = launcherEnabled && !legacyMode;

  const hideMenu = useCallback((restoreFocus = false) => {
    bridgeInvoke("hide_start_menu", { restoreFocus }).catch(() => {});
  }, []);

  const handOffToLauncher = useCallback(
    (initialQuery: string) => {
      if (!canUseLauncher) return;
      bridgeInvoke("open_launcher", { initialQuery }).catch(() => {});
      hideMenu();
    },
    [canUseLauncher, hideMenu]
  );

  const launchTarget = useCallback(
    (path: string, args?: string | null) => {
      if (path === "nectar-settings") {
        bridgeInvoke("open_settings_window").catch(() => {});
      } else {
        bridgeInvoke("open_app", { appName: path, args: args ?? null }).catch(() => {});
      }
      hideMenu();
    },
    [hideMenu]
  );

  const pinnedSet = useMemo(
    () => new Set(pins.map((p) => p.path.toLowerCase())),
    [pins]
  );

  const dockPinnedSet = useMemo(
    () => new Set(dockPins.map((p) => p.path.toLowerCase())),
    [dockPins]
  );

  useEffect(() => {
    const trimmed = query.trim();
    setArmedConfirmId(null);
    if (!trimmed) {
      setLauncherHits([]);
      setLauncherCalc(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      bridgeInvoke<LauncherSearchResponse>("search_launcher", { query: trimmed })
        .then((res) => {
          if (cancelled || !res) return;
          setLauncherCalc(res.calc_card ?? null);
          setLauncherHits(Array.isArray(res.items) ? res.items : []);
        })
        .catch(() => {});
    }, 65);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const filteredApps = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allApps
      .filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.executable ?? "").toLowerCase().includes(q)
      )
      .slice(0, 12);
  }, [allApps, query]);

  const mergedSearchItems = useMemo(() => {
    if (!query.trim()) return [];
    const items: {
      id: string;
      name: string;
      subtitle: string;
      path: string;
      args?: string | null;
      icon?: string | null;
      kind: string;
      badge: string;
      requiresConfirm?: boolean;
      launcherItem?: LauncherItem;
    }[] = [];
    const seen = new Set<string>();
    for (const hit of launcherHits) {
      if (hit.kind === "calc") continue;
      const key = hit.target.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: hit.id,
        name: hit.title,
        subtitle: hit.subtitle,
        path: hit.target,
        args: hit.args,
        icon: hit.icon,
        kind: hit.kind,
        badge: hit.badge,
        requiresConfirm: hit.requires_confirm,
        launcherItem: hit,
      });
    }
    for (const app of filteredApps) {
      const key = app.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: `app:${key}`,
        name: app.name,
        subtitle: app.executable || app.path,
        path: app.path,
        args: app.args,
        icon: app.icon,
        kind: "app",
        badge: "App",
      });
    }
    return items.slice(0, 14);
  }, [query, launcherHits, filteredApps]);

  const executeMergedItem = async (
    entry: (typeof mergedSearchItems)[number],
    asAdmin = false
  ) => {
    if (asAdmin && supportsAdminAndLocation(entry.path)) {
      try {
        await bridgeInvoke("launch_app_as_admin", {
          appPath: entry.path,
          appName: entry.name,
          args: entry.args ?? null,
          hwnd: null,
        });
        hideMenu();
      } catch (err) {
        const msg = typeof err === "string" ? err : String((err as Error)?.message ?? err);
        if (msg !== "cancelled") setToast(t("start.action.adminUnavailable"));
      }
      return;
    }
    if (entry.requiresConfirm && armedConfirmId !== entry.id) {
      setArmedConfirmId(entry.id);
      return;
    }
    setArmedConfirmId(null);
    if (entry.launcherItem) {
      try {
        await bridgeInvoke("execute_launcher_item", {
          item: entry.launcherItem,
          query: query.trim(),
          confirmed: true,
        });
        hideMenu();
      } catch (err) {
        setToast(typeof err === "string" ? err : String((err as Error)?.message ?? err));
      }
      return;
    }
    launchTarget(entry.path, entry.args);
  };

  const openContextFor = (
    e: React.MouseEvent,
    info: { name: string; path: string; args?: string | null; icon?: string | null; isFile?: boolean; kind?: string }
  ) => {
    lastCtxTriggerRef.current = (e.currentTarget as HTMLElement) ?? null;
    const x = Math.max(8, e.clientX / scale);
    const y = Math.max(8, e.clientY / scale);
    setPowerOpen(false);
    setCtxMenu({
      x,
      y,
      target: {
        name: info.name,
        path: info.path,
        args: info.args,
        icon: info.icon,
        pinnedToStart: pinnedSet.has(info.path.toLowerCase()),
        pinnedToDock: dockPinnedSet.has(info.path.toLowerCase()),
        isFile: info.isFile,
        kind: info.kind,
      },
    });
  };

  const runContextAction = async (action: string) => {
    if (!ctxMenu) return;
    const tgt = ctxMenu.target;
    setCtxMenu(null);

    if (action === "open") {
      launchTarget(tgt.path, tgt.args);
      return;
    }

    if (action === "open_properties") {
      try {
        await bridgeInvoke("open_app_properties", { appPath: tgt.path, hwnd: null });
        hideMenu();
      } catch {
        setToast(t("dockmenu.propertiesUnavailable"));
      }
      return;
    }

    if (action === "copy_path") {
      try {
        await bridgeInvoke("copy_text_to_clipboard", { text: tgt.path });
        setToast(t("start.action.copiedPath"));
      } catch (err) {
        setToast(typeof err === "string" ? err : String((err as Error)?.message ?? err));
      }
      return;
    }

    if (action === "toggle_pin_start") {
      try {
        if (tgt.pinnedToStart) {
          const next = await bridgeInvoke<StartPinItem[]>("unpin_from_start", {
            path: tgt.path,
          });
          if (Array.isArray(next)) setPins(next);
          setToast(t("start.unpinnedToast"));
        } else {
          const next = await bridgeInvoke<StartPinItem[]>("pin_to_start", {
            item: { name: tgt.name, path: tgt.path, args: tgt.args ?? null, icon: tgt.icon ?? null },
          });
          if (Array.isArray(next)) setPins(next);
          setToast(t("start.pinnedToast"));
        }
      } catch (err) {
        setToast(typeof err === "string" ? err : String((err as Error)?.message ?? err));
      }
      return;
    }

    try {
      const msg = await bridgeInvoke<string>("execute_launcher_action", {
        item: {
          id: `start:${tgt.path}`,
          kind: tgt.isFile ? "file" : "app",
          title: tgt.name,
          subtitle: tgt.path,
          badge: "App",
          icon: tgt.icon ?? null,
          target: tgt.path,
          args: tgt.args ?? null,
          hwnd: null,
          score: 0,
          match_indices: [],
          requires_confirm: false,
          actions: [],
        },
        actionId: action,
        confirmed: true,
      });

      if (
        (action === "run_as_admin" || action === "open_location") &&
        msg !== "start.action.adminUnavailable"
      ) {
        hideMenu();
      } else if (msg) {
        setToast(msg.startsWith("start.action.") ? t(msg) : msg);
      }
    } catch (err) {
      const raw = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
      setToast(raw.startsWith("start.action.") ? t(raw) : raw);
    }
  };

  const handleMenuArrowKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    if (items.length === 0) return;
    e.preventDefault();
    const cur = document.activeElement as HTMLButtonElement | null;
    const idx = cur ? items.indexOf(cur) : -1;
    let next = 0;
    if (e.key === "ArrowDown") next = (idx + 1) % items.length;
    else if (e.key === "ArrowUp") next = (idx - 1 + items.length) % items.length;
    else if (e.key === "End") next = items.length - 1;
    items[next]?.focus();
  };

  const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (ctxMenu) {
        setCtxMenu(null);
        lastCtxTriggerRef.current?.focus();
      } else if (powerOpen) {
        setPowerOpen(false);
        setPowerConfirmId(null);
        powerBtnRef.current?.focus();
      } else if (jumpOpen) {
        setJumpOpen(false);
      } else if (allAppsOpen) {
        setAllAppsOpen(false);
      } else if (query) {
        setQuery("");
        searchInputRef.current?.focus();
      } else {
        hideMenu(true);
      }
      return;
    }

    if (canUseLauncher && e.ctrlKey && e.code === "Space") {
      e.preventDefault();
      handOffToLauncher(query);
    }
  };

  const handleGlobalKeyDownRef = useRef(handleGlobalKeyDown);
  handleGlobalKeyDownRef.current = handleGlobalKeyDown;

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => handleGlobalKeyDownRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const renderFolderIcon = (id: string) => {
    switch (id) {
      case "documents":
        return <FileText size={16} strokeWidth={1.7} />;
      case "downloads":
        return <Download size={16} strokeWidth={1.7} />;
      case "pictures":
        return <ImageIcon size={16} strokeWidth={1.7} />;
      case "settings":
        return <SettingsIcon size={16} strokeWidth={1.7} />;
      default:
        return <Folder size={16} strokeWidth={1.7} />;
    }
  };

  return (
    <div
      className="start-viewport"
      style={
        {
          zoom: scale,
          width: `${100 / scale}vw`,
          height: `${100 / scale}vh`,
        } as CSSProperties
      }
      onClick={(e) => {
        setCtxMenu(null);
        setPowerOpen(false);
        setPowerConfirmId(null);
        if (e.target === e.currentTarget) {
          hideMenu(true);
        }
      }}
    >
      <div
        data-tile-size={tileSize}
        className={`nectar-shell-surface start-surface shell-anim-surface shell-anim-start ${surfaceOpen ? "is-open" : "is-hidden"}`}
      >
        {/* Top Search Pill */}
        <div className="start-search-wrap">
          <div className="start-search-pill">
            <Search size={15} strokeWidth={2} className="start-search-icon" />
            <input
              ref={searchInputRef}
              type="text"
              autoFocus
              className="start-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (canUseLauncher && e.key === "Tab" && !e.shiftKey && query.trim().length > 0) {
                  e.preventDefault();
                  handOffToLauncher(query);
                  return;
                }
                if (e.key === "ArrowDown") {
                  const first = contentRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
                  if (first) {
                    e.preventDefault();
                    first.focus();
                  }
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (mergedSearchItems[0]) {
                    executeMergedItem(mergedSearchItems[0], e.ctrlKey && e.shiftKey);
                  } else if (launcherCalc) {
                    bridgeInvoke("copy_text_to_clipboard", { text: launcherCalc.raw })
                      .then(() => setToast(t("start.action.copied")))
                      .catch(() => {});
                  } else if (canUseLauncher) {
                    handOffToLauncher(query);
                  }
                }
              }}
              placeholder={t("start.searchPlaceholder")}
              aria-label={t("start.searchPlaceholder")}
            />
            {canUseLauncher && (
              <button
                type="button"
                className="start-handoff-btn"
                onClick={() => handOffToLauncher(query)}
                title={launcherHotkey ? `${t("start.openLauncher")} (${launcherHotkey})` : t("start.openLauncher")}
              >
                <span>{t("start.searchEverywhere")}</span>
                {launcherHotkey && <kbd>{launcherHotkey}</kbd>}
              </button>
            )}
          </div>
        </div>

        {/* Main Content */}
        <div ref={contentRef} className="start-content">
          {query.trim() ? (
            <div className="start-search-results">
              <div className="start-section-bar">
                <span className="start-section-title">{t("start.matchingApps")}</span>
                {canUseLauncher && (
                  <button
                    type="button"
                    className="start-pill-btn"
                    onClick={() => handOffToLauncher(query)}
                  >
                    <span>{t("start.searchInLauncher")}</span>
                    <ChevronRight size={13} />
                  </button>
                )}
              </div>
              {launcherCalc && (
                <button
                  type="button"
                  className="start-calc-banner"
                  onClick={() => {
                    bridgeInvoke("copy_text_to_clipboard", { text: launcherCalc.raw })
                      .then(() => setToast(t("start.action.copied")))
                      .catch(() => {});
                  }}
                >
                  <Calculator size={16} strokeWidth={1.9} />
                  <span className="start-calc-expr">{launcherCalc.expression}</span>
                  <span className="start-calc-val">= {launcherCalc.formatted}</span>
                  <span className="start-calc-copy">{t("launcher.copy")}</span>
                </button>
              )}
              {mergedSearchItems.length > 0 ? (
                <div className="start-search-grid nectar-scroll">
                  {mergedSearchItems.map((entry) => {
                    const armed = armedConfirmId === entry.id;
                    const rowFallback =
                      entry.kind === "settings" ? <SettingsIcon size={17} /> :
                      entry.kind === "tool" ? <Wrench size={17} /> :
                      entry.kind === "shell" ? <Terminal size={17} /> :
                      entry.kind === "web" ? <Globe size={17} /> :
                      entry.kind === "folder" ? <Folder size={17} /> :
                      entry.kind === "file" ? <FileText size={17} /> :
                      entry.kind === "system" ? <Power size={17} /> :
                      <AppWindow size={17} />;
                    const badgeLabel =
                      t(`launcher.badge.${entry.badge.toLowerCase()}`) !== `launcher.badge.${entry.badge.toLowerCase()}`
                        ? t(`launcher.badge.${entry.badge.toLowerCase()}`)
                        : entry.badge;
                    return (
                      <button
                        key={`${entry.id}|${entry.path}`}
                        type="button"
                        className={`start-app-row${armed ? " confirming" : ""}`}
                        onClick={(e) => executeMergedItem(entry, e.ctrlKey && e.shiftKey)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (entry.kind === "system" || entry.kind === "web") return;
                          openContextFor(e, {
                            name: entry.name,
                            path: entry.path,
                            args: entry.args,
                            icon: entry.icon,
                            isFile: entry.kind === "file" || entry.kind === "folder",
                            kind: entry.kind,
                          });
                        }}
                      >
                        <div className="start-app-row-icon">
                          <ShellAppIcon
                            path={entry.path}
                            name={entry.name}
                            initialIcon={entry.icon}
                            skipLookup={!["app", "file", "folder", "tool", "window"].includes(entry.kind)}
                            fallback={rowFallback}
                          />
                        </div>
                        <div className="start-app-row-text">
                          <span className="start-app-row-name">
                            {armed ? t("start.power.confirm") : entry.name}
                          </span>
                          {entry.subtitle && entry.subtitle !== entry.name && (
                            <span className="start-app-row-sub">{entry.subtitle}</span>
                          )}
                        </div>
                        <span className="start-row-badge">{badgeLabel}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="start-empty-box">
                  <span>{t("start.noMatchingApps")}</span>
                  {canUseLauncher && (
                    <button
                      type="button"
                      className="start-pill-btn"
                      onClick={() => handOffToLauncher(query)}
                    >
                      {t("start.searchFilesAndWeb")}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : allAppsOpen ? (
            <div className="start-all-section">
              <div className="start-section-bar">
                <span className="start-section-title">{t("start.allApps")}</span>
                <button
                  type="button"
                  className="start-pill-btn"
                  onClick={() => {
                    setJumpOpen(false);
                    setAllAppsOpen(false);
                  }}
                >
                  <ChevronLeft size={13} />
                  <span>{t("start.back")}</span>
                </button>
              </div>
              <AllAppsList
                apps={allApps}
                jumpOpen={jumpOpen}
                setJumpOpen={setJumpOpen}
                onLaunch={(app, e) => {
                  if (e?.ctrlKey && e?.shiftKey && supportsAdminAndLocation(app.path)) {
                    bridgeInvoke("launch_app_as_admin", {
                      appPath: app.path,
                      appName: app.name,
                      args: app.args ?? null,
                      hwnd: null,
                    })
                      .then(() => hideMenu())
                      .catch(() => setToast(t("start.action.adminUnavailable")));
                  } else {
                    launchTarget(app.path, app.args);
                  }
                }}
                onContextMenu={(e, app) =>
                  openContextFor(e, { name: app.name, path: app.path, args: app.args, icon: app.icon })
                }
              />
            </div>
          ) : (
            <>
              <div className="start-section-bar">
                <span className="start-section-title">{t("start.pinned")}</span>
                <button
                  type="button"
                  className="start-pill-btn"
                  onClick={() => setAllAppsOpen(true)}
                >
                  <span>{t("start.allApps")}</span>
                  <ChevronRight size={13} />
                </button>
              </div>

              <PinnedGrid
                pins={pins}
                columns={columns}
                loading={loading}
                onOpenAllApps={() => setAllAppsOpen(true)}
                onReorder={(next) => {
                  setPins(next);
                  bridgeInvoke("save_start_pins", { pins: next }).catch(() => {});
                }}
                onLaunch={(item, e) => {
                  if (e?.ctrlKey && e?.shiftKey && supportsAdminAndLocation(item.path)) {
                    bridgeInvoke("launch_app_as_admin", {
                      appPath: item.path,
                      appName: item.name,
                      args: item.args ?? null,
                      hwnd: null,
                    })
                      .then(() => hideMenu())
                      .catch(() => setToast(t("start.action.adminUnavailable")));
                  } else {
                    launchTarget(item.path, item.args);
                  }
                }}
                onContextMenu={(e, item) =>
                  openContextFor(e, { name: item.name, path: item.path, args: item.args, icon: item.icon })
                }
              />

              {showRecommended && recommended.length > 0 && (
                <div className="start-recommended-block">
                  <div className="start-section-bar">
                    <span className="start-section-title">{t("start.recommended")}</span>
                  </div>
                  <div className="start-rec-grid">
                    {recommended.slice(0, recCount).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="start-rec-card"
                        onClick={(e) => {
                          if (e.ctrlKey && e.shiftKey && item.kind !== "file" && supportsAdminAndLocation(item.path)) {
                            bridgeInvoke("launch_app_as_admin", {
                              appPath: item.path,
                              appName: item.title,
                              args: item.args ?? null,
                              hwnd: null,
                            })
                              .then(() => hideMenu())
                              .catch(() => setToast(t("start.action.adminUnavailable")));
                          } else {
                            launchTarget(item.path, item.args);
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openContextFor(e, {
                            name: item.title,
                            path: item.path,
                            args: item.args,
                            icon: item.icon,
                            isFile: item.kind === "file",
                          });
                        }}
                      >
                        <div className="start-rec-icon">
                          <ShellAppIcon
                            path={item.path}
                            name={item.title}
                            initialIcon={item.icon}
                            fallback={
                              item.kind === "file" ? (
                                <FileText size={18} strokeWidth={1.7} />
                              ) : (
                                <AppWindow size={18} strokeWidth={1.7} />
                              )
                            }
                          />
                        </div>
                        <div className="start-rec-text">
                          <span className="start-rec-title">{item.title}</span>
                          <span className="start-rec-sub">
                            {item.subtitle === "start.rec.frequent" || item.subtitle === "start.rec.installed"
                              ? t(item.subtitle)
                              : item.subtitle}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="start-footer">
          <div className="start-profile">
            <div className="start-avatar">
              {profile.avatar ? (
                <img src={profile.avatar} alt={profile.display_name} draggable={false} />
              ) : (
                <span>{profile.display_name.slice(0, 1).toUpperCase()}</span>
              )}
            </div>
            <span className="start-username">{profile.display_name}</span>
          </div>

          <div className="start-quick-actions">
            {toast && <span className="start-toast">{toast}</span>}
            {profile.folders.map((folder) => {
              const folderLabel = t(`start.folder.${folder.id}`) !== `start.folder.${folder.id}`
                ? t(`start.folder.${folder.id}`)
                : folder.label;
              return (
                <button
                  key={folder.id}
                  type="button"
                  className="start-footer-icon-btn"
                  title={folderLabel}
                  aria-label={folderLabel}
                  onClick={() => {
                    bridgeInvoke("open_start_folder", { path: folder.path }).catch(() => {});
                    hideMenu();
                  }}
                  onContextMenu={(e) => {
                    if (folder.id === "settings") return;
                    e.preventDefault();
                    e.stopPropagation();
                    openContextFor(e, {
                      name: folderLabel,
                      path: folder.path,
                      isFile: true,
                      kind: "folder",
                    });
                  }}
                >
                  {renderFolderIcon(folder.id)}
                </button>
              );
            })}

            <div className="start-power-anchor" onClick={(e) => e.stopPropagation()}>
              <button
                ref={powerBtnRef}
                type="button"
                className={`start-footer-icon-btn power${powerOpen ? " active" : ""}`}
                title={t("start.power.menu")}
                aria-label={t("start.power.menu")}
                aria-expanded={powerOpen}
                aria-haspopup="menu"
                onClick={() => {
                  setCtxMenu(null);
                  setPowerConfirmId(null);
                  setPowerOpen((v) => !v);
                }}
              >
                <Power size={16} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Power Popover rendered outside overflow-hidden surface so items never clip */}
      {powerOpen && (
        <div
          ref={powerMenuRef}
          role="menu"
          className="start-popover start-power-popover"
          style={{ right: powerPos.right, bottom: powerPos.bottom }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleMenuArrowKeys}
        >
          {POWER_OPTIONS.map((opt) => {
            const PIcon = opt.icon;
            const armed = opt.destructive && powerConfirmId === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="menuitem"
                className={`start-popover-item${armed ? " danger" : ""}`}
                onClick={async () => {
                  if (opt.destructive && powerConfirmId !== opt.id) {
                    setPowerConfirmId(opt.id);
                    return;
                  }
                  setPowerOpen(false);
                  setPowerConfirmId(null);
                  try {
                    await bridgeInvoke("execute_power_action", { action: opt.id });
                    hideMenu();
                  } catch (err) {
                    setToast(typeof err === "string" ? err : String((err as Error)?.message ?? err));
                  }
                }}
              >
                <PIcon size={14} strokeWidth={1.8} />
                <span>{armed ? t("start.power.confirm") : t(opt.labelKey)}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Context Menu rendered outside overflow-hidden surface so edges never clip */}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          role="menu"
          className="start-popover start-context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y, overflow: "visible" }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleMenuArrowKeys}
        >
            <button
              type="button"
              role="menuitem"
              className="start-popover-item"
              onClick={() => runContextAction("open")}
            >
              <ExternalLink size={14} />
              <span>{t("start.ctx.open")}</span>
            </button>
            {!ctxMenu.target.isFile && (
              <button
                type="button"
                role="menuitem"
                className="start-popover-item"
                onClick={() => runContextAction("toggle_pin_start")}
              >
                {ctxMenu.target.pinnedToStart ? <PinOff size={14} /> : <Pin size={14} />}
                <span>
                  {ctxMenu.target.pinnedToStart
                    ? t("start.ctx.unpinStart")
                    : t("start.ctx.pinStart")}
                </span>
              </button>
            )}
            {(supportsAdminAndLocation(ctxMenu.target.path) || !ctxMenu.target.isFile) && (
              <div
                role="menuitem"
                tabIndex={0}
                aria-haspopup="menu"
                aria-expanded={ctxMoreOpen}
                className={`start-popover-item has-submenu${ctxMoreOpen ? " submenu-open" : ""}`}
                onMouseEnter={openCtxMore}
                onMouseLeave={scheduleCtxMoreClose}
                onClick={(e) => {
                  e.stopPropagation();
                  cancelCtxMoreClose();
                  setCtxMoreOpen((v) => !v);
                }}
              >
                <MoreHorizontal size={14} />
                <span>{t("dockmenu.more")}</span>
                <span className="start-submenu-arrow">▶</span>
                <div
                  role="menu"
                  className={`start-popover start-submenu${ctxSubmenuLeft ? " submenu-left" : ""}`}
                  onMouseEnter={openCtxMore}
                  onMouseLeave={scheduleCtxMoreClose}
                  onClick={(e) => e.stopPropagation()}
                >
                  {!ctxMenu.target.isFile && supportsAdminAndLocation(ctxMenu.target.path) && (
                    <button
                      type="button"
                      role="menuitem"
                      className="start-popover-item"
                      onClick={() => runContextAction("run_as_admin")}
                    >
                      <Shield size={14} />
                      <span>{t("start.ctx.runAsAdmin")}</span>
                    </button>
                  )}
                  {supportsAdminAndLocation(ctxMenu.target.path) && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className="start-popover-item"
                        onClick={() => runContextAction("open_location")}
                      >
                        <FolderOpen size={14} />
                        <span>{t("start.ctx.openLocation")}</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="start-popover-item"
                        onClick={() => runContextAction("open_properties")}
                      >
                        <Info size={14} />
                        <span>{t("dockmenu.properties")}</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="start-popover-item"
                        onClick={() => runContextAction("copy_path")}
                      >
                        <Copy size={14} />
                        <span>{t("dockmenu.copyPath")}</span>
                      </button>
                    </>
                  )}
                  {!ctxMenu.target.isFile && (
                    <>
                      {supportsAdminAndLocation(ctxMenu.target.path) && (
                        <div className="start-popover-divider" />
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        className="start-popover-item"
                        onClick={() => runContextAction("toggle_pin_dock")}
                      >
                        {ctxMenu.target.pinnedToDock ? <PinOff size={14} /> : <Pin size={14} />}
                        <span>
                          {ctxMenu.target.pinnedToDock
                            ? t("start.ctx.unpinDock")
                            : t("start.ctx.pinDock")}
                        </span>
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
            {!ctxMenu.target.isFile && supportsAdminAndLocation(ctxMenu.target.path) && ctxMenu.target.kind !== "tool" && (
              <>
                <div className="start-popover-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="start-popover-item"
                  onClick={() => {
                    setCtxMenu(null);
                    bridgeInvoke("open_windows_tool", { tool: "installed_apps" }).catch(() => {});
                    hideMenu();
                  }}
                >
                  <Trash2 size={14} />
                  <span>{t("start.ctx.uninstall")}</span>
                </button>
              </>
            )}
        </div>
      )}
    </div>
  );
}
