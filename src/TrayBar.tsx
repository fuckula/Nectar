import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Pin,
  PinOff,
  LayoutGrid,
  Columns3,
  RefreshCw,
  ExternalLink,
  Check,
  AlertTriangle,
  SlidersHorizontal,
  ImagePlus,
  RotateCcw,
  Eye,
  EyeOff,
  Palette,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { initTheme } from "./theme";
import { useT } from "./i18n";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { computeUpdatedTintExclusions, isAppTintExcluded } from "./utils/iconTint";
import { notifyLocalSettingChanges } from "./utils/settingsHydration";
import type { TrayIconDto } from "./traybar/types";
import {
  parsePinnedTrayKeys,
  parseStringList,
  parseStringMap,
  rasterizeImageFileToPngDataUrl,
  sortTrayIcons,
  trayCustomIconKey,
  trayInteractionCoords,
} from "./traybar/utils";
import {
  applyPreviewThemeParams,
  bridgeInvoke,
  bridgeListen,
  isTauriRuntime,
} from "./utils/tauriBridge";
import "./surfaces.css";

type TrayHostStatus = "active" | "blocked_by_zbid" | "stopped";

const VIEWPORT_PAD = 10;
const GRID_SURFACE_WIDTH = 308;
const BAR_MIN_SURFACE_WIDTH = 308;
const BAR_MAX_SURFACE_WIDTH = 580;

function clampScale(raw: unknown): number {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? "1"));
  return Number.isFinite(n) ? Math.min(1.75, Math.max(0.75, n)) : 1;
}

function persistTraySetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage restrictions
  }
  notifyLocalSettingChanges([key]);
  bridgeInvoke("save_setting", { key, value }).catch(() => {});
}

interface SortableTrayTileProps {
  item: TrayIconDto;
  label: string;
  iconSrc?: string;
  isPinned: boolean;
  isSelected: boolean;
  isHiddenTile: boolean;
  isExcluded: boolean;
  editMode: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onHover: (hovered: boolean) => void;
}

function SortableTrayTile({
  item,
  label,
  iconSrc,
  isPinned,
  isSelected,
  isHiddenTile,
  isExcluded,
  editMode,
  onSelect,
  onTogglePin,
  onHover,
}: SortableTrayTileProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.key, disabled: !editMode });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <button
      ref={setNodeRef}
      type="button"
      style={style}
      {...(editMode ? attributes : {})}
      {...(editMode ? listeners : {})}
      className={`traybar-icon-btn nectar-tint-tile${isPinned ? " pinned" : ""}${
        editMode ? " edit-mode" : ""
      }${isSelected ? " selected" : ""}${isHiddenTile ? " is-hidden-tile" : ""}${
        isDragging ? " is-dragging" : ""
      }`}
      data-tint-excluded={isExcluded ? "true" : undefined}
      title={label}
      aria-label={label}
      aria-pressed={editMode ? isSelected : undefined}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect();
        onTogglePin();
      }}
    >
      {iconSrc ? (
        <img
          src={iconSrc}
          alt={label}
          className={isExcluded ? undefined : "nectar-tintable-icon"}
          data-tint-excluded={isExcluded ? "true" : undefined}
          draggable={false}
        />
      ) : (
        <span className="traybar-fallback-badge">{label.slice(0, 2)}</span>
      )}
      {isHiddenTile && (
        <span className="traybar-hidden-dot" aria-hidden="true">
          <EyeOff size={8} />
        </span>
      )}
      <span
        className={`traybar-pin-dot${isPinned ? " on" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
      >
        {isPinned ? <Pin size={8} /> : <PinOff size={8} />}
      </span>
    </button>
  );
}

export default function TrayBar() {
  const t = useT();
  const [surfaceOpen, setSurfaceOpen] = useState(() => !isTauriRuntime());
  const [icons, setIcons] = useState<TrayIconDto[]>([]);
  const [scale, setScale] = useState<number>(() =>
    clampScale(localStorage.getItem("nectar-scale"))
  );
  const [layout, setLayout] = useState<"grid" | "bar">(() =>
    localStorage.getItem("nectar-tray-bar-layout") === "bar" ? "bar" : "grid"
  );
  const [pinnedKeys, setPinnedKeys] = useState<string[]>(() =>
    parsePinnedTrayKeys(localStorage.getItem("nectar-tray-pinned-keys"))
  );
  const [trayOrder, setTrayOrder] = useState<string[]>(() =>
    parseStringList(localStorage.getItem("nectar-tray-order"))
  );
  const [hiddenKeys, setHiddenKeys] = useState<string[]>(() =>
    parseStringList(localStorage.getItem("nectar-tray-hidden-keys"))
  );
  const [customLabels, setCustomLabels] = useState<Record<string, string>>(() =>
    parseStringMap(localStorage.getItem("nectar-tray-labels"))
  );
  const [customIcons, setCustomIcons] = useState<Record<string, string>>({});
  const [editPins, setEditPins] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [hoveredIcon, setHoveredIcon] = useState<TrayIconDto | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [trayHostStatus, setTrayHostStatus] = useState<TrayHostStatus>("active");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoClose, setAutoClose] = useState<boolean>(
    () => localStorage.getItem("nectar-traybar-autoclose") !== "false"
  );
  const [, setTintExcludedTick] = useState(0);
  const autoCloseRef = useRef(autoClose);
  autoCloseRef.current = autoClose;

  const isMountedRef = useRef(true);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const blurLockRef = useRef(false);
  const blurUnlockTimerRef = useRef<number | null>(null);
  const clickTimersRef = useRef<Record<string, number>>({});
  const revealRafRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const spinTimerRef = useRef<number | null>(null);
  const lastSentSizeRef = useRef<{ width: number; height: number } | null>(null);

  const releaseBlurLockSoon = useCallback((delayMs = 150) => {
    if (blurUnlockTimerRef.current !== null) {
      window.clearTimeout(blurUnlockTimerRef.current);
      blurUnlockTimerRef.current = null;
    }
    blurUnlockTimerRef.current = window.setTimeout(() => {
      blurUnlockTimerRef.current = null;
      if (blurLockRef.current) {
        blurLockRef.current = false;
        bridgeInvoke("set_traybar_blur_lock", { locked: false }).catch(() => {});
      }
    }, delayMs);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      Object.values(clickTimersRef.current).forEach((id) => window.clearTimeout(id));
      clickTimersRef.current = {};
      if (spinTimerRef.current !== null) {
        window.clearTimeout(spinTimerRef.current);
        spinTimerRef.current = null;
      }
      if (blurUnlockTimerRef.current !== null) {
        window.clearTimeout(blurUnlockTimerRef.current);
        blurUnlockTimerRef.current = null;
      }
      if (blurLockRef.current) {
        blurLockRef.current = false;
        bridgeInvoke("set_traybar_blur_lock", { locked: false }).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    const inputEl = fileInputRef.current;
    if (!inputEl) return;
    const onCancel = () => releaseBlurLockSoon(80);
    inputEl.addEventListener("cancel", onCancel);
    return () => inputEl.removeEventListener("cancel", onCancel);
  }, [releaseBlurLockSoon]);

  useEffect(() => {
    if (!editPins) return;
    Object.values(clickTimersRef.current).forEach((id) => window.clearTimeout(id));
    clickTimersRef.current = {};
  }, [editPins]);

  useEffect(() => {
    applyPreviewThemeParams();
    return initTheme({ backdrop: false });
  }, []);

  useEffect(() => {
    let cancelled = false;
    bridgeInvoke<Record<string, unknown>>("load_settings")
      .then((s) => {
        if (cancelled || !s) return;
        if (s["nectar-tray-bar-layout"] != null) {
          setLayout(s["nectar-tray-bar-layout"] === "bar" ? "bar" : "grid");
        }
        if (s["nectar-tray-pinned-keys"] != null) {
          setPinnedKeys(parsePinnedTrayKeys(s["nectar-tray-pinned-keys"]));
        }
        if (s["nectar-tray-order"] != null) {
          setTrayOrder(parseStringList(s["nectar-tray-order"]));
        }
        if (s["nectar-tray-hidden-keys"] != null) {
          setHiddenKeys(parseStringList(s["nectar-tray-hidden-keys"]));
        }
        if (s["nectar-tray-labels"] != null) {
          setCustomLabels(parseStringMap(s["nectar-tray-labels"]));
        }
        if (s["nectar-scale"] != null) {
          setScale(clampScale(s["nectar-scale"]));
        }
        if (s["nectar-traybar-autoclose"] !== undefined) {
          setAutoClose(String(s["nectar-traybar-autoclose"]) !== "false");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useSettingsSync(
    {
      "nectar-tray-bar-layout": (v) => setLayout(v === "bar" ? "bar" : "grid"),
      "nectar-tray-pinned-keys": (v) => setPinnedKeys(parsePinnedTrayKeys(v)),
      "nectar-tray-order": (v) => setTrayOrder(parseStringList(v)),
      "nectar-tray-hidden-keys": (v) => setHiddenKeys(parseStringList(v)),
      "nectar-tray-labels": (v) => setCustomLabels(parseStringMap(v)),
      "nectar-scale": (v) => setScale(clampScale(v)),
      "nectar-traybar-autoclose": (v) => setAutoClose(v !== false && v !== "false"),
      "nectar-icon-tint-excluded": () => setTintExcludedTick((n) => n + 1),
    },
    [],
    {
      onReset: () => {
        try {
          localStorage.removeItem("nectar-tray-bar-layout");
          localStorage.removeItem("nectar-tray-pinned-keys");
          localStorage.removeItem("nectar-tray-order");
          localStorage.removeItem("nectar-tray-hidden-keys");
          localStorage.removeItem("nectar-tray-labels");
          localStorage.removeItem("nectar-traybar-autoclose");
          localStorage.removeItem("nectar-icon-tint-excluded");
        } catch {
          // Ignore storage restrictions
        }
        setLayout("grid");
        setPinnedKeys([]);
        setTrayOrder([]);
        setHiddenKeys([]);
        setCustomLabels({});
        setScale(1);
        setAutoClose(true);
        setTintExcludedTick((n) => n + 1);
      },
    }
  );

  useEffect(() => {
    const onLocal = (e: Event) => {
      const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (!keys || keys.includes("nectar-icon-tint-excluded")) {
        setTintExcludedTick((n) => n + 1);
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === "nectar-icon-tint-excluded") {
        setTintExcludedTick((n) => n + 1);
      }
    };
    window.addEventListener("nectar-local-setting", onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("nectar-local-setting", onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!statusNote) return;
    const id = window.setTimeout(() => setStatusNote(null), 1600);
    return () => window.clearTimeout(id);
  }, [statusNote]);

  const loadIcons = useCallback(() => {
    bridgeInvoke<TrayIconDto[]>("get_tray_icons")
      .then((res) => {
        if (!isMountedRef.current) return;
        if (Array.isArray(res)) {
          setIcons(res.filter((i) => !i.hidden_by_app));
        }
      })
      .catch(() => {});
  }, []);

  const loadCustomIcons = useCallback(() => {
    bridgeInvoke<Record<string, string>>("get_custom_icons")
      .then((res) => {
        if (!isMountedRef.current) return;
        if (res && typeof res === "object") {
          setCustomIcons(res);
        }
      })
      .catch(() => {});
  }, []);

  const refreshHostStatus = useCallback(async (): Promise<TrayHostStatus | null> => {
    try {
      const status = await bridgeInvoke<TrayHostStatus | null>("get_tray_host_status");
      if (!isMountedRef.current) return null;
      if (status === "active" || status === "blocked_by_zbid" || status === "stopped") {
        setTrayHostStatus(status);
        return status;
      }
    } catch {
      // Ignore if backend command is unavailable
    }
    return null;
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    if (spinTimerRef.current !== null) window.clearTimeout(spinTimerRef.current);
    spinTimerRef.current = window.setTimeout(() => {
      spinTimerRef.current = null;
      if (isMountedRef.current) setIsRefreshing(false);
    }, 450);
    await bridgeInvoke("refresh_tray_icons").catch(() => {});
    const status = await refreshHostStatus();
    loadIcons();
    loadCustomIcons();
    const effective = status ?? trayHostStatus;
    if (effective !== "blocked_by_zbid") {
      setStatusNote(t("traybar.refreshed"));
    } else {
      setStatusNote(null);
    }
  }, [loadCustomIcons, loadIcons, refreshHostStatus, t, trayHostStatus]);

  useEffect(() => {
    let cancelled = false;
    loadIcons();
    loadCustomIcons();
    refreshHostStatus();
    let unUpdated: (() => void) | undefined;
    let unCustomIcons: (() => void) | undefined;
    let unShown: (() => void) | undefined;
    let unHidden: (() => void) | undefined;

    const pUpdated = bridgeListen("tray-icons-updated", () => {
      loadIcons();
      refreshHostStatus();
    }).then((fn) => {
      if (cancelled) fn();
      else unUpdated = fn;
    });

    const pCustomIcons = bridgeListen("custom-icons-updated", () => {
      loadCustomIcons();
    }).then((fn) => {
      if (cancelled) fn();
      else unCustomIcons = fn;
    });

    const pShown = bridgeListen<{ scale?: number }>("shell-window-shown", (payload) => {
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      setSurfaceOpen(false);
      setEditPins(false);
      setSelectedKey(null);
      setHoveredIcon(null);
      setStatusNote(null);
      lastSentSizeRef.current = null;
      loadCustomIcons();
      if (typeof payload?.scale === "number") {
        setScale(clampScale(payload.scale));
      }
      revealRafRef.current = requestAnimationFrame(() => {
        revealRafRef.current = null;
        if (cancelled) return;
        setSurfaceOpen(true);
        surfaceRef.current?.focus({ preventScroll: true });
      });
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        if (cancelled) return;
        loadIcons();
        refreshHostStatus();
      }, 150);
    }).then((fn) => {
      if (cancelled) fn();
      else unShown = fn;
    });

    const pHidden = bridgeListen("shell-window-hidden", () => {
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (blurUnlockTimerRef.current !== null) {
        window.clearTimeout(blurUnlockTimerRef.current);
        blurUnlockTimerRef.current = null;
      }
      if (blurLockRef.current) {
        blurLockRef.current = false;
        bridgeInvoke("set_traybar_blur_lock", { locked: false }).catch(() => {});
      }
      Object.values(clickTimersRef.current).forEach((id) => window.clearTimeout(id));
      clickTimersRef.current = {};
      setSurfaceOpen(false);
      setEditPins(false);
      setSelectedKey(null);
      setHoveredIcon(null);
      setStatusNote(null);
    }).then((fn) => {
      if (cancelled) fn();
      else unHidden = fn;
    });

    Promise.all([pUpdated, pCustomIcons, pShown, pHidden]).then(() => {
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
      unUpdated?.();
      unCustomIcons?.();
      unShown?.();
      unHidden?.();
    };
  }, [loadCustomIcons, loadIcons, refreshHostStatus]);

  const orderedAllIcons = useMemo(() => sortTrayIcons(icons, trayOrder), [icons, trayOrder]);
  const hiddenSet = useMemo(() => new Set(hiddenKeys), [hiddenKeys]);
  const displayedIcons = useMemo(
    () => (editPins ? orderedAllIcons : orderedAllIcons.filter((ic) => !hiddenSet.has(ic.key))),
    [orderedAllIcons, editPins, hiddenSet]
  );

  const customLabelsRef = useRef(customLabels);
  customLabelsRef.current = customLabels;

  useEffect(() => {
    if (!editPins) return;
    if (!selectedKey || !orderedAllIcons.some((ic) => ic.key === selectedKey)) {
      const nextKey = orderedAllIcons[0]?.key ?? null;
      setSelectedKey(nextKey);
      setRenameDraft(nextKey ? (customLabelsRef.current[nextKey] ?? "") : "");
    }
  }, [editPins, orderedAllIcons, selectedKey]);

  const selectForEdit = useCallback((key: string) => {
    setSelectedKey(key);
    setRenameDraft(customLabelsRef.current[key] ?? "");
  }, []);

  // Ensure Escape closes Edit mode or TrayBar even before user focuses an inner button
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (editPins) {
        setEditPins(false);
        setSelectedKey(null);
      } else {
        bridgeInvoke("hide_traybar").catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editPins]);

  // Size native Tauri popup deterministically using unzoomed layout dimensions
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const el = surfaceRef.current;
    if (!el) return;
    let raf = 0;
    lastSentSizeRef.current = null;
    const syncSize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const count = displayedIcons.length;
        const naturalBarW =
          count > 0 ? count * 44 + (count - 1) * 6 + 26 : BAR_MIN_SURFACE_WIDTH;
        const targetSurfaceW =
          layout === "grid"
            ? GRID_SURFACE_WIDTH
            : Math.min(BAR_MAX_SURFACE_WIDTH, Math.max(BAR_MIN_SURFACE_WIDTH, naturalBarW));
        const width = Math.min(620, Math.max(328, targetSurfaceW + VIEWPORT_PAD * 2));
        const height = Math.min(520, Math.max(120, Math.ceil(el.offsetHeight) + VIEWPORT_PAD * 2));
        const prev = lastSentSizeRef.current;
        if (prev && prev.width === width && prev.height === height) return;
        lastSentSizeRef.current = { width, height };
        bridgeInvoke("resize_shell_window", { width, height }).catch(() => {});
      });
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(el);
    syncSize();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [displayedIcons.length, layout, editPins, selectedKey, scale, trayHostStatus]);

  const pinnedSet = useMemo(() => new Set(pinnedKeys), [pinnedKeys]);
  const visiblePinnedCount = useMemo(
    () => icons.filter((ic) => pinnedSet.has(ic.key)).length,
    [icons, pinnedSet]
  );

  const selectedItem = useMemo(
    () => orderedAllIcons.find((ic) => ic.key === selectedKey) ?? null,
    [orderedAllIcons, selectedKey]
  );
  const selectedIndex = useMemo(
    () => (selectedItem ? orderedAllIcons.findIndex((ic) => ic.key === selectedItem.key) : -1),
    [orderedAllIcons, selectedItem]
  );

  const handleItemsKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      return;
    }
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".traybar-icon-btn"));
    if (buttons.length === 0) return;
    e.preventDefault();
    const cur = document.activeElement as HTMLButtonElement | null;
    const idx = cur ? buttons.indexOf(cur) : -1;
    let next = 0;
    if (idx === -1) {
      next = e.key === "End" ? buttons.length - 1 : 0;
    } else if (e.key === "Home") {
      next = 0;
    } else if (e.key === "End") {
      next = buttons.length - 1;
    } else if (e.key === "ArrowRight") {
      next = (idx + 1) % buttons.length;
    } else if (e.key === "ArrowLeft") {
      next = (idx - 1 + buttons.length) % buttons.length;
    } else if (e.key === "ArrowDown") {
      next = layout === "grid" ? Math.min(buttons.length - 1, idx + 5) : (idx + 1) % buttons.length;
    } else if (e.key === "ArrowUp") {
      next = layout === "grid" ? Math.max(0, idx - 5) : (idx - 1 + buttons.length) % buttons.length;
    }
    buttons[next]?.focus();
  };

  const toggleLayout = () => {
    const next = layout === "grid" ? "bar" : "grid";
    setLayout(next);
    persistTraySetting("nectar-tray-bar-layout", next);
  };

  const togglePin = (key: string) => {
    const next = pinnedSet.has(key)
      ? pinnedKeys.filter((k) => k !== key)
      : [...pinnedKeys, key];
    setPinnedKeys(next);
    persistTraySetting("nectar-tray-pinned-keys", JSON.stringify(next));
  };

  const commitOrder = (nextOrder: string[]) => {
    setTrayOrder(nextOrder);
    persistTraySetting("nectar-tray-order", JSON.stringify(nextOrder));
    setStatusNote(t("traybar.orderSaved"));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const currentKeys = orderedAllIcons.map((ic) => ic.key);
    const oldIndex = currentKeys.indexOf(String(active.id));
    const newIndex = currentKeys.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    commitOrder(arrayMove(currentKeys, oldIndex, newIndex));
  };

  const moveSelected = (delta: -1 | 1) => {
    if (!selectedItem) return;
    const currentKeys = orderedAllIcons.map((ic) => ic.key);
    const idx = currentKeys.indexOf(selectedItem.key);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= currentKeys.length) return;
    commitOrder(arrayMove(currentKeys, idx, targetIdx));
  };

  const resetOrder = () => {
    setTrayOrder([]);
    persistTraySetting("nectar-tray-order", "[]");
    setStatusNote(t("traybar.orderSaved"));
  };

  const commitCustomLabel = (key: string, rawValue: string) => {
    const trimmed = rawValue.trim();
    const nextMap = { ...customLabels };
    if (trimmed) {
      nextMap[key] = trimmed;
    } else {
      delete nextMap[key];
    }
    setCustomLabels(nextMap);
    persistTraySetting("nectar-tray-labels", JSON.stringify(nextMap));
  };

  const toggleHidden = (key: string) => {
    const next = hiddenSet.has(key)
      ? hiddenKeys.filter((k) => k !== key)
      : [...hiddenKeys, key];
    setHiddenKeys(next);
    persistTraySetting("nectar-tray-hidden-keys", JSON.stringify(next));
  };

  const toggleTintExclusion = (item: TrayIconDto) => {
    const targetId = item.exe_name || item.title || item.key;
    let currentRaw: string | null = null;
    try {
      currentRaw = localStorage.getItem("nectar-icon-tint-excluded");
    } catch {
      currentRaw = null;
    }
    const wasExcluded = isAppTintExcluded(targetId);
    let result = computeUpdatedTintExclusions(targetId, currentRaw);
    if (wasExcluded && result.excluded && result.key) {
      const altKey = result.key.endsWith(".exe") ? result.key.slice(0, -4) : `${result.key}.exe`;
      if (altKey) {
        result = computeUpdatedTintExclusions(altKey, currentRaw);
      }
    }
    setTintExcludedTick((n) => n + 1);
    persistTraySetting("nectar-icon-tint-excluded", result.serialized);
  };

  const openCustomIconPicker = () => {
    if (!selectedItem || !fileInputRef.current) return;
    blurLockRef.current = true;
    bridgeInvoke("set_traybar_blur_lock", { locked: true }).catch(() => {});
    window.addEventListener("focus", () => releaseBlurLockSoon(150), { once: true });
    fileInputRef.current.click();
  };

  const handleCustomIconFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    releaseBlurLockSoon(150);
    if (!file || !selectedItem) return;
    try {
      const pngDataUri = await rasterizeImageFileToPngDataUrl(file, 128);
      const cacheKey = trayCustomIconKey(selectedItem.key);
      const saved = await bridgeInvoke<string>("set_custom_icon", {
        cacheKey,
        iconData: pngDataUri,
      });
      if (!isMountedRef.current) return;
      setCustomIcons((prev) => ({ ...prev, [cacheKey]: saved || pngDataUri }));
      setStatusNote(t("traybar.iconSaved"));
    } catch (err) {
      if (!isMountedRef.current) return;
      setStatusNote(typeof err === "string" ? err : String(err));
    }
  };

  const handleResetCustomIcon = async () => {
    if (!selectedItem) return;
    const cacheKey = trayCustomIconKey(selectedItem.key);
    try {
      await bridgeInvoke("remove_custom_icon", { path: cacheKey, name: null });
      if (!isMountedRef.current) return;
      setCustomIcons((prev) => {
        const next = { ...prev };
        delete next[cacheKey];
        return next;
      });
      setStatusNote(t("traybar.iconReset"));
    } catch (err) {
      if (!isMountedRef.current) return;
      setStatusNote(typeof err === "string" ? err : String(err));
    }
  };

  const forwardClick = (e: React.MouseEvent<HTMLButtonElement>, item: TrayIconDto, action: string) => {
    if (!editPins && action === "right" && e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      setEditPins(true);
      selectForEdit(item.key);
      return;
    }
    if (editPins) {
      if (action === "left") selectForEdit(item.key);
      return;
    }
    const coords = trayInteractionCoords(e, scale);
    if (action === "left" && e.detail > 1) {
      return;
    }
    if (action === "left" && e.detail === 1) {
      const prev = clickTimersRef.current[item.key];
      if (prev) window.clearTimeout(prev);
      clickTimersRef.current[item.key] = window.setTimeout(() => {
        delete clickTimersRef.current[item.key];
        bridgeInvoke("interact_tray_icon", {
          key: item.key,
          action: "left",
          ...coords,
        })
          .then(() => {
            if (autoCloseRef.current) {
              bridgeInvoke("hide_traybar").catch(() => {});
            }
          })
          .catch((err) => setStatusNote(String(err)));
      }, 210);
      return;
    }
    if (action === "double") {
      const prev = clickTimersRef.current[item.key];
      if (prev) {
        window.clearTimeout(prev);
        delete clickTimersRef.current[item.key];
      }
    }
    bridgeInvoke("interact_tray_icon", {
      key: item.key,
      action,
      ...coords,
    })
      .then(() => {
        if (autoCloseRef.current && (action === "left" || action === "double")) {
          bridgeInvoke("hide_traybar").catch(() => {});
        }
      })
      .catch((err) => setStatusNote(String(err)));
  };

  // The idle hint bar is gone: the footer only appears with real content
  // (a status note, a hovered icon, or the edit-mode instructions).
  const footerText = statusNote || hoveredIcon ? null : editPins ? t("traybar.editModeHint") : null;
  const showFooterBar = Boolean(statusNote || hoveredIcon || footerText);

  const selectedIconSrc = selectedItem
    ? customIcons[trayCustomIconKey(selectedItem.key)] || selectedItem.icon
    : undefined;
  const selectedHasCustomIcon = selectedItem
    ? Boolean(customIcons[trayCustomIconKey(selectedItem.key)])
    : false;
  const selectedIsPinned = selectedItem ? pinnedSet.has(selectedItem.key) : false;
  const selectedIsHidden = selectedItem ? hiddenSet.has(selectedItem.key) : false;
  const selectedIsExcluded = selectedItem
    ? isAppTintExcluded(selectedItem.exe_name || selectedItem.title || selectedItem.key)
    : false;

  return (
    <div
      className="traybar-viewport"
      style={
        {
          zoom: scale,
          width: `${100 / scale}vw`,
          minHeight: `${100 / scale}vh`,
        } as CSSProperties
      }
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          bridgeInvoke("hide_traybar").catch(() => {});
        }
      }}
    >
      <div
        ref={surfaceRef}
        tabIndex={-1}
        className={`nectar-shell-surface traybar-surface layout-${layout}${
          editPins ? " edit-pins-active" : ""
        } shell-anim-surface shell-anim-traybar ${surfaceOpen ? "is-open" : "is-hidden"}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,.png,.jpg,.jpeg,.webp,.svg,.ico"
          style={{ display: "none" }}
          onChange={handleCustomIconFileChange}
        />

        <div className="traybar-header">
          <div className="traybar-title-group">
            <span className="traybar-title">
              {editPins ? t("traybar.editModeTitle") : t("traybar.title")}
            </span>
            {(editPins ? visiblePinnedCount > 0 : displayedIcons.length > 0) && (
              <span
                className="traybar-count-badge"
                title={editPins ? t("traybar.pinnedCount") : t("traybar.title")}
              >
                {editPins ? visiblePinnedCount : displayedIcons.length}
              </span>
            )}
          </div>
          <div className="traybar-controls">
            <button
              type="button"
              className={`traybar-tool-btn${editPins ? " active" : ""}`}
              title={t("traybar.editPins")}
              aria-label={t("traybar.editPins")}
              aria-pressed={editPins}
              onClick={() =>
                setEditPins((v) => {
                  const next = !v;
                  if (!next) setSelectedKey(null);
                  return next;
                })
              }
            >
              {editPins ? <Check size={13} strokeWidth={2.2} /> : <SlidersHorizontal size={13} strokeWidth={1.8} />}
            </button>
            <button
              type="button"
              className="traybar-tool-btn"
              title={layout === "grid" ? t("traybar.switchToBar") : t("traybar.switchToGrid")}
              aria-label={layout === "grid" ? t("traybar.switchToBar") : t("traybar.switchToGrid")}
              onClick={toggleLayout}
            >
              {layout === "grid" ? <Columns3 size={13} strokeWidth={1.8} /> : <LayoutGrid size={13} strokeWidth={1.8} />}
            </button>
            <button
              type="button"
              className={`traybar-tool-btn${isRefreshing ? " is-spinning" : ""}`}
              title={t("traybar.refresh")}
              aria-label={t("traybar.refresh")}
              onClick={handleRefresh}
            >
              <RefreshCw size={13} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className="traybar-tool-btn"
              title={t("traybar.nativeTray")}
              aria-label={t("traybar.nativeTray")}
              onClick={() => bridgeInvoke("open_native_tray").catch(() => {})}
            >
              <ExternalLink size={13} strokeWidth={1.8} />
            </button>
          </div>
        </div>

        {trayHostStatus === "blocked_by_zbid" && (
          <div className="traybar-zbid-notice" role="status">
            <div className="traybar-zbid-head">
              <AlertTriangle size={15} strokeWidth={2} />
              <span className="traybar-zbid-title">{t("traybar.zbidNoticeTitle")}</span>
            </div>
            <p className="traybar-zbid-body">{t("traybar.zbidNoticeBody")}</p>
            <button
              type="button"
              className="traybar-zbid-btn"
              onClick={() => bridgeInvoke("open_native_tray").catch(() => {})}
            >
              <ExternalLink size={13} strokeWidth={2} />
              <span>{t("traybar.openNativeFallback")}</span>
            </button>
          </div>
        )}

        {displayedIcons.length > 0 ? (
          editPins ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={displayedIcons.map((ic) => ic.key)}
                strategy={layout === "grid" ? rectSortingStrategy : horizontalListSortingStrategy}
              >
                <div
                  className={`traybar-items ${layout}`}
                  onKeyDown={handleItemsKeyDown}
                  onWheel={(e) => {
                    if (layout === "bar" && e.deltaY !== 0) {
                      e.currentTarget.scrollLeft += e.deltaY;
                    }
                  }}
                >
                  {displayedIcons.map((item) => {
                    const isPinned = pinnedSet.has(item.key);
                    const isHiddenTile = hiddenSet.has(item.key);
                    const label = customLabels[item.key] || item.title || item.exe_name || "?";
                    const iconSrc = customIcons[trayCustomIconKey(item.key)] || item.icon || undefined;
                    const isExcluded = isAppTintExcluded(item.exe_name || item.title || item.key);
                    return (
                      <SortableTrayTile
                        key={item.key}
                        item={item}
                        label={label}
                        iconSrc={iconSrc}
                        isPinned={isPinned}
                        isSelected={selectedKey === item.key}
                        isHiddenTile={isHiddenTile}
                        isExcluded={isExcluded}
                        editMode={editPins}
                        onSelect={() => selectForEdit(item.key)}
                        onTogglePin={() => togglePin(item.key)}
                        onHover={(hovered) =>
                          hovered
                            ? setHoveredIcon(item)
                            : setHoveredIcon((cur) => (cur?.key === item.key ? null : cur))
                        }
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <div
              className={`traybar-items ${layout}`}
              onKeyDown={handleItemsKeyDown}
              onWheel={(e) => {
                if (layout === "bar" && e.deltaY !== 0) {
                  e.currentTarget.scrollLeft += e.deltaY;
                }
              }}
            >
              {displayedIcons.map((item) => {
                const isPinned = pinnedSet.has(item.key);
                const label = customLabels[item.key] || item.title || item.exe_name || "?";
                const iconSrc = customIcons[trayCustomIconKey(item.key)] || item.icon;
                const isExcluded = isAppTintExcluded(item.exe_name || item.title || item.key);
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`traybar-icon-btn nectar-tint-tile${isPinned ? " pinned" : ""}`}
                    data-tint-excluded={isExcluded ? "true" : undefined}
                    title={label}
                    aria-label={label}
                    onMouseEnter={() => setHoveredIcon(item)}
                    onMouseLeave={() => setHoveredIcon((cur) => (cur?.key === item.key ? null : cur))}
                    onFocus={() => setHoveredIcon(item)}
                    onBlur={() => setHoveredIcon((cur) => (cur?.key === item.key ? null : cur))}
                    onClick={(e) => forwardClick(e, item, "left")}
                    onDoubleClick={(e) => forwardClick(e, item, "double")}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      forwardClick(e, item, "right");
                    }}
                    onMouseDown={(e) => {
                      if (e.button === 1) e.preventDefault();
                    }}
                    onAuxClick={(e) => {
                      if (e.button === 1) forwardClick(e, item, "middle");
                    }}
                  >
                    {iconSrc ? (
                      <img
                        src={iconSrc}
                        alt={label}
                        className={isExcluded ? undefined : "nectar-tintable-icon"}
                        data-tint-excluded={isExcluded ? "true" : undefined}
                        draggable={false}
                      />
                    ) : (
                      <span className="traybar-fallback-badge">{label.slice(0, 2)}</span>
                    )}
                    {isPinned && (
                      <span className="traybar-pin-dot on">
                        <Pin size={8} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )
        ) : trayHostStatus !== "blocked_by_zbid" ? (
          <div className="traybar-empty">
            <span>{t("traybar.empty")}</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
              {orderedAllIcons.length > 0 && !editPins && (
                <button
                  type="button"
                  className="traybar-refresh-pill"
                  onClick={() => setEditPins(true)}
                >
                  {t("traybar.editPins")}
                </button>
              )}
              <button
                type="button"
                className="traybar-refresh-pill"
                onClick={handleRefresh}
              >
                {t("traybar.refresh")}
              </button>
              <button
                type="button"
                className="traybar-refresh-pill"
                onClick={() => bridgeInvoke("open_native_tray").catch(() => {})}
              >
                {t("traybar.openNativeFallback")}
              </button>
            </div>
          </div>
        ) : null}

        {editPins && selectedItem && (
          <div className="traybar-editor" role="region" aria-label={t("traybar.editModeTitle")}>
            <div className="traybar-editor-head">
              <div className="traybar-editor-preview">
                {selectedIconSrc ? (
                  <img
                    src={selectedIconSrc}
                    alt=""
                    className={selectedIsExcluded ? undefined : "nectar-tintable-icon"}
                    data-tint-excluded={selectedIsExcluded ? "true" : undefined}
                  />
                ) : (
                  <span>{(selectedItem.title || selectedItem.exe_name || "?").slice(0, 2)}</span>
                )}
              </div>
              <span className="traybar-editor-name">
                {selectedItem.title || selectedItem.exe_name || selectedItem.key}
              </span>
              <div className="traybar-editor-order">
                <button
                  type="button"
                  className="traybar-editor-mini-btn"
                  title={t("traybar.moveLeft")}
                  aria-label={t("traybar.moveLeft")}
                  disabled={selectedIndex <= 0}
                  onClick={() => moveSelected(-1)}
                >
                  <ChevronLeft size={13} />
                </button>
                <button
                  type="button"
                  className="traybar-editor-mini-btn"
                  title={t("traybar.moveRight")}
                  aria-label={t("traybar.moveRight")}
                  disabled={selectedIndex < 0 || selectedIndex >= orderedAllIcons.length - 1}
                  onClick={() => moveSelected(1)}
                >
                  <ChevronRight size={13} />
                </button>
                {trayOrder.length > 0 && (
                  <button
                    type="button"
                    className="traybar-editor-mini-btn"
                    title={t("traybar.resetOrder")}
                    aria-label={t("traybar.resetOrder")}
                    onClick={resetOrder}
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
              </div>
            </div>

            <input
              type="text"
              className="traybar-rename-input"
              value={renameDraft}
              maxLength={64}
              placeholder={t("traybar.renamePlaceholder")}
              aria-label={t("traybar.rename")}
              onChange={(e) => {
                const nextVal = e.target.value;
                setRenameDraft(nextVal);
                commitCustomLabel(selectedItem.key, nextVal);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
              }}
            />

            <div className="traybar-editor-actions">
              <button
                type="button"
                className={`traybar-editor-btn${selectedIsPinned ? " active" : ""}`}
                title={selectedIsPinned ? t("dockmenu.unpin") : t("dockmenu.pin")}
                aria-label={selectedIsPinned ? t("dockmenu.unpin") : t("dockmenu.pin")}
                onClick={() => togglePin(selectedItem.key)}
              >
                {selectedIsPinned ? <PinOff size={12} /> : <Pin size={12} />}
                <span>{selectedIsPinned ? t("dockmenu.unpin") : t("dockmenu.pin")}</span>
              </button>
              <button
                type="button"
                className="traybar-editor-btn"
                title={t("traybar.changeIcon")}
                aria-label={t("traybar.changeIcon")}
                onClick={openCustomIconPicker}
              >
                <ImagePlus size={12} />
                <span>{t("traybar.changeIcon")}</span>
              </button>
              {selectedHasCustomIcon && (
                <button
                  type="button"
                  className="traybar-editor-btn"
                  title={t("traybar.resetIcon")}
                  aria-label={t("traybar.resetIcon")}
                  onClick={handleResetCustomIcon}
                >
                  <RotateCcw size={12} />
                  <span>{t("traybar.resetIcon")}</span>
                </button>
              )}
              <button
                type="button"
                className={`traybar-editor-btn${selectedIsExcluded ? " active" : ""}`}
                title={t("traybar.toggleTint")}
                aria-label={t("traybar.toggleTint")}
                onClick={() => toggleTintExclusion(selectedItem)}
              >
                <Palette size={12} />
                <span>{t("traybar.toggleTint")}</span>
              </button>
              <button
                type="button"
                className={`traybar-editor-btn${selectedIsHidden ? " active" : ""}`}
                title={selectedIsHidden ? t("traybar.showIcon") : t("traybar.hideIcon")}
                aria-label={selectedIsHidden ? t("traybar.showIcon") : t("traybar.hideIcon")}
                onClick={() => toggleHidden(selectedItem.key)}
              >
                {selectedIsHidden ? <Eye size={12} /> : <EyeOff size={12} />}
                <span>{selectedIsHidden ? t("traybar.showIcon") : t("traybar.hideIcon")}</span>
              </button>
            </div>
          </div>
        )}

        {/* Fixed-height footer slot, always mounted: toggling it on hover changes the
            surface height, the ResizeObserver resizes the host window and the hover is
            lost, which oscillates. Content swaps inside a stable 30px slot instead. */}
        <div className={`traybar-tooltip-bar${showFooterBar ? "" : " empty"}`}>
          {statusNote ? (
            <span className="traybar-tip-title">{statusNote}</span>
          ) : hoveredIcon ? (
            <>
              {pinnedSet.has(hoveredIcon.key) && (
                <span className="traybar-tip-pin" title={t("traybar.pinnedCount")}>
                  <Pin size={11} strokeWidth={2.2} />
                </span>
              )}
              <span className="traybar-tip-title">
                {customLabels[hoveredIcon.key] || hoveredIcon.title || hoveredIcon.exe_name}
              </span>
              {hoveredIcon.exe_name && (
                <span className="traybar-tip-exe">{hoveredIcon.exe_name}</span>
              )}
            </>
          ) : footerText ? (
            <span className="traybar-tip-title">{footerText}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
