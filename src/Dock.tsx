import { Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, memo } from 'react';
import { motion, AnimatePresence, Reorder, useIsPresent } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Activity, AppWindow, Bell, Check, Copy, Cpu, Download, ExternalLink, EyeOff, FileText, Film, Folder, FolderOpen, HardDrive, House, Image as ImageIcon, Info, Lock, LogOut, Maximize2, Minimize2, Monitor, Moon, MoreHorizontal, Music, Palette, Pencil, Pin, PinOff, Play, Plus, PlusSquare, Power, RotateCcw, Search as SearchLucide, Settings, Shield, Sliders, Terminal, Trash2, Wifi, X, XCircle } from 'lucide-react';
import './Dock.css';
import './surfaces.css';
import { SurfaceShape } from "./components/SurfaceShape";
import { initTheme } from './theme';
import { useSettingsSync } from './hooks/useSettingsSync';
import { clearSettingsPreservingOnboarding, hydrateSettingsFromBackend, notifyLocalSettingChanges } from './utils/settingsHydration';
import { computeUpdatedTintExclusions, isAppTintExcluded, parseExcludedTintApps } from './utils/iconTint';
import { bridgeInvoke, bridgeListen } from './utils/tauriBridge';
import { useT } from './i18n';
import { PlayIcon, PauseIcon, SkipBackIcon, SkipForwardIcon } from './icons';
import { setVisibleInterval } from "./hooks/visibleInterval";
import { useSurfaceMetrics } from "./hooks/useSurfaceMetrics";
import { isGameModeSuppressToastsActive, useGameMode } from "./hooks/useGameMode";
import { appAttention } from "./attention";
import type { TrayIconDto } from "./traybar/types";
import { parsePinnedTrayKeys, parseStringList, parseStringMap, syncPinnedOrder, trayCustomIconKey, trayInteractionCoords } from "./traybar/utils";

interface AppInfo {
  name: string;
  path: string;
  icon: string | null;
  is_running: boolean;
  is_pinned?: boolean;
  hwnd?: number;
  executable?: string;
  all_hwnds?: [number, string][];
  args?: string;
}

// Browser hosts (Edge/Chrome/Brave/ApplicationFrameHost) run every PWA/UWP window, so the
// title is part of the identity or two PWAs would merge into one item.
const HOST_PROCESSES = ['msedge.exe', 'chrome.exe', 'brave.exe', 'applicationframehost.exe'];
export function isBrowserHost(path: string) {
  const p = path.toLowerCase();
  return HOST_PROCESSES.some(host => p.includes(host));
}

// Stable identity for a dock item.
export function appIdentity(p: string, executable?: string, name?: string) {
  if (!p) return "";
  const normalized = p.toLowerCase().replace(/\\/g, '/');
  // Shell application ids (AUMIDs) and bare names are unique on their own.
  if (!normalized.includes('/')) return normalized;
  if (name && isBrowserHost(normalized)) {
    return `${normalized}:${name.toLowerCase()}`;
  }
  if (executable) return `${normalized}:${executable.toLowerCase()}`;
  return normalized;
}

const itemKey = (app: AppInfo) => appIdentity(app.path, app.executable, app.name);

// Fuzzy identity: a running window and its installed or pinned entry can have different
// paths (exe, .lnk, AUMID), so exact keys miss.
export function isSameApp(a: AppInfo, b: AppInfo): boolean {
  if (!a.path || !b.path) return false;
  if (itemKey(a) === itemKey(b)) return true;
  // Browser hosts run many apps under one exe, only the full identity can match those.
  if (isBrowserHost(a.path) || isBrowserHost(b.path)) return false;
  const aId = isIdentifier(a.path);
  const bId = isIdentifier(b.path);
  // Two opaque shell ids match only exactly (checked above).
  if (aId && bId) return false;
  if (aId !== bId) {
    // One side is an AUMID, the other a file path. AUMIDs contain the product name, so match
    // on overlapping display names plus the exe stem inside the id.
    const fileSide = aId ? b : a;
    const idLower = (aId ? a : b).path.toLowerCase();
    const na = a.name.toLowerCase();
    const nb = b.name.toLowerCase();
    if (na !== nb && !na.includes(nb) && !nb.includes(na)) return false;
    const stem = (fileSide.executable?.toLowerCase() || fileOf(fileSide.path)).replace(
      /\.(exe|lnk)$/,
      ""
    );
    return stem.length >= 3 && idLower.includes(stem);
  }
  if (appIdentity(a.path) === appIdentity(b.path)) return true;
  const normExe = (s: string) => (s.endsWith(".exe") ? s : `${s}.exe`);
  const aExe = a.executable?.toLowerCase() || fileOf(a.path);
  const bExe = b.executable?.toLowerCase() || fileOf(b.path);
  if (!aExe || !bExe) return false;
  return normExe(aExe) === normExe(bExe);
}

const fileOf = (p: string) =>
  (p.split("/").pop()?.split("\\").pop()?.toLowerCase() || "").replace(/\.lnk$/, "");

// AUMIDs identify one app. Two PWAs in the same browser must never match on the shared exe name.
const isIdentifier = (p: string) => !p.includes('/') && !p.includes('\\');

const isNectarWindow = (app: { name: string; path: string }) =>
  app.path.toLowerCase().includes('nectar.exe') || app.name.toLowerCase() === 'nectar';

const NECTAR_MENU_IDS = ["calendar", "settings", "taskmgr", "restart", "clearicons", "quit"];

function parseMenuItems(val: unknown): string[] {
  try {
    const parsed = typeof val === "string" ? JSON.parse(val) : val;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => NECTAR_MENU_IDS.includes(id)) : NECTAR_MENU_IDS;
  } catch {
    return NECTAR_MENU_IDS;
  }
}

interface HiddenApp { id: string; name: string }

function parseHiddenApps(val: unknown): HiddenApp[] {
  try {
    const parsed = typeof val === "string" ? JSON.parse(val) : val;
    return Array.isArray(parsed)
      ? parsed.filter((h): h is HiddenApp => !!h && typeof h.id === "string" && typeof h.name === "string")
      : [];
  } catch {
    return [];
  }
}

function parseDrives(val: string | null): string[] {
  try {
    const parsed = JSON.parse(val ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

const MAX_SOLID_ICON_CACHE = 200;
const solidIconCache = new Map<string, boolean>();

function setBoundedSolidIconCache(key: string, value: boolean) {
  if (solidIconCache.has(key)) {
    solidIconCache.delete(key);
  } else if (solidIconCache.size >= MAX_SOLID_ICON_CACHE) {
    const oldest = solidIconCache.keys().next().value;
    if (oldest !== undefined) solidIconCache.delete(oldest);
  }
  solidIconCache.set(key, value);
}

type DockIndicatorMode = "dots" | "pill" | "bar" | "glow" | "fixed" | "none";
const VALID_DOCK_INDICATORS = new Set<DockIndicatorMode>(["dots", "pill", "bar", "glow", "fixed", "none"]);
function sanitizeDockIndicator(val?: unknown): DockIndicatorMode {
  const s = typeof val === "string" ? val.trim() : "";
  return VALID_DOCK_INDICATORS.has(s as DockIndicatorMode) ? (s as DockIndicatorMode) : "dots";
}

interface ExplorerJumpListItem {
  id: string;
  path: string;
  kind: string;
}

function isExplorerApp(app: AppInfo | null | undefined): boolean {
  if (!app) return false;
  const pathLower = app.path.toLowerCase().replace(/\//g, "\\");
  const exeLower = (app.executable ?? "").toLowerCase();
  const nameLower = app.name.toLowerCase();
  return (
    exeLower === "explorer.exe" ||
    pathLower === "explorer.exe" ||
    pathLower === "explorer" ||
    pathLower.endsWith("\\explorer.exe") ||
    nameLower === "file explorer"
  );
}

function supportsWinFileActions(app: AppInfo | null | undefined): boolean {
  if (!app || !app.path) return false;
  const norm = app.path.trim().replace(/\\/g, "/").toLowerCase();
  if (!norm || norm === "start" || norm === "nectar-settings") return false;
  if (norm.startsWith("ms-") || norm.startsWith("http://") || norm.startsWith("https://")) {
    return false;
  }
  const isFrameHost = (app.executable ?? "").toLowerCase() === "applicationframehost.exe";
  const hasLiveWin32Hwnd = Boolean(app.is_running && app.hwnd && !isFrameHost);
  if (norm.startsWith("shell:")) {
    return norm.startsWith("shell:appsfolder") && hasLiveWin32Hwnd;
  }
  const isAumid =
    norm.includes("!") ||
    (!norm.includes("/") &&
      ![".exe", ".lnk", ".msc", ".bat", ".cmd", ".cpl", ".ps1", ".vbs", ".msi"].some((ext) =>
        norm.endsWith(ext)
      ));
  if (isAumid) return hasLiveWin32Hwnd;
  return true;
}

type DockSubmenuId = "places" | "more" | "window" | "appearance" | "system" | "power" | "nectar";

type DockShortcutMenu =
  | { kind: "recycle" }
  | { kind: "drive"; letter: string }
  | { kind: "tray" }
  | { kind: "search" }
  | { kind: "calendar" };

interface ContextWindowState {
  minimized: boolean;
  maximized: boolean;
  topmost: boolean;
}

function translateWithFallback(
  tFn: (key: string, params?: Record<string, string | number>) => string,
  key: string,
  fallback: string,
  params?: Record<string, string | number>
): string {
  const resolved = tFn(key, params);
  if (resolved !== key) return resolved;
  return params
    ? fallback.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
    : fallback;
}

function hasOpaqueCorners(img: HTMLImageElement): boolean {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;
    return [[0, 0], [15, 0], [0, 15], [15, 15]].every(([x, y]) => data[(y * 16 + x) * 4 + 3] > 235);
  } catch {
    return false;
  }
}

function DockAppIcon({
  src,
  alt,
  nectar,
  tintExcluded = false,
}: {
  src: string | undefined;
  alt: string;
  nectar: boolean;
  tintExcluded?: boolean;
}) {
  const [solid, setSolid] = useState(() => (src ? solidIconCache.get(src) ?? false : false));
  useEffect(() => {
    setSolid(src ? solidIconCache.get(src) ?? false : false);
  }, [src]);
  const className = [
    nectar ? 'nectar-icon-img' : solid ? 'solid-icon' : '',
    !tintExcluded ? 'nectar-tintable-icon' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <img
      src={src}
      alt={alt}
      className={className || undefined}
      data-tint-excluded={tintExcluded ? 'true' : undefined}
      draggable={false}
      onLoad={(e) => {
        if (nectar || !src) return;
        if (!solidIconCache.has(src)) {
          setBoundedSolidIconCache(src, hasOpaqueCorners(e.currentTarget));
        }
        setSolid(solidIconCache.get(src) ?? false);
      }}
    />
  );
}

// Start button icon: a public asset, or the data URI of an uploaded icon ("custom:" prefix).
function resolveStartIcon(startIcon: string): string {
  if (startIcon === "windows") return "/windows.svg";
  if (startIcon.startsWith("custom:")) return startIcon.slice("custom:".length);
  return "/nectar.png";
}

// Stable module-level constants so object references never change between renders,
// preventing Framer Motion from re-triggering animations on every re-render.
const ITEM_ENTRY_TRANSITION = {
  opacity: { duration: 0.15, delay: 0.15 },
  scale: { type: 'spring' as const, stiffness: 400, damping: 25, delay: 0.15 }
};
const DOCK_SPRING = { type: "spring", stiffness: 250, damping: 28, mass: 0.8 } as const;
const DOCK_SLIDE_SPRING = { type: "spring", stiffness: 420, damping: 38, mass: 0.8 } as const;
const CLASSIC_DOCK_SPRING = { type: "spring", stiffness: 250, damping: 22, mass: 0.8 } as const;
const CLASSIC_DOCK_SLIDE_SPRING = { type: "spring", stiffness: 400, damping: 35, mass: 0.8 } as const;
const CLASSIC_CORNER_SPRING = { type: "spring", stiffness: 500, damping: 30 } as const;
const MODERN_LAYOUT_SPRING = { type: "spring", stiffness: 300, damping: 35 } as const;
const CLASSIC_LAYOUT_SPRING = { type: "spring", stiffness: 300, damping: 25 } as const;
const ITEM_INITIAL = { opacity: 0, scale: 0 };
const ITEM_ANIMATE = { opacity: 1, scale: 1 };
const ITEM_EXIT = { opacity: 0, scale: 0 };
// Without an explicit transition framer-motion's default spring makes the hover lift bounce.
const ICON_SPRING = { type: "spring", stiffness: 500, damping: 38 } as const;
const CLASSIC_ICON_SPRING = { type: "spring", stiffness: 400, damping: 20 } as const;

function SearchIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4.5" width="18" height="16" rx="3" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="8" y1="2.5" x2="8" y2="6.5" />
      <line x1="16" y1="2.5" x2="16" y2="6.5" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 15 12 9 18 15" />
    </svg>
  );
}

function TaskViewIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="14" height="11" rx="2.5" />
      <path d="M7 19.5h12a2.5 2.5 0 0 0 2.5-2.5V9.5" />
    </svg>
  );
}

function RecycleIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6 7l1 13h10l1-13" />
      <line x1="10" y1="11" x2="10" y2="16" />
      <line x1="14" y1="11" x2="14" y2="16" />
    </svg>
  );
}

function DriveIcon({ letter }: { letter: string }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="7" width="19" height="10" rx="3" />
      <text x="12" y="14.6" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none">{letter}</text>
    </svg>
  );
}

// One dot per open window, capped at three.
interface AppMediaSession {
  app_id: string;
  title: string;
  artist: string;
  is_playing: boolean;
}

function sessionForApp(app: AppInfo, sessions: AppMediaSession[]): AppMediaSession | undefined {
  const exe = (app.executable || app.path.split(/[\\/]/).pop() || "").toLowerCase().replace(/\.exe$/, "");
  if (!exe) return undefined;
  return sessions.find((s) => s.app_id.toLowerCase().replace(/\.exe$/, "").includes(exe));
}

// Window titles of an item, joined; unread counts live in them.
const windowTitles = (app: AppInfo) => app.all_hwnds?.map(([, title]) => title).join("\n") ?? "";

// Shown on apps that want attention, with the unread count when the app gives one.
function AttentionBadge({ count }: { count: number }) {
  return (
    <span className={`attention-badge${count > 0 ? " has-count" : ""}`}>
      {count > 99 ? "99+" : count > 0 ? count : null}
    </span>
  );
}

function WindowDots({ count, mode }: { count: number; mode: DockIndicatorMode | string }) {
  const safeMode = sanitizeDockIndicator(mode);
  if (safeMode === "none") return null;
  if (safeMode === "dots") {
    return (
      <div className="window-dots dots">
        {Array.from({ length: Math.min(Math.max(count, 1), 4) }, (_, i) => (
          <div key={i} className="window-dot" />
        ))}
      </div>
    );
  }
  if (safeMode === "pill" || safeMode === "glow") {
    return (
      <div className={`window-dots ${safeMode}${count > 1 ? " multi" : ""}`}>
        <div className="active-indicator" />
      </div>
    );
  }
  return (
    <div className={`window-dots ${safeMode}${safeMode === "bar" && count > 1 ? " multi" : ""}`}>
      <div className="active-indicator" />
    </div>
  );
}

let liveThumbnailGeneration = 0;

const MAX_PREVIEW_WINDOWS = 4;
const PREVIEW_MAX_WIDTH = 260;
const PREVIEW_MAX_HEIGHT = 170;
const PREVIEW_DEFAULT_RATIO = 16 / 10;

function imageRatio(src: string): Promise<number> {
  if (!src) return Promise.resolve(PREVIEW_DEFAULT_RATIO);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : PREVIEW_DEFAULT_RATIO;
      resolve(Math.min(2.6, Math.max(0.5, ratio)));
    };
    img.onerror = () => resolve(PREVIEW_DEFAULT_RATIO);
    img.src = src;
  });
}

function previewBox(ratio: number, cardCount = 1, zoom = 1) {
  let maxSurfaceW = PREVIEW_MAX_WIDTH;
  if (cardCount > 1 && typeof window !== "undefined") {
    const availUnzoomed = (window.innerWidth * 0.82) / Math.max(0.75, zoom) - 20;
    const perCardMax = Math.floor((availUnzoomed - (cardCount - 1) * 6) / cardCount) - 16;
    if (perCardMax > 96) {
      maxSurfaceW = Math.min(PREVIEW_MAX_WIDTH, perCardMax);
    }
  }
  const width = Math.round(Math.min(maxSurfaceW, PREVIEW_MAX_HEIGHT * ratio));
  return { width, height: Math.round(width / ratio) };
}

interface DockPreviewTooltipProps {
  app: AppInfo;
  previews: { hwnd: number; title: string; image: string; ratio: number }[];
  extraCount: number;
  onClosePreview: (e: React.MouseEvent, hwnd: number) => void;
  onPinError: (message: string) => void;
  renderMedia: (app: AppInfo) => React.ReactNode;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  zoom: number;
}

function DockPreviewTooltip({
  app,
  previews,
  extraCount,
  onClosePreview,
  onPinError,
  renderMedia,
  onMouseEnter,
  onMouseLeave,
  zoom,
}: DockPreviewTooltipProps) {
  const t = useT();
  const tr = (key: string, fallback: string, params?: Record<string, string | number>) =>
    translateWithFallback(t, key, fallback, params);
  const rootRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const isPresent = useIsPresent();
  const [pinnedMap, setPinnedMap] = useState<Record<number, boolean>>({});
  const pendingPinRef = useRef<Set<number>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const previewHwndSig = useMemo(() => previews.map((p) => p.hwnd).join(","), [previews]);

  useEffect(() => {
    let cancelled = false;
    const hwnds = previews.map((p) => p.hwnd);
    if (hwnds.length === 0) {
      setPinnedMap({});
      return;
    }
    Promise.all(
      hwnds.map(async (hwnd) => {
        try {
          const topmost = await bridgeInvoke<boolean>("get_window_topmost", { hwnd });
          return [hwnd, Boolean(topmost)] as const;
        } catch {
          return [hwnd, false] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<number, boolean> = {};
      for (const [hwnd, topmost] of entries) {
        next[hwnd] = topmost;
      }
      setPinnedMap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [previewHwndSig]);

  const handleTogglePin = async (e: React.MouseEvent, hwnd: number) => {
    e.stopPropagation();
    if (pendingPinRef.current.has(hwnd)) return;
    pendingPinRef.current.add(hwnd);
    try {
      const nextPinned = await bridgeInvoke<boolean>("toggle_window_topmost", { hwnd });
      if (mountedRef.current) {
        setPinnedMap((prev) => ({ ...prev, [hwnd]: Boolean(nextPinned) }));
      }
    } catch (err) {
      const errText = typeof err === "string" ? err : String(err ?? "");
      if (errText.includes("elevated_window") || errText.includes("shell_window") || errText.includes("invalid_window")) {
        onPinError(tr("dock.preview.pinElevatedError", "Cannot pin an administrator window"));
      } else {
        onPinError(tr("dock.preview.pinElevatedError", "Cannot pin an administrator window"));
      }
    } finally {
      pendingPinRef.current.delete(hwnd);
    }
  };

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let delta = 0;
    if (rect.left < margin) delta = margin - rect.left;
    else if (rect.right > window.innerWidth - margin) delta = window.innerWidth - margin - rect.right;
    if (Math.abs(delta) > 0.5) setShift((s) => s + delta / (zoom || 1));
  }, [previews, extraCount, zoom]);
  const [liveHwnds, setLiveHwnds] = useState<Set<number>>(() => new Set());
  const surfaceRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useLayoutEffect(() => {
    const generation = ++liveThumbnailGeneration;
    let cancelled = false;
    let rafId: number | null = null;
    let t1: ReturnType<typeof setTimeout> | null = null;
    let t2: ReturnType<typeof setTimeout> | null = null;

    const syncThumbnails = async () => {
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const targets: { hwnd: number; x: number; y: number; width: number; height: number }[] = [];

      for (const p of previews) {
        const el = surfaceRefs.current.get(p.hwnd);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            targets.push({
              hwnd: p.hwnd,
              x: Math.round(r.left * dpr),
              y: Math.round(r.top * dpr),
              width: Math.round(r.width * dpr),
              height: Math.round(r.height * dpr),
            });
          }
        }
      }

      if (targets.length > 0) {
        try {
          const active = await invoke<number[]>('set_live_thumbnails', { targets, clientAreaOnly: false });
          if (!cancelled && active) {
            setLiveHwnds(new Set(active));
          }
        } catch {}
      }
    };

    rafId = requestAnimationFrame(() => {
      syncThumbnails();
      t1 = setTimeout(syncThumbnails, 75);
      t2 = setTimeout(syncThumbnails, 160);
    });

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (t1) clearTimeout(t1);
      if (t2) clearTimeout(t2);
      if (generation === liveThumbnailGeneration) invoke('clear_live_thumbnails').catch(() => {});
    };
  }, [previews]);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    const ramp = (from: number, to: number, done?: () => void) => {
      const start = performance.now();
      const step = (now: number) => {
        if (cancelled) return;
        const p = Math.min(1, (now - start) / 150);
        invoke('set_live_thumbnails_opacity', { opacity: Math.round(from + (to - from) * p) }).catch(() => {});
        if (p < 1) raf = requestAnimationFrame(step);
        else done?.();
      };
      raf = requestAnimationFrame(step);
    };
    if (isPresent) {
      ramp(0, 255);
      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
      };
    }
    ramp(255, 0, () => {
      if (!cancelled && mountedRef.current) setLiveHwnds(new Set());
      invoke('clear_live_thumbnails').then(() => invoke('set_live_thumbnails_opacity', { opacity: 255 })).catch(() => {});
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [isPresent]);

  return (
    <motion.div
      ref={rootRef}
      style={{ ['--pv-shift' as string]: `${shift}px` }}
      className={`preview-tooltip ${previews.length > 1 || extraCount > 0 ? 'multi' : ''}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="preview-items">
        <AnimatePresence initial={false}>
        {previews.map((prev, idx) => {
          const isLive = liveHwnds.has(prev.hwnd);
          const box = previewBox(prev.ratio, previews.length, zoom);
          const resolvedTitle = prev.title || app.name;
          const isTopmost = Boolean(pinnedMap[prev.hwnd]);
          const pinLabel = isTopmost
            ? tr("dock.preview.unpinWindow", "Unpin window from top")
            : tr("dock.preview.pinWindow", "Pin window on top");
          return (
            <motion.div
              key={prev.hwnd}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="preview-item"
              style={{ width: Math.max(120, box.width + 16) }}
              onClick={() => invoke('focus_window', { hwnd: prev.hwnd })}
            >
              <div
                className={`preview-surface ${isLive ? "has-live" : ""}`}
                style={{ width: box.width, height: box.height, aspectRatio: "auto", alignSelf: "center" }}
                ref={(el) => {
                  if (el) surfaceRefs.current.set(prev.hwnd, el);
                  else surfaceRefs.current.delete(prev.hwnd);
                }}
              >
                <div className="preview-live-mount" />
                {prev.image ? (
                  <img
                    src={prev.image}
                    alt={`Preview ${idx}`}
                    className={`preview-thumb-img ${isLive ? 'is-live' : ''}`}
                  />
                ) : (
                  !isLive && (
                    <div className="preview-fallback">
                      {app.icon ? (
                        <img src={app.icon} alt="" />
                      ) : (
                        <svg
                          className="preview-fallback-glyph"
                          width="48"
                          height="48"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="3" y="5" width="18" height="14" rx="2" />
                          <line x1="3" y1="9" x2="21" y2="9" />
                        </svg>
                      )}
                    </div>
                  )
                )}
              </div>
              <div className="preview-label">
                {app.icon && <img src={app.icon} alt="" className="preview-app-icon" />}
                <span className="preview-title" title={resolvedTitle}>{resolvedTitle}</span>
                <div className="preview-label-actions">
                  <button
                    type="button"
                    className={`preview-pin-btn${isTopmost ? " is-pinned" : ""}`}
                    onClick={(e) => handleTogglePin(e, prev.hwnd)}
                    aria-label={pinLabel}
                    aria-pressed={isTopmost}
                    title={pinLabel}
                  >
                    {isTopmost ? (
                      <>
                        <Pin size={11} className="pin-active-icon" />
                        <PinOff size={11} className="pin-hover-off-icon" />
                      </>
                    ) : (
                      <Pin size={11} />
                    )}
                  </button>
                  <button
                    type="button"
                    className="preview-close-btn"
                    onClick={(e) => onClosePreview(e, prev.hwnd)}
                    aria-label={t("dockmenu.closeWindow")}
                    title={t("dockmenu.closeWindow")}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>
              </div>
            </motion.div>
          );
        })}
        </AnimatePresence>
      </div>
      {extraCount > 0 && (
        <div className="preview-more-row">
          <span className="preview-more-badge">
            {tr("dock.preview.moreWindows", "+{count} more", { count: extraCount })}
          </span>
        </div>
      )}
      {renderMedia(app)}
    </motion.div>
  );
}

const tourDockAction = () => { emit('tour-dock-action').catch(() => {}); };

const Dock = memo(function Dock() {
  const t = useT();
  const tr = (key: string, fallback: string, params?: Record<string, string | number>) =>
    translateWithFallback(t, key, fallback, params);
  const { scaleSpring, scaledRadius, motionSpeed } = useSurfaceMetrics();
  const { shouldPausePolls, shouldSuppressToasts } = useGameMode();
  const shouldPausePollsRef = useRef(shouldPausePolls);
  shouldPausePollsRef.current = shouldPausePolls;
  const shouldSuppressToastsRef = useRef(shouldSuppressToasts);
  shouldSuppressToastsRef.current = shouldSuppressToasts;
  const motionSpeedRef = useRef(motionSpeed);
  motionSpeedRef.current = motionSpeed;
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    return initTheme({ backdrop: true });
  }, []);

  const [pinnedApps, setPinnedApps] = useState<AppInfo[]>([]);
  const [activeApps, setActiveApps] = useState<AppInfo[]>([]);
  const iconsRef = useRef<Record<string, string>>({});
  const iconInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const iconNegativeCacheRef = useRef<Set<string>>(new Set());
  const pendingRetryKeysRef = useRef<Set<string>>(new Set());
  const iconRetryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const iconCacheEpochRef = useRef(0);
  const [, setIconsTick] = useState(0); 
  const [dockMode, setDockMode] = useState(() => {
    const raw = localStorage.getItem("nectar-dock-mode") || "smart";
    if (raw === "auto-hide") return "smart";
    return raw;
  });
  const [dockPreviewEnabled, setDockPreviewEnabled] = useState(() => localStorage.getItem("nectar-dock-preview-enabled") !== "false");
  const [previewDelay, setPreviewDelay] = useState(() => { const v = localStorage.getItem("nectar-dock-preview-delay"); return v === null ? 300 : Number(v) || 0; });
  const [hideDelay, setHideDelay] = useState(() => Number(localStorage.getItem("nectar-dock-hide-delay")) || 800);
  const [dockAttentionEnabled, setDockAttentionEnabled] = useState(() => localStorage.getItem("nectar-dock-attention-enabled") !== "false");
  const [attentionWindows, setAttentionWindows] = useState<Set<number>>(() => new Set());
  const [dockSearchEnabled, setDockSearchEnabled] = useState(() => localStorage.getItem("nectar-dock-search-enabled") !== "false");
  const [dockCalendarEnabled, setDockCalendarEnabled] = useState(() => localStorage.getItem("nectar-dock-calendar-enabled") !== "false");
  const [legacyMode, setLegacyMode] = useState(() => localStorage.getItem("nectar-legacy-mode") === "true");
  const [dockTray, setDockTray] = useState(() => localStorage.getItem("nectar-dock-tray-enabled") !== "false");
  const [trayBarEnabled, setTrayBarEnabled] = useState(() => localStorage.getItem("nectar-tray-bar-enabled") !== "false");
  const [pinnedTrayKeys, setPinnedTrayKeys] = useState<string[]>(() =>
    parsePinnedTrayKeys(localStorage.getItem("nectar-tray-pinned-keys"))
  );
  const [trayOrder, setTrayOrder] = useState<string[]>(() =>
    parseStringList(localStorage.getItem("nectar-tray-order"))
  );
  const [trayLabels, setTrayLabels] = useState<Record<string, string>>(() =>
    parseStringMap(localStorage.getItem("nectar-tray-labels"))
  );
  const [trayIcons, setTrayIcons] = useState<TrayIconDto[]>([]);
  const [dockTaskView, setDockTaskView] = useState(() => localStorage.getItem("nectar-dock-taskview-enabled") === "true");
  const [dockShowDesktop, setDockShowDesktop] = useState(() => localStorage.getItem("nectar-dock-show-desktop-corner") === "true");
  const [dockRecycle, setDockRecycle] = useState(() => localStorage.getItem("nectar-dock-recycle-enabled") === "true");
  const [dockDrives, setDockDrives] = useState<string[]>(() => parseDrives(localStorage.getItem("nectar-dock-drives")));
  const [hiddenApps, setHiddenApps] = useState<HiddenApp[]>(() => parseHiddenApps(localStorage.getItem("nectar-dock-hidden-apps")));
  const [menuItems, setMenuItems] = useState<string[]>(() => parseMenuItems(localStorage.getItem("nectar-dock-menu-items")));
  const [dockIconOnly, setDockIconOnly] = useState(() => localStorage.getItem("nectar-dock-icon-only") === "true");
  const [windowIndicator, setWindowIndicator] = useState<DockIndicatorMode>(() =>
    sanitizeDockIndicator(localStorage.getItem("nectar-dock-indicator"))
  );
  const [waveEnabled, setWaveEnabled] = useState(() => localStorage.getItem("nectar-dock-wave-enabled") !== "false");
  const [launchBounce, setLaunchBounce] = useState(() => localStorage.getItem("nectar-dock-launch-bounce") !== "false");
  const launchBounceRef = useRef(launchBounce);
  launchBounceRef.current = launchBounce;
  const [classicDockAnimations, setClassicDockAnimations] = useState(() => localStorage.getItem("nectar-dock-classic-animations") === "true");
  const classicDockAnimationsRef = useRef(classicDockAnimations);
  classicDockAnimationsRef.current = classicDockAnimations;
  const [excludedTintApps, setExcludedTintApps] = useState<Set<string>>(() =>
    new Set(parseExcludedTintApps(localStorage.getItem("nectar-icon-tint-excluded")))
  );
  const [dockIconSize, setDockIconSize] = useState(() => {
    const n = Number(localStorage.getItem("nectar-dock-icon-size"));
    return Number.isFinite(n) && n >= 28 && n <= 48 ? n : 36;
  });
  const [dockIconGap, setDockIconGap] = useState(() => {
    const n = Number(localStorage.getItem("nectar-dock-icon-gap"));
    return Number.isFinite(n) && n >= 6 && n <= 18 ? n : 12;
  });
  const [dockHoverScale, setDockHoverScale] = useState(() => {
    const n = Number(localStorage.getItem("nectar-dock-hover-scale"));
    return Number.isFinite(n) && n >= 1 && n <= 1.35 ? n : 1.1;
  });
  const [dockAdaptive, setDockAdaptive] = useState(() => localStorage.getItem("nectar-dock-adaptive") === "true");
  const [startIcon, setStartIcon] = useState(() => localStorage.getItem("nectar-start-icon") || "default");
  const [isMaximized, setIsMaximized] = useState(false);
  const [dockMixedReorder, setDockMixedReorder] = useState(() => localStorage.getItem("nectar-dock-mixed-reorder") === "true");
  const [mixedOrder, setMixedOrder] = useState<string[]>([]);
  const [previewData, setPreviewData] = useState<{
    id: string;
    previews: { hwnd: number; title: string; image: string; ratio: number }[];
    extraCount: number;
  } | null>(null);
  const previewDataRef = useRef(previewData);
  previewDataRef.current = previewData;
  const [isDockHovered, setIsDockHovered] = useState(false);
  const isDockHoveredRef = useRef(isDockHovered);
  isDockHoveredRef.current = isDockHovered;
  const [isEdgeHovered, setIsEdgeHovered] = useState(false);
  const [isOverlapped, setIsOverlapped] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isShellSurfaceFocused, setIsShellSurfaceFocused] = useState(false);
  const [showAddPopup, setShowAddPopup] = useState(false);
  const [renameApp, setRenameApp] = useState<AppInfo | null>(null);
  const [dockNames, setDockNames] = useState<Record<string, string>>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem("nectar-dock-names") ?? "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  });
  const popupOpen = showAddPopup || !!renameApp;
  const displayName = (app: AppInfo) => dockNames[itemKey(app)] || app.name;
  const saveName = (app: AppInfo, name: string) => {
    const key = itemKey(app);
    const next = { ...dockNames };
    const trimmed = name.trim();
    if (trimmed && trimmed !== app.name) next[key] = trimmed;
    else delete next[key];
    setDockNames(next);
    const value = JSON.stringify(next);
    localStorage.setItem("nectar-dock-names", value);
    invoke("save_setting", { key: "nectar-dock-names", value }).catch(console.error);
    setRenameApp(null);
    invoke('set_menu_open', { open: false, rect: null }).catch(() => {});
  };
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, app: AppInfo | null, shortcut?: DockShortcutMenu } | null>(null);
  const [contextMenuHeight, setContextMenuHeight] = useState(0);
  const [contextMenuWidth, setContextMenuWidth] = useState(0);
  const [activeSubmenu, setActiveSubmenu] = useState<DockSubmenuId | null>(null);
  const [contextWindowState, setContextWindowState] = useState<ContextWindowState | null>(null);
  const [explorerJumpList, setExplorerJumpList] = useState<ExplorerJumpListItem[]>([]);
  const [activeOrder, setActiveOrder] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [hoveredApp, setHoveredApp] = useState<string | null>(null);
  const [pressedApp, setPressedApp] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isImpacted, setIsImpacted] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [startupAnimating, setStartupAnimating] = useState(true);
  const [customIcons, setCustomIcons] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const iconPickerTargetRef = useRef<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [popupBottom, setPopupBottom] = useState(56);
  const [scale, setScale] = useState(() => parseFloat(localStorage.getItem("nectar-scale") || "1.0"));
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const dockIconSizeRef = useRef(dockIconSize);
  dockIconSizeRef.current = dockIconSize;
  const dockIconGapRef = useRef(dockIconGap);
  dockIconGapRef.current = dockIconGap;
  const dockHoverScaleRef = useRef(dockHoverScale);
  dockHoverScaleRef.current = dockHoverScale;
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const pinnedItemsRef = useRef<AppInfo[]>([]);
  const handleAppClickRef = useRef<(app: AppInfo) => void>(() => {});

  const showDockToast = (message: string, durationMs = 4000) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(message);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, durationMs);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      for (const timer of iconRetryTimersRef.current) {
        clearTimeout(timer);
      }
      iconRetryTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Measure the dock pill when the popup opens. The card tucks ~14px behind it,
  // so the seam stays fused even if the measurement is slightly off.
  useEffect(() => {
    if (popupOpen) {
      const h = dockRef.current?.getBoundingClientRect().height ?? 0;
      if (h > 0) setPopupBottom(h / (scale || 1) - 14);
    }
  }, [popupOpen, scale]);

  const isCurrentlyHovered = isDockHovered || isEdgeHovered;
  const [interactionState, setInteractionState] = useState<'active' | 'grace' | 'none'>('none');
  const isAnyInteraction = isCurrentlyHovered || !!contextMenu || popupOpen;
  
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trayClickTimersRef = useRef<Record<string, number>>({});
  const isPreviewHoveredRef = useRef(false);
  const [mediaSessions, setMediaSessions] = useState<AppMediaSession[]>([]);
  const hoveredAppRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      Object.values(trayClickTimersRef.current).forEach((id) => window.clearTimeout(id));
      trayClickTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (isAnyInteraction) {
      setInteractionState('active');
    } else if (interactionState !== 'none') {
      setInteractionState('grace');
      const timer = setTimeout(() => setInteractionState('none'), hideDelay);
      return () => clearTimeout(timer);
    }
  }, [isAnyInteraction, hideDelay]);

  const isHidden = isFullscreen || isShellSurfaceFocused ||
    (!startupAnimating && (
      (dockMode === 'smart' && isOverlapped && interactionState === 'none') ||
      (dockMode === 'peek' && interactionState === 'none')
    ));

  const [isDockRevealing, setIsDockRevealing] = useState(false);
  const isDockRevealingRef = useRef(false);
  const prevHiddenRef = useRef(isHidden);
  const justStartedReveal = prevHiddenRef.current && !isHidden && isExpanded;
  isDockRevealingRef.current = isDockRevealing || justStartedReveal;

  useLayoutEffect(() => {
    const wasHidden = prevHiddenRef.current;
    prevHiddenRef.current = isHidden;
    if (isHidden) {
      isDockRevealingRef.current = false;
      setIsDockRevealing(false);
      return;
    }
    if (wasHidden && isExpanded) {
      isDockRevealingRef.current = true;
      setIsDockRevealing(true);
      const fallbackMs = motionSpeed <= 0 ? 30 : Math.min(500, Math.round(380 / Math.max(0.5, motionSpeed)));
      const timer = setTimeout(() => {
        isDockRevealingRef.current = false;
        setIsDockRevealing(false);
      }, fallbackMs);
      return () => clearTimeout(timer);
    }
  }, [isHidden, isExpanded, motionSpeed]);

  const isWaveActive =
    !classicDockAnimations &&
    !isDockRevealing &&
    !justStartedReveal &&
    waveEnabled &&
    dockHoverScale > 1.01 &&
    motionSpeed > 0 &&
    !isDragging &&
    !isHidden;
  const isWaveActiveRef = useRef(isWaveActive);
  isWaveActiveRef.current = isWaveActive;
  const waveRafRef = useRef<number | null>(null);
  const wavePointerXRef = useRef<number | null>(null);

  const resetWave = () => {
    if (waveRafRef.current !== null) {
      cancelAnimationFrame(waveRafRef.current);
      waveRafRef.current = null;
    }
    wavePointerXRef.current = null;
    const dockEl = dockRef.current;
    if (!dockEl) return;
    dockEl.classList.remove('wave-tracking');
    const nodes = dockEl.querySelectorAll<HTMLElement>('.dock-wave-item');
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.dataset.waveSig) {
        delete node.dataset.waveSig;
        node.style.removeProperty('--dock-wave-scale');
        node.style.removeProperty('--dock-wave-lift');
      }
    }
  };

  const applyWaveFrame = () => {
    waveRafRef.current = null;
    const dockEl = dockRef.current;
    const pointerX = wavePointerXRef.current;
    if (!dockEl || pointerX === null || !isWaveActiveRef.current) {
      resetWave();
      return;
    }
    const nodes = dockEl.querySelectorAll<HTMLElement>('.dock-wave-item');
    if (nodes.length === 0) return;

    const currentScale = scaleRef.current || 1;
    const maxScale = dockHoverScaleRef.current;
    const radius = Math.max(84, (dockIconSizeRef.current + dockIconGapRef.current) * 2.2) * currentScale;
    const peakLift = 5 * Math.min(1, (maxScale - 1) / 0.1);

    // Read phase first to avoid layout thrashing
    const centers: number[] = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const rect = nodes[i].getBoundingClientRect();
      centers[i] = rect.left + rect.width * 0.5;
    }

    // Write phase directly via CSS custom properties (zero React re-renders)
    for (let i = 0; i < nodes.length; i++) {
      const dist = Math.abs(pointerX - centers[i]);
      let itemScale = 1;
      let itemLift = 0;
      if (dist < radius) {
        const tNorm = 1 - dist / radius;
        const factor = 0.5 - 0.5 * Math.cos(Math.PI * tNorm);
        itemScale = 1 + (maxScale - 1) * factor;
        itemLift = peakLift * factor;
      }
      const sig = itemScale <= 1.0005 ? '' : `${itemScale.toFixed(4)}:${itemLift.toFixed(2)}`;
      const node = nodes[i];
      if ((node.dataset.waveSig || '') !== sig) {
        if (!sig) {
          delete node.dataset.waveSig;
          node.style.removeProperty('--dock-wave-scale');
          node.style.removeProperty('--dock-wave-lift');
        } else {
          node.dataset.waveSig = sig;
          node.style.setProperty('--dock-wave-scale', itemScale.toFixed(4));
          node.style.setProperty('--dock-wave-lift', itemLift.toFixed(2));
        }
      }
    }
  };

  const handleDockMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isWaveActiveRef.current) return;
    if ((e.target as HTMLElement | null)?.closest('.preview-tooltip')) {
      resetWave();
      return;
    }
    wavePointerXRef.current = e.clientX;
    dockRef.current?.classList.add('wave-tracking');
    if (waveRafRef.current === null) {
      waveRafRef.current = requestAnimationFrame(applyWaveFrame);
    }
  };

  useEffect(() => {
    if (!isWaveActive) {
      resetWave();
    }
  }, [isWaveActive]);

  useEffect(() => {
    return () => {
      if (waveRafRef.current !== null) {
        cancelAnimationFrame(waveRafRef.current);
        waveRafRef.current = null;
      }
    };
  }, []);

  const triggerLaunchBounce = (containerEl: Element | null) => {
    if (classicDockAnimationsRef.current || !launchBounceRef.current || motionSpeedRef.current <= 0) return;
    if (typeof document !== 'undefined' && document.documentElement.classList.contains('reduced-motion')) {
      return;
    }
    const slot = containerEl?.classList.contains('dock-launch-slot')
      ? (containerEl as HTMLElement)
      : (containerEl?.querySelector('.dock-launch-slot') as HTMLElement | null);
    if (!slot) return;
    slot.classList.remove('is-launching');
    void slot.offsetWidth;
    slot.classList.add('is-launching');
  };

  // Adaptive mode (fixed dock): stretch to a full-width taskbar while a window is maximized.
  const isAdaptive = dockAdaptive && dockMode === 'fixed' && isMaximized && isExpanded && !isHidden;
  // Nearly full width, 24px margin per side. Width is pre-scale, so (viewport - 48*scale) / scale.
  const adaptiveWidth = (viewportWidth - 48 * scale) / scale;

  useEffect(() => {
    invoke('set_dock_hidden', { hidden: !isReady || isHidden }).catch(() => {});
  }, [isReady, isHidden]);

  useEffect(() => {
    if (!isHidden) return;
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    resetWave();
    isPreviewHoveredRef.current = false;
    hoveredAppRef.current = null;
    setPreviewData(null);
    setHoveredApp(null);
    setPressedApp(null);
    setIsDockHovered(false);
    setContextMenu(null);
    setActiveSubmenu(null);
    setShowAddPopup(false);
    setRenameApp(null);
    invoke('set_menu_open', { open: false, rect: null }).catch(() => {});
    invoke('clear_live_thumbnails').catch(() => {});
  }, [isHidden]);

  useEffect(() => {
    let cleared = false;

    const checkVisibility = async (): Promise<boolean> => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const visible = await getCurrentWebviewWindow().isVisible();
        if (visible && !cleared) {
          setStartupAnimating(true);
          setIsReady(true);
          setTimeout(() => !unmountedRef.current && setIsImpacted(true), 280);
          setTimeout(() => !unmountedRef.current && setIsExpanded(true), 350);
          setTimeout(() => !unmountedRef.current && setStartupAnimating(false), 1500);
          return true;
        }
      } catch (_) {}
      return false;
    };

    // Keep polling until visible — no time cap, since the dock can be
    let attempts = 0;
    const interval = setInterval(async () => {
      if (cleared) return;
      attempts++;
      if (attempts > 25 && attempts % 5 !== 0) return;
      if (await checkVisibility()) {
        clearInterval(interval);
        cleared = true;
      }
    }, 200);

    // Also attempt immediately
    checkVisibility().then(ok => { if (ok) { clearInterval(interval); cleared = true; } });

    return () => { clearInterval(interval); cleared = true; };
  }, []);

  const lastPillSentRef = useRef("");
  const lastRectSentRef = useRef("");
  const lastVisiblePillRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const updateDockRectRef = useRef<() => void>(() => {});

  useEffect(() => {
    const updateRect = () => {
      if (!dockRef.current) return;
      const rect = dockRef.current.getBoundingClientRect();

      // C4: Freeze the resting visible pill rect while hidden/collapsed or mid-reveal so overlap detection
      // never oscillates on the off-screen slide animation frame.
      const settledAtBottom = Math.abs(rect.bottom - window.innerHeight) <= 6;
      const isRestingVisible =
        !isHidden &&
        !isDockRevealingRef.current &&
        isReady &&
        isExpanded &&
        settledAtBottom &&
        rect.width >= 60 * scale &&
        rect.height >= 20;
      if (isRestingVisible) {
        const rawPill = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        lastVisiblePillRef.current = rawPill;
        const pillKey = `${rawPill.x},${rawPill.y},${rawPill.width},${rawPill.height}`;
        if (pillKey !== lastPillSentRef.current) {
          lastPillSentRef.current = pillKey;
          invoke('update_dock_pill_rect', { rect: rawPill }).catch(() => { lastPillSentRef.current = ""; });
        }
      }

      // C6: Use exact DOM union of .dock and .preview-tooltip instead of hardcoded +/-500x320 shield.
      const tooltipEl = !isHidden && previewData ? document.querySelector('.preview-tooltip') : null;
      const tipRect = tooltipEl ? tooltipEl.getBoundingClientRect() : null;
      const hasValidTip = !!tipRect && tipRect.width > 0 && tipRect.height > 0;
      const freezePillRect = (isHidden || isDockRevealingRef.current) && !!lastVisiblePillRef.current;
      const pill = freezePillRect ? lastVisiblePillRef.current! : null;
      const baseLeft = pill ? pill.x : rect.left;
      const baseRight = pill ? pill.x + pill.width : rect.right;
      const waveHeadroom =
        isWaveActiveRef.current && isDockHoveredRef.current && !isHidden && !isDockRevealingRef.current
          ? Math.ceil(((dockHoverScaleRef.current - 1) * dockIconSizeRef.current + 8) * scale)
          : 0;
      const dockTop = (pill ? pill.y : rect.top) - waveHeadroom;
      const dockBottom = pill ? pill.y + pill.height : rect.bottom;
      const left = hasValidTip ? Math.min(baseLeft, tipRect.left) : baseLeft;
      const top = hasValidTip ? Math.min(dockTop, tipRect.top) : dockTop;
      const right = hasValidTip ? Math.max(baseRight, tipRect.right) : baseRight;
      const bottom = hasValidTip ? Math.max(dockBottom, tipRect.bottom) : dockBottom;
      const next = {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(right - left),
        height: Math.round(bottom - top),
      };
      const key = `${next.x},${next.y},${next.width},${next.height}`;
      if (key === lastRectSentRef.current) return;
      lastRectSentRef.current = key;
      invoke('update_dock_rect', { rect: next }).catch(() => { lastRectSentRef.current = ""; });
    };
    updateDockRectRef.current = updateRect;

    updateRect();
    let rafId = 0;
    let tipTimer: ReturnType<typeof setTimeout> | undefined;
    if (previewData) {
      rafId = requestAnimationFrame(updateRect);
      tipTimer = setTimeout(updateRect, 60);
    }

    window.addEventListener('resize', updateRect);
    const observer = new ResizeObserver(updateRect);
    if (dockRef.current) observer.observe(dockRef.current);
    const tooltipEl = previewData ? document.querySelector('.preview-tooltip') : null;
    if (tooltipEl) observer.observe(tooltipEl);

    const poll = setVisibleInterval(() => {
      if (!shouldPausePollsRef.current) updateRect();
    }, 500);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (tipTimer) clearTimeout(tipTimer);
      window.removeEventListener('resize', updateRect);
      observer.disconnect();
      clearInterval(poll);
    };
  }, [isReady, isExpanded, isHidden, isDockRevealing, isDockHovered, isWaveActive, dockHoverScale, previewData, scale, dockIconSize, dockIconGap]);

  const refreshDockMode = () => {
    invoke<string>('get_dock_mode_for_window').then(setDockMode).catch(() => {});
  };

  const trayBarEnabledRef = useRef(trayBarEnabled);
  trayBarEnabledRef.current = trayBarEnabled;
  const isDraggingRef = useRef(isDragging);
  isDraggingRef.current = isDragging;
  const pendingPollDuringDragRef = useRef(false);
  const pollWindowsRef = useRef<() => Promise<void>>(async () => {});
  const loadDockTrayIconsRef = useRef<() => void>(() => {});
  const closeMenuRef = useRef<() => void>(() => {});
  const closePopupRef = useRef<() => void>(() => {});

  const resetWaveLaunchIndicatorExclusions = () => {
    setWindowIndicator("dots");
    setWaveEnabled(true);
    setLaunchBounce(true);
    setClassicDockAnimations(false);
    setExcludedTintApps(new Set());
  };

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const registerListen = (promise: Promise<() => void>) => {
      promise
        .then((fn) => {
          if (cancelled) fn();
          else unlisteners.push(fn);
        })
        .catch(() => {});
    };

    const init = async () => {
      const settings = await hydrateSettingsFromBackend();
      if (cancelled) return;
      const getVal = (key: string, fallback: string | null = null) => {
        const val = settings[key];
        if (val !== undefined && val !== null) return String(val);
        const local = localStorage.getItem(key);
        if (local !== null) return local;
        return fallback;
      };

      refreshDockMode();

      setHideDelay(Number(getVal("nectar-dock-hide-delay", "800")) || 800);
      setPreviewDelay(Number(getVal("nectar-dock-preview-delay", "300")) || 0);

      setDockPreviewEnabled(getVal("nectar-dock-preview-enabled", "true") !== "false");
      setDockAttentionEnabled(getVal("nectar-dock-attention-enabled", "true") !== "false");
      setDockSearchEnabled(getVal("nectar-dock-search-enabled", "true") !== "false");
      setDockCalendarEnabled(getVal("nectar-dock-calendar-enabled", "true") !== "false");

      setLegacyMode(getVal("nectar-legacy-mode", "false") === "true");
      setDockTray(getVal("nectar-dock-tray-enabled", "true") !== "false");
      const trayBarOn = getVal("nectar-tray-bar-enabled", "true") !== "false";
      trayBarEnabledRef.current = trayBarOn;
      setTrayBarEnabled(trayBarOn);
      loadDockTrayIconsRef.current();
      setPinnedTrayKeys(parsePinnedTrayKeys(getVal("nectar-tray-pinned-keys", "[]")));
      setTrayOrder(parseStringList(getVal("nectar-tray-order", "[]")));
      setTrayLabels(parseStringMap(getVal("nectar-tray-labels", "{}")));
      setDockTaskView(getVal("nectar-dock-taskview-enabled", "false") === "true");
      setDockShowDesktop(getVal("nectar-dock-show-desktop-corner", "false") === "true");
      setDockRecycle(getVal("nectar-dock-recycle-enabled", "false") === "true");
      setDockDrives(parseDrives(getVal("nectar-dock-drives", "[]")));
      setHiddenApps(parseHiddenApps(getVal("nectar-dock-hidden-apps", "[]")));
      setMenuItems(parseMenuItems(getVal("nectar-dock-menu-items")));

      const iconOnly = getVal("nectar-dock-icon-only", "false");
      setDockIconOnly(iconOnly === "true");
      setWindowIndicator(sanitizeDockIndicator(getVal("nectar-dock-indicator", "dots")));
      setWaveEnabled(getVal("nectar-dock-wave-enabled", "true") !== "false");
      setLaunchBounce(getVal("nectar-dock-launch-bounce", "true") !== "false");
      setClassicDockAnimations(getVal("nectar-dock-classic-animations", "false") === "true");
      setExcludedTintApps(new Set(parseExcludedTintApps(getVal("nectar-icon-tint-excluded", "[]"))));
      const rawIconSize = Number(getVal("nectar-dock-icon-size", "36"));
      setDockIconSize(Number.isFinite(rawIconSize) ? Math.min(48, Math.max(28, rawIconSize)) : 36);
      const rawIconGap = Number(getVal("nectar-dock-icon-gap", "12"));
      setDockIconGap(Number.isFinite(rawIconGap) ? Math.min(18, Math.max(6, rawIconGap)) : 12);
      const rawHoverScale = Number(getVal("nectar-dock-hover-scale", "1.1"));
      setDockHoverScale(Number.isFinite(rawHoverScale) ? Math.min(1.35, Math.max(1.0, rawHoverScale)) : 1.1);

      const adaptive = getVal("nectar-dock-adaptive", "false");
      setDockAdaptive(adaptive === "true");

      const startIconVal = getVal("nectar-start-icon", "default") || "default";
      setStartIcon(startIconVal);

      const mixedReorder = getVal("nectar-dock-mixed-reorder", "false");
      setDockMixedReorder(mixedReorder === "true");

      const namesRaw = getVal("nectar-dock-names", "{}");
      try {
        const parsedNames = JSON.parse(namesRaw || "{}");
        if (parsedNames && typeof parsedNames === "object" && !Array.isArray(parsedNames)) {
          setDockNames(parsedNames);
        }
      } catch {}

      const scaleVal = getVal("nectar-scale");
      if (scaleVal !== null) {
        const parsedScale = parseFloat(scaleVal);
        if (!Number.isNaN(parsedScale)) setScale(parsedScale);
      }

      const pinned = await invoke<AppInfo[]>('load_pinned_apps');
      if (cancelled) return;
      setPinnedApps(pinned.map(a => ({ ...a, is_pinned: true })));
      pinned.forEach(app => fetchIcon(app.path));

      // Load custom icons
      try {
        const icons = await invoke<Record<string, string>>('get_custom_icons');
        if (!cancelled) setCustomIcons(icons);
      } catch (_) {}
    };
    init();

    // Sent to one dock by label, a global listen() would get them for every dock.
    const thisWindow = getCurrentWebviewWindow();

    registerListen(thisWindow.listen<boolean>("dock-overlap", (event) => {
      if (!cancelled) setIsOverlapped(event.payload);
    }));

    registerListen(thisWindow.listen<boolean>("dock-edge-hover", (event) => {
      if (!cancelled) setIsEdgeHovered(event.payload);
    }));

    registerListen(thisWindow.listen<boolean>("dock-fullscreen", (event) => {
      if (cancelled) return;
      setIsFullscreen(event.payload);
      if (event.payload) {
        setIsEdgeHovered(false);
        setIsDockHovered(false);
      }
    }));

    registerListen(thisWindow.listen<boolean>("dock-shell-surface", (event) => {
      if (cancelled) return;
      setIsShellSurfaceFocused(event.payload);
      if (event.payload) {
        setIsEdgeHovered(false);
        setIsDockHovered(false);
      }
    }));

    registerListen(listen("shell-surface-opening", () => {
      if (cancelled) return;
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }
      isPreviewHoveredRef.current = false;
      setHoveredApp(null);
      setPressedApp(null);
      setPreviewData(null);
      closeMenuRef.current();
      closePopupRef.current();
    }));

    registerListen(listen("monitors-changed", () => {
      if (!cancelled) refreshDockMode();
    }));

    registerListen(thisWindow.listen<boolean>("dock-maximized", (event) => {
      if (!cancelled) setIsMaximized(event.payload);
    }));

    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
    };
  }, []);

  const asBool = (v: any, def: boolean) => (v === null || v === undefined ? def : v !== false && v !== "false");
  useSettingsSync(
    {
      "nectar-dock-mode": refreshDockMode,
      "nectar-dock-mode-by-monitor": refreshDockMode,
      "nectar-dock-monitor-mode": refreshDockMode,
      "nectar-dock-monitor-id": refreshDockMode,
      "nectar-dock-hide-delay": (v) => setHideDelay(v == null ? 800 : Number(v) || 800),
      "nectar-dock-preview-delay": (v) => setPreviewDelay(v == null ? 300 : Number(v) || 0),
      "nectar-dock-preview-enabled": (v) => setDockPreviewEnabled(asBool(v, true)),
      "nectar-dock-attention-enabled": (v) => setDockAttentionEnabled(asBool(v, true)),
      "nectar-dock-search-enabled": (v) => setDockSearchEnabled(asBool(v, true)),
      "nectar-dock-calendar-enabled": (v) => setDockCalendarEnabled(asBool(v, true)),
      "nectar-legacy-mode": (v) => setLegacyMode(v === true || v === "true"),
      "nectar-dock-tray-enabled": (v) => setDockTray(asBool(v, true)),
      "nectar-tray-bar-enabled": (v) => {
        const on = asBool(v, true);
        trayBarEnabledRef.current = on;
        setTrayBarEnabled(on);
        if (!on) {
          setTrayIcons([]);
        } else {
          invoke<TrayIconDto[]>("get_tray_icons")
            .then((res) => Array.isArray(res) && setTrayIcons(res))
            .catch((err) => console.error("Failed to load tray icons:", err));
        }
      },
      "nectar-tray-pinned-keys": (v) => setPinnedTrayKeys(parsePinnedTrayKeys(v)),
      "nectar-tray-order": (v) => setTrayOrder(parseStringList(v)),
      "nectar-tray-labels": (v) => setTrayLabels(parseStringMap(v)),
      "nectar-dock-taskview-enabled": (v) => setDockTaskView(v === true || v === "true"),
      "nectar-dock-show-desktop-corner": (v) => setDockShowDesktop(v === true || v === "true"),
      "nectar-dock-recycle-enabled": (v) => setDockRecycle(v === true || v === "true"),
      "nectar-dock-drives": (v) => setDockDrives(parseDrives(v == null ? null : typeof v === "string" ? v : JSON.stringify(v))),
      "nectar-dock-hidden-apps": (v) => setHiddenApps(parseHiddenApps(v)),
      "nectar-dock-menu-items": (v) => setMenuItems(parseMenuItems(v)),
      "nectar-dock-icon-only": (v) => setDockIconOnly(v === true || v === "true"),
      "nectar-dock-indicator": (v) => setWindowIndicator(sanitizeDockIndicator(v)),
      "nectar-dock-wave-enabled": (v) => setWaveEnabled(asBool(v, true)),
      "nectar-dock-launch-bounce": (v) => setLaunchBounce(asBool(v, true)),
      "nectar-dock-classic-animations": (v) => setClassicDockAnimations(v === true || v === "true"),
      "nectar-icon-tint-excluded": (v) => {
        const raw = v == null ? "[]" : typeof v === "string" ? v : JSON.stringify(v);
        setExcludedTintApps(new Set(parseExcludedTintApps(raw)));
      },
      "nectar-dock-icon-size": (v) => {
        const n = Number(v);
        setDockIconSize(Number.isFinite(n) ? Math.min(48, Math.max(28, n)) : 36);
      },
      "nectar-dock-icon-gap": (v) => {
        const n = Number(v);
        setDockIconGap(Number.isFinite(n) ? Math.min(18, Math.max(6, n)) : 12);
      },
      "nectar-dock-hover-scale": (v) => {
        const n = Number(v);
        setDockHoverScale(Number.isFinite(n) ? Math.min(1.35, Math.max(1.0, n)) : 1.1);
      },
      "nectar-dock-adaptive": (v) => setDockAdaptive(v === true || v === "true"),
      "nectar-start-icon": (v) => setStartIcon(v ? String(v) : "default"),
      "nectar-dock-mixed-reorder": (v) => setDockMixedReorder(v === true || v === "true"),
      "nectar-dock-names": (v) => {
        if (v === null || v === undefined) {
          setDockNames({});
          return;
        }
        try {
          const parsed = typeof v === "string" ? JSON.parse(v) : v;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) setDockNames(parsed);
        } catch {}
      },
      "nectar-scale": (v) => setScale(typeof v === "number" && !Number.isNaN(v) ? v : 1.0),
    },
    undefined,
    {
      onReset: () => {
        clearSettingsPreservingOnboarding();
        resetWaveLaunchIndicatorExclusions();
      },
    }
  );

  useEffect(() => {
    const syncLocalKey = (key?: string | null) => {
      if (!key || key === "nectar-icon-tint-excluded") {
        setExcludedTintApps(new Set(parseExcludedTintApps(localStorage.getItem("nectar-icon-tint-excluded"))));
      }
      if (!key || key === "nectar-dock-wave-enabled") {
        setWaveEnabled(localStorage.getItem("nectar-dock-wave-enabled") !== "false");
      }
      if (!key || key === "nectar-dock-launch-bounce") {
        setLaunchBounce(localStorage.getItem("nectar-dock-launch-bounce") !== "false");
      }
      if (!key || key === "nectar-dock-classic-animations") {
        setClassicDockAnimations(localStorage.getItem("nectar-dock-classic-animations") === "true");
      }
      if (!key || key === "nectar-dock-indicator") {
        setWindowIndicator(sanitizeDockIndicator(localStorage.getItem("nectar-dock-indicator")));
      }
    };
    const onLocal = (e: Event) => {
      const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (!keys) syncLocalKey(null);
      else keys.forEach((k) => syncLocalKey(k));
    };
    const onStorage = (e: StorageEvent) => syncLocalKey(e.key);
    window.addEventListener("nectar-local-setting", onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("nectar-local-setting", onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const prevPausedPollsRef = useRef(shouldPausePolls);
  useEffect(() => {
    const wasPaused = prevPausedPollsRef.current;
    prevPausedPollsRef.current = shouldPausePolls;
    if (wasPaused && !shouldPausePolls) {
      void pollWindowsRef.current();
    }
  }, [shouldPausePolls]);

  useEffect(() => {
    let cancelled = false;
    let pollSeq = 0;
    const unlisteners: Array<() => void> = [];

    const registerListen = (promise: Promise<() => void>) => {
      promise
        .then((fn) => {
          if (cancelled) fn();
          else unlisteners.push(fn);
        })
        .catch(() => {});
    };

    const poll = async () => {
      if (cancelled) return;
      if (isDraggingRef.current) {
        pendingPollDuringDragRef.current = true;
        return;
      }
      const seq = ++pollSeq;
      const running = await invoke<AppInfo[]>('get_active_windows');
      // Drop out-of-order responses, an old poll must not bring back closed apps.
      if (cancelled || seq !== pollSeq) return;
      setActiveApps(prev => {
        const same = prev.length === running.length && prev.every((p, i) => {
          const r = running[i];
          return p.path === r.path && p.name === r.name && p.hwnd === r.hwnd && p.is_running === r.is_running && windowTitles(p) === windowTitles(r);
        });
        return same ? prev : running;
      });

      setActiveOrder(prev => {
        const newPaths = running.map(r => appIdentity(r.path, r.executable, r.name));
        const existingPaths = prev.filter(p => newPaths.includes(p));
        const addedPaths = newPaths.filter(p => !prev.includes(p));
        return [...existingPaths, ...addedPaths];
      });

      running.forEach(app => fetchIcon(app.path, app.name, app.hwnd));
    };
    pollWindowsRef.current = poll;

    poll();

    registerListen(bridgeListen("windows-changed", () => {
      if (!cancelled) void poll();
    }));

    registerListen(bridgeListen("settings-reset", () => {
      if (cancelled) return;
      clearSettingsPreservingOnboarding();
      resetWaveLaunchIndicatorExclusions();
      window.location.reload();
    }));

    registerListen(bridgeListen("icon-cache-cleared", () => {
      if (cancelled) return;
      solidIconCache.clear();
      iconNegativeCacheRef.current.clear();
      pendingRetryKeysRef.current.clear();
      window.location.reload();
    }));

    // Safety net: even if a window event is missed, converge on the real state
    const interval = setVisibleInterval(() => {
      if (!shouldPausePollsRef.current) void poll();
    }, 10000);

    // Windows that flashed for attention; the backend drops them once they're activated or closed
    invoke<number[]>('get_attention_windows')
      .then(list => { if (!cancelled) setAttentionWindows(new Set(list)); })
      .catch(() => {});
    registerListen(bridgeListen<number[]>("app-attention", (payload) => {
      if (!cancelled) setAttentionWindows(new Set(payload));
    }));

    const loadDockTrayIcons = () => {
      if (cancelled) return;
      if (!trayBarEnabledRef.current) {
        setTrayIcons([]);
        return;
      }
      invoke<TrayIconDto[]>('get_tray_icons')
        .then((res) => {
          if (!cancelled && Array.isArray(res)) setTrayIcons(res);
        })
        .catch((err) => console.error("Failed to fetch dock tray icons:", err));
    };
    loadDockTrayIconsRef.current = loadDockTrayIcons;
    loadDockTrayIcons();
    registerListen(bridgeListen("tray-icons-updated", loadDockTrayIcons));
    registerListen(bridgeListen("custom-icons-updated", async () => {
      if (cancelled) return;
      try {
        const icons = await invoke<Record<string, string>>('get_custom_icons');
        if (!cancelled && icons) setCustomIcons(icons);
      } catch {}
    }));
    registerListen(bridgeListen("pinned-apps-updated", async () => {
      if (cancelled) return;
      try {
        const pinned = await invoke<AppInfo[]>('load_pinned_apps');
        if (cancelled) return;
        setPinnedApps(pinned.map(a => ({ ...a, is_pinned: true })));
        pinned.forEach(app => fetchIcon(app.path));
      } catch {}
    }));

    return () => {
      cancelled = true;
      clearInterval(interval);
      for (const fn of unlisteners) fn();
    };
  }, []);

  useEffect(() => {
    if (!isDragging && pendingPollDuringDragRef.current) {
      pendingPollDuringDragRef.current = false;
      void pollWindowsRef.current();
    }
  }, [isDragging]);

  const fetchIcon = (path: string, name?: string, hwnd?: number, retryCount = 0): Promise<void> => {
    if (!path) return Promise.resolve();
    const isHost = isBrowserHost(path);
    const cacheKey = isHost && name ? `${path}:${name.toLowerCase()}` : (hwnd ? `${path}-${hwnd}` : path);

    if (iconsRef.current[cacheKey]) return Promise.resolve();
    if (iconNegativeCacheRef.current.has(cacheKey)) return Promise.resolve();
    if (retryCount === 0 && pendingRetryKeysRef.current.has(cacheKey)) return Promise.resolve();
    const existingPromise = iconInFlightRef.current.get(cacheKey);
    if (existingPromise) return existingPromise;

    const epoch = iconCacheEpochRef.current;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const icon = await invoke<string | null>('get_app_icon', { path, name: name || null, hwnd: hwnd || null });
        if (unmountedRef.current || epoch !== iconCacheEpochRef.current) return;
        if (icon) {
          iconsRef.current[cacheKey] = icon;
          if (!isHost) iconsRef.current[path] = icon;
          iconNegativeCacheRef.current.delete(cacheKey);
          pendingRetryKeysRef.current.delete(cacheKey);
          setIconsTick(t => t + 1);
        } else if (retryCount < 3 && !hwnd) {
          pendingRetryKeysRef.current.add(cacheKey);
          const timer = setTimeout(() => {
            iconRetryTimersRef.current.delete(timer);
            pendingRetryKeysRef.current.delete(cacheKey);
            if (!unmountedRef.current && epoch === iconCacheEpochRef.current) {
              void fetchIcon(path, name, undefined, retryCount + 1);
            }
          }, 3000 * (retryCount + 1));
          iconRetryTimersRef.current.add(timer);
        } else {
          iconNegativeCacheRef.current.add(cacheKey);
        }
      } catch (e) {
        console.error(`Failed to fetch icon for ${path}:`, e);
        if (unmountedRef.current || epoch !== iconCacheEpochRef.current) return;
        if (retryCount < 3 && !hwnd) {
          pendingRetryKeysRef.current.add(cacheKey);
          const timer = setTimeout(() => {
            iconRetryTimersRef.current.delete(timer);
            pendingRetryKeysRef.current.delete(cacheKey);
            if (!unmountedRef.current && epoch === iconCacheEpochRef.current) {
              void fetchIcon(path, name, undefined, retryCount + 1);
            }
          }, 3000 * (retryCount + 1));
          iconRetryTimersRef.current.add(timer);
        } else {
          iconNegativeCacheRef.current.add(cacheKey);
        }
      } finally {
        if (iconInFlightRef.current.get(cacheKey) === promise) {
          iconInFlightRef.current.delete(cacheKey);
        }
      }
    })();

    iconInFlightRef.current.set(cacheKey, promise);
    return promise;
  };

  const handleClearIconCache = async () => {
    try {
      await invoke('clear_icon_cache');
      iconCacheEpochRef.current += 1;
      for (const timer of iconRetryTimersRef.current) {
        clearTimeout(timer);
      }
      iconRetryTimersRef.current.clear();
      pendingRetryKeysRef.current.clear();
      iconNegativeCacheRef.current.clear();
      iconInFlightRef.current.clear();
      solidIconCache.clear();
      iconsRef.current = {};
      setIconsTick(t => t + 1);
      pinnedApps.forEach(app => fetchIcon(app.path));
    } catch (e) {
      console.error("Failed to clear icon cache:", e);
    }
  };

  const handleIconFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = iconPickerTargetRef.current;
    if (!file || !target) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const dataUri = reader.result as string;
      try {
        const newIcon = await invoke<string>('set_custom_icon', {
          cacheKey: target,
          iconData: dataUri
        });
        setCustomIcons(prev => ({ ...prev, [target]: newIcon }));
      } catch (err) {
        if (!isGameModeSuppressToastsActive() && !shouldSuppressToastsRef.current) {
          const msg = typeof err === 'string' ? err : t('dockmenu.iconError');
          showDockToast(msg, 4000);
        }
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleRemoveCustomIcon = async (app: AppInfo) => {
    try {
      await invoke('remove_custom_icon', { path: app.path, name: app.name || null });
      const isHost = isBrowserHost(app.path);
      const ck = isHost && app.name ? `${app.path}:${app.name.toLowerCase()}` : (app.hwnd ? `${app.path}-${app.hwnd}` : app.path);
      setCustomIcons(prev => {
        const next = { ...prev };
        delete next[ck];
        delete next[app.path];
        return next;
      });
      // Invalidate only this app's cached icon and re-fetch only this app
      delete iconsRef.current[ck];
      delete iconsRef.current[app.path];
      if (app.hwnd) delete iconsRef.current[`${app.path}-${app.hwnd}`];
      iconNegativeCacheRef.current.delete(ck);
      iconNegativeCacheRef.current.delete(app.path);
      if (app.hwnd) iconNegativeCacheRef.current.delete(`${app.path}-${app.hwnd}`);
      setIconsTick(t => t + 1);
      fetchIcon(app.path, app.name, app.hwnd);
    } catch (err) {
      console.error("Failed to remove custom icon:", err);
    }
  };

  const handleClosePreview = async (e: React.MouseEvent, hwnd: number) => {
    e.stopPropagation();
    const current = previewDataRef.current;
    if (current) {
      const remaining = current.previews.filter(p => p.hwnd !== hwnd);
      if (remaining.length === 0) {
        isPreviewHoveredRef.current = false;
        hoveredAppRef.current = null;
        setPreviewData(null);
        setHoveredApp(null);
      } else {
        setPreviewData({ ...current, previews: remaining });
      }
    }
    try {
      await invoke('clear_live_thumbnails');
      await invoke('close_window', { hwnd });
    } catch (err) {
      console.error("Failed to close window:", err);
    }
  };

  const handleAppClick = async (app: AppInfo) => {
    try {
      if (app.path === 'start') {
        await invoke('open_app', { appName: 'start' });
      } else if (app.all_hwnds && app.all_hwnds.length > 1) {
        // Several windows: bring the most recent forward, then cycle.
        await invoke('focus_app_windows', { hwnds: app.all_hwnds.map(([hwnd]) => hwnd) });
      } else if (app.hwnd) {
        await invoke('focus_window', { hwnd: app.hwnd });
      } else {
        await invoke('open_app', { appName: app.path, args: app.args ?? null });
      }
    } catch (e) {
      console.error(`Failed to interact with ${app.name}:`, e);
    }
  };

  const handleNewInstance = async (app: AppInfo) => {
    if (!app || app.path === 'start') return;
    try {
      await bridgeInvoke('launch_new_instance', { appPath: app.path, appName: app.name, args: app.args ?? null });
    } catch (e) {
      console.error(`Failed to launch a new instance of ${app.name}:`, e);
    }
  };

  const handleRunAsAdmin = async (app: AppInfo) => {
    if (!supportsWinFileActions(app)) return;
    try {
      await bridgeInvoke('launch_app_as_admin', {
        appPath: app.path,
        appName: app.name,
        args: app.args ?? null,
        hwnd: app.hwnd ?? null,
      });
    } catch (err) {
      const msg = String(err ?? '');
      if (msg.includes('cancelled')) return;
      showDockToast(
        msg.includes('admin_unavailable')
          ? t('start.action.adminUnavailable')
          : t('dockmenu.adminFailed'),
        3500
      );
    }
  };

  const handleOpenLocation = async (app: AppInfo) => {
    if (!supportsWinFileActions(app)) return;
    try {
      await bridgeInvoke('open_app_location', {
        appPath: app.path,
        hwnd: app.hwnd ?? null,
      });
    } catch {
      showDockToast(t('dockmenu.locationUnavailable'), 3500);
    }
  };

  const handleOpenProperties = async (app: AppInfo) => {
    if (!supportsWinFileActions(app)) return;
    try {
      await bridgeInvoke('open_app_properties', {
        appPath: app.path,
        hwnd: app.hwnd ?? null,
      });
    } catch {
      showDockToast(t('dockmenu.propertiesUnavailable'), 3500);
    }
  };

  const handleCopyPath = async (app: AppInfo) => {
    if (!app.path || app.path === 'start') return;
    try {
      await bridgeInvoke('copy_text_to_clipboard', { text: app.path });
      showDockToast(t('start.action.copiedPath'), 2200);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  };

  const handleWindowAction = async (app: AppInfo, action: 'minimize' | 'maximize' | 'restore' | 'close_all') => {
    if (!app.hwnd) return;
    try {
      await bridgeInvoke('window_action', {
        hwnd: app.hwnd,
        allHwnds: app.all_hwnds?.map(([h]) => h) ?? null,
        action,
      });
    } catch (err) {
      console.error(`Failed window action ${action}:`, err);
    }
  };

  const handleToggleTopmost = async (app: AppInfo) => {
    if (!app.hwnd) return;
    try {
      await bridgeInvoke<boolean>('toggle_window_topmost', { hwnd: app.hwnd });
    } catch (err) {
      console.error('Failed to toggle topmost:', err);
      showDockToast(tr('dock.preview.pinElevatedError', 'Cannot pin an administrator window'), 3500);
    }
  };

  const handleOpenWindowsTool = async (tool: string) => {
    try {
      await bridgeInvoke('open_windows_tool', { tool });
    } catch (err) {
      const msg = String(err ?? '');
      if (msg.includes('cancelled')) return;
      console.error(`Failed to open Windows tool ${tool}:`, err);
    }
  };

  const handlePowerAction = async (action: 'lock' | 'sign_out' | 'sleep' | 'hibernate' | 'restart' | 'shutdown') => {
    try {
      await bridgeInvoke('execute_power_action', { action });
    } catch (err) {
      console.error(`Failed power action ${action}:`, err);
    }
  };

  // Middle-click opens a new instance like the taskbar. The mousedown preventDefault
  // stops the autoscroll cursor.
  const handleMiddleClick = (e: React.MouseEvent, app: AppInfo) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    tourDockAction();
    handleNewInstance(app);
  };

  const togglePin = async (app: AppInfo) => {
    let newPinned;
    if (app.is_pinned) {
      newPinned = pinnedApps.filter(a => itemKey(a) !== itemKey(app));
    } else {
      // Same app pinned under another entry shape (running window vs shortcut) must not duplicate.
      if (pinnedApps.some(a => isSameApp(a, app))) return;
      newPinned = [...pinnedApps, { ...app, is_pinned: true, is_running: false, hwnd: undefined }];
      fetchIcon(app.path, app.name); 
    }
    setPinnedApps(newPinned);
    await invoke('save_pinned_apps', { apps: newPinned });
    closeMenu();
  };

  const toggleAppTintExclusion = (app: AppInfo) => {
    const targetId = app.path || app.name;
    const currentRaw = JSON.stringify(Array.from(excludedTintApps));
    const wasExcluded = isAppTintExcluded(targetId, excludedTintApps);
    let result = computeUpdatedTintExclusions(targetId, currentRaw);
    // Handle `.exe` stem alias if excluded under the alternate variant
    if (wasExcluded && result.excluded && result.key) {
      const altKey = result.key.endsWith(".exe") ? result.key.slice(0, -4) : `${result.key}.exe`;
      if (altKey) {
        result = computeUpdatedTintExclusions(altKey, currentRaw);
      }
    }
    try {
      localStorage.setItem("nectar-icon-tint-excluded", result.serialized);
    } catch {}
    setExcludedTintApps(new Set(result.list));
    notifyLocalSettingChanges(["nectar-icon-tint-excluded"]);
    bridgeInvoke("save_setting", { key: "nectar-icon-tint-excluded", value: result.serialized }).catch(console.error);
    closeMenu();
  };

  const menuRef = useRef<HTMLDivElement>(null);
  const activeSubmenuRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const submenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelSubmenuClose = () => {
    if (submenuCloseTimerRef.current) {
      clearTimeout(submenuCloseTimerRef.current);
      submenuCloseTimerRef.current = null;
    }
  };

  const openSubmenu = (id: DockSubmenuId) => {
    cancelSubmenuClose();
    setActiveSubmenu(id);
  };

  const scheduleSubmenuClose = (id: DockSubmenuId) => {
    cancelSubmenuClose();
    submenuCloseTimerRef.current = setTimeout(() => {
      submenuCloseTimerRef.current = null;
      setActiveSubmenu((cur) => (cur === id ? null : cur));
    }, 170);
  };

  useEffect(() => cancelSubmenuClose, []);

  const handleContextMenu = (e: React.MouseEvent, app: AppInfo | null, shortcut?: DockShortcutMenu) => {
    e.stopPropagation();
    e.preventDefault();
    tourDockAction();
    cancelSubmenuClose();
    setHoveredApp(null);
    setPreviewData(null);
    setActiveSubmenu(null);
    setContextWindowState(null);
    setContextMenuHeight(0);
    setContextMenuWidth(0);
    const dockRect = dockRef.current?.getBoundingClientRect();
    const target = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({
      x: (app || shortcut) ? target.left + target.width / 2 : (dockRect ? dockRect.left + dockRect.width / 2 : e.clientX),
      y: dockRect ? dockRect.top : e.clientY,
      app,
      shortcut,
    });
  };

  const closeMenu = () => {
    cancelSubmenuClose();
    setContextMenu(null);
    setActiveSubmenu(null);
    invoke('set_menu_open', { open: false, rect: null }).catch(() => {});
  };
  closeMenuRef.current = closeMenu;

  const closePopup = () => {
    setShowAddPopup(false);
    setRenameApp(null);
    invoke('set_menu_open', { open: false, rect: null }).catch(() => {});
  };
  closePopupRef.current = closePopup;

  const contextMenuAppIsExplorer = isExplorerApp(contextMenu?.app);
  useEffect(() => {
    if (!contextMenu || !contextMenuAppIsExplorer) {
      setExplorerJumpList([]);
      return;
    }
    setExplorerJumpList([{ id: "thisPc", path: "shell:MyComputerFolder", kind: "thisPc" }]);
    let cancelled = false;
    bridgeInvoke<ExplorerJumpListItem[]>("get_explorer_jump_list")
      .then((items) => {
        if (cancelled) return;
        const normalized = Array.isArray(items)
          ? items.filter((it) => it && typeof it.path === "string" && it.path.trim() !== "")
          : [];
        const hasThisPc = normalized.some(
          (it) => it.kind === "thisPc" || it.kind === "this_pc" || it.path.toLowerCase() === "shell:mycomputerfolder"
        );
        if (!hasThisPc) {
          normalized.push({
            id: "thisPc",
            path: "shell:MyComputerFolder",
            kind: "thisPc",
          });
        }
        setExplorerJumpList(normalized);
      })
      .catch(() => {
        if (!cancelled) {
          setExplorerJumpList([{ id: "thisPc", path: "shell:MyComputerFolder", kind: "thisPc" }]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contextMenu, contextMenuAppIsExplorer]);

  const contextMenuHwnd = contextMenu?.app?.is_running ? (contextMenu.app.hwnd ?? null) : null;
  useEffect(() => {
    if (!contextMenuHwnd) {
      setContextWindowState(null);
      return;
    }
    let cancelled = false;
    bridgeInvoke<ContextWindowState>("get_window_state", { hwnd: contextMenuHwnd })
      .then((state) => {
        if (!cancelled && state) setContextWindowState(state);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [contextMenuHwnd]);

  useLayoutEffect(() => {
    if (contextMenu && menuRef.current) {
      const measured = menuRef.current.offsetHeight * scale;
      if (measured > 0 && Math.abs(measured - contextMenuHeight) > 0.5) {
        setContextMenuHeight(measured);
      }
      const measuredWidth = menuRef.current.offsetWidth * scale;
      if (measuredWidth > 0 && Math.abs(measuredWidth - contextMenuWidth) > 0.5) {
        setContextMenuWidth(measuredWidth);
      }
    } else if (!contextMenu && (contextMenuHeight !== 0 || contextMenuWidth !== 0)) {
      setContextMenuHeight(0);
      setContextMenuWidth(0);
    }
  }, [contextMenu, contextMenuHeight, contextMenuWidth, explorerJumpList.length, scale]);

  const dockSpring = useMemo(
    () => scaleSpring(classicDockAnimations ? CLASSIC_DOCK_SPRING : DOCK_SPRING),
    [scaleSpring, classicDockAnimations],
  );
  const dockSlideSpring = useMemo(
    () => scaleSpring(classicDockAnimations ? CLASSIC_DOCK_SLIDE_SPRING : DOCK_SLIDE_SPRING),
    [scaleSpring, classicDockAnimations],
  );
  const dockCornerSpring = useMemo(
    () => (classicDockAnimations ? scaleSpring(CLASSIC_CORNER_SPRING) : dockSpring),
    [scaleSpring, classicDockAnimations, dockSpring],
  );
  const dockLayoutSpring = useMemo(
    () => scaleSpring(classicDockAnimations ? CLASSIC_LAYOUT_SPRING : MODERN_LAYOUT_SPRING),
    [scaleSpring, classicDockAnimations],
  );
  const iconVariants = useMemo(() => {
    const iconSpring = scaleSpring(classicDockAnimations ? CLASSIC_ICON_SPRING : ICON_SPRING);
    const hoverTarget = isWaveActive
      ? { y: 0, scale: 1, transition: iconSpring }
      : { y: dockHoverScale <= 1.01 ? 0 : -5, scale: dockHoverScale, transition: iconSpring };
    return {
      idle: { y: 0, scale: 1, transition: iconSpring },
      hover: hoverTarget,
      drag: { y: -10, scale: Math.max(1.05, dockHoverScale), opacity: 0.8, transition: iconSpring },
      tap: { scale: 0.94, transition: iconSpring },
    };
  }, [scaleSpring, classicDockAnimations, dockHoverScale, isWaveActive]);
  const contextMenuLeft = useMemo(() => {
    if (!contextMenu) return 8;
    const w = contextMenuWidth || 176 * scale;
    return Math.min(Math.max(8, contextMenu.x - w / 2), Math.max(8, viewportWidth - w - 8));
  }, [contextMenu, contextMenuWidth, viewportWidth, scale]);
  const openSubmenuLeft = useMemo(() => {
    const w = contextMenuWidth || 176 * scale;
    return contextMenuLeft + w + 224 * scale > viewportWidth;
  }, [contextMenuLeft, contextMenuWidth, viewportWidth, scale]);

  useLayoutEffect(() => {
    let open = false;
    let rect = null;

    if (contextMenu && menuRef.current) {
      const r = menuRef.current.getBoundingClientRect();
      const subW = activeSubmenu ? Math.round(215 * scale) : 0;
      const subRect = activeSubmenu && activeSubmenuRef.current ? activeSubmenuRef.current.getBoundingClientRect() : null;
      const hasSubRect = !!subRect && subRect.width > 0 && subRect.height > 0;
      const pad = Math.round(14 * scale);
      const minX = (hasSubRect ? Math.min(r.x, subRect.left) : r.x - (openSubmenuLeft ? subW : 0)) - pad;
      const maxX = (hasSubRect ? Math.max(r.right, subRect.right) : r.right + (openSubmenuLeft ? 0 : subW)) + pad;
      const minY = (hasSubRect ? Math.min(r.y, subRect.top) : r.y) - pad;
      const maxY = (hasSubRect ? Math.max(r.bottom, subRect.bottom) : r.bottom) + pad;
      rect = {
        x: Math.round(minX),
        y: Math.round(minY),
        width: Math.round(Math.max(r.width + subW + pad * 2, maxX - minX)),
        height: Math.round(maxY - minY),
      };
      open = true;
    } else if (popupOpen && popupRef.current) {
      const r = popupRef.current.getBoundingClientRect();
      rect = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
      open = true;
    }

    invoke('set_menu_open', { open, rect }).catch(() => {});

  }, [contextMenu, contextMenuHeight, contextMenuWidth, popupOpen, pinnedApps, activeApps, activeSubmenu, explorerJumpList, scale, openSubmenuLeft]);

  const dockItems = useMemo(() => {
    const runningMap = new Map();
    activeApps.forEach(a => {
      const id = appIdentity(a.path, a.executable, a.name);
      if (!runningMap.has(id)) runningMap.set(id, a);
    });
    
    const matchedRunningKeys = new Set<string>();

    const findRunningApp = (p: AppInfo) => {
      // 1. Try exact match by identity
      const id = appIdentity(p.path, p.executable, p.name);
      let running = runningMap.get(id);
      if (running) {
        matchedRunningKeys.add(appIdentity(running.path, running.executable, running.name));
        return running;
      }

      // 2. Try match by path (without executable)
      const pathId = appIdentity(p.path);
      running = runningMap.get(pathId);
      if (running) {
        matchedRunningKeys.add(appIdentity(running.path, running.executable, running.name));
        return running;
      }

      // 3. Try fallback match by executable name if defined
      if (p.executable) {
        const targetExe = p.executable.toLowerCase();
        const found = activeApps.find(a => !isIdentifier(a.path) && a.executable?.toLowerCase() === targetExe);
        if (found) {
          matchedRunningKeys.add(appIdentity(found.path, found.executable, found.name));
          return found;
        }
      }

      // 4. Try fallback match by path's file name (e.g., if path is "msedge" and running app's executable is "msedge.exe")
      const pinFilename = p.path.split('/').pop()?.split('\\').pop()?.toLowerCase() || "";
      if (pinFilename) {
        const found = activeApps.find(a => {
          if (isIdentifier(a.path)) return false;
          const runExe = a.executable?.toLowerCase() || a.path.split('/').pop()?.split('\\').pop()?.toLowerCase() || "";
          return runExe === pinFilename || runExe === `${pinFilename}.exe` || `${runExe}.exe` === pinFilename;
        });
        if (found) {
          matchedRunningKeys.add(appIdentity(found.path, found.executable, found.name));
          return found;
        }
      }

      return undefined;
    };

    const pinned: AppInfo[] = [
      { name: 'Start', path: 'start', icon: null, is_running: false, is_pinned: true, hwnd: undefined, all_hwnds: undefined, executable: undefined },
      ...pinnedApps.map(p => {
        const running = findRunningApp(p);
        return { ...p, is_running: !!running, hwnd: running?.hwnd, all_hwnds: running?.all_hwnds };
      }).filter(p => !hiddenApps.some(h => h.id === appIdentity(p.path, p.executable, p.name)))
    ];

    const unpinned = activeOrder
      .map(id => activeApps.find(a => appIdentity(a.path, a.executable, a.name) === id))
      .filter((a): a is AppInfo => !!a && !matchedRunningKeys.has(appIdentity(a.path, a.executable, a.name)) && !hiddenApps.some(h => h.id === appIdentity(a.path, a.executable, a.name)));

    return [...pinned, ...unpinned];
  }, [pinnedApps, activeApps, activeOrder, hiddenApps]);

  const resolveExplorerPlaceKey = (item: Pick<ExplorerJumpListItem, "id" | "kind">) => {
    const kind = (item.kind || "").toLowerCase();
    if (kind && kind !== "known" && kind !== "shell") return kind;
    return (item.id || kind).toLowerCase();
  };

  const renderExplorerPlaceIcon = (item: ExplorerJumpListItem) => {
    switch (resolveExplorerPlaceKey(item)) {
      case "desktop":
        return <Monitor size={14} />;
      case "downloads":
        return <Download size={14} />;
      case "documents":
        return <FileText size={14} />;
      case "pictures":
        return <ImageIcon size={14} />;
      case "music":
        return <Music size={14} />;
      case "videos":
        return <Film size={14} />;
      case "thispc":
      case "this_pc":
        return <HardDrive size={14} />;
      case "home":
        return <House size={14} />;
      default:
        return <Folder size={14} />;
    }
  };

  const formatExplorerPlaceLabel = (item: ExplorerJumpListItem) => {
    switch (resolveExplorerPlaceKey(item)) {
      case "desktop":
        return tr("dock.explorer.desktop", "Desktop");
      case "downloads":
        return tr("dock.explorer.downloads", "Downloads");
      case "documents":
        return tr("dock.explorer.documents", "Documents");
      case "pictures":
        return tr("dock.explorer.pictures", "Pictures");
      case "music":
        return tr("dock.explorer.music", "Music");
      case "videos":
        return tr("dock.explorer.videos", "Videos");
      case "thispc":
      case "this_pc":
        return tr("dock.explorer.thisPc", "This PC");
      default: {
        const clean = item.path.replace(/[\\/]+$/, "");
        const last = clean.split(/[\\/]/).pop();
        return last || item.path;
      }
    }
  };

  const renderExplorerJumpMenu = (openLeft = false) => {
    if (explorerJumpList.length === 0) return null;
    return (
      <div
        className={`menu-item has-submenu${activeSubmenu === "places" ? " submenu-open" : ""}`}
        onMouseEnter={() => openSubmenu("places")}
        onMouseLeave={() => scheduleSubmenuClose("places")}
        onClick={(e) => {
          e.stopPropagation();
          cancelSubmenuClose();
          setActiveSubmenu((prev) => (prev === "places" ? null : "places"));
        }}
      >
        <span className="menu-item-icon"><FolderOpen size={14} /></span>
        <span className="menu-item-label">{tr("dock.explorer.places", "Places")}</span>
        <span className="submenu-arrow">▶</span>
        <div
          ref={activeSubmenu === "places" ? activeSubmenuRef : undefined}
          className={`submenu explorer-places-submenu nectar-menu-pop${openLeft ? " submenu-left" : ""}`}
          onMouseEnter={() => openSubmenu("places")}
          onMouseLeave={() => scheduleSubmenuClose("places")}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="submenu-scroll nectar-scroll">
            {explorerJumpList.map((folder, idx) => {
              const isThisPc = folder.kind.toLowerCase() === "thispc" || folder.kind.toLowerCase() === "this_pc";
              return (
                <Fragment key={folder.id || folder.path}>
                  {isThisPc && idx > 0 && <div className="menu-divider" />}
                  <div
                    className="menu-item explorer-place-item"
                    title={folder.path}
                    onClick={(e) => {
                      e.stopPropagation();
                      bridgeInvoke("open_start_folder", { path: folder.path }).catch((err) =>
                        console.error("Failed to open Explorer place:", err)
                      );
                      closeMenu();
                    }}
                  >
                    <span className="menu-item-icon">{renderExplorerPlaceIcon(folder)}</span>
                    <span className="menu-item-label">{formatExplorerPlaceLabel(folder)}</span>
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const nectarOptionsMenu = (openLeft = false) => {
    const on = (id: string) => menuItems.includes(id);
    const hasTop = ["calendar", "settings", "taskmgr", "restart", "clearicons"].some(on);
    if (!hasTop && !on("quit")) return null;
    return (
      <div
        className={`menu-item has-submenu${activeSubmenu === 'nectar' ? ' submenu-open' : ''}`}
        onMouseEnter={() => openSubmenu('nectar')}
        onMouseLeave={() => scheduleSubmenuClose('nectar')}
        onClick={(e) => {
          e.stopPropagation();
          cancelSubmenuClose();
          setActiveSubmenu((prev) => (prev === 'nectar' ? null : 'nectar'));
        }}
      >
        <span className="menu-item-icon"><Sliders size={14} /></span>
        <span className="menu-item-label">{t("dockmenu.options")}</span>
        <span className="submenu-arrow">▶</span>
        <div
          ref={activeSubmenu === 'nectar' ? activeSubmenuRef : undefined}
          className={`submenu nectar-menu-pop${openLeft ? ' submenu-left' : ''}`}
          onMouseEnter={() => openSubmenu('nectar')}
          onMouseLeave={() => scheduleSubmenuClose('nectar')}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="submenu-scroll nectar-scroll">
            {on("calendar") && <div className="menu-item" onClick={() => { bridgeInvoke('open_calendar_window'); closeMenu(); }}><span className="menu-item-label">{t("dockmenu.openCalendar")}</span></div>}
            {on("settings") && <div className="menu-item" onClick={() => { bridgeInvoke('open_settings_window'); closeMenu(); }}><span className="menu-item-label">{t("dockmenu.openSettings")}</span></div>}
            {on("taskmgr") && <div className="menu-item" onClick={() => { bridgeInvoke('open_app', { appName: 'taskmgr' }); closeMenu(); }}><span className="menu-item-label">{t("dockmenu.taskManager")}</span></div>}
            {on("restart") && <div className="menu-item" onClick={() => bridgeInvoke('restart_nectar')}><span className="menu-item-label">{t("general.restart")}</span></div>}
            {on("clearicons") && <div className="menu-item" onClick={() => { handleClearIconCache(); closeMenu(); }}><span className="menu-item-label">{t("dockmenu.clearIconCache")}</span></div>}
            {hasTop && on("quit") && <div className="menu-divider" />}
            {on("quit") && <div className="menu-item quit" onClick={() => bridgeInvoke('quit_nectar')}><span className="menu-item-label">{t("general.quit")}</span></div>}
          </div>
        </div>
      </div>
    );
  };

  const hideFromDock = (app: AppInfo) => {
    const id = appIdentity(app.path, app.executable, app.name);
    if (hiddenApps.some(h => h.id === id)) return;
    const next = [...hiddenApps, { id, name: app.name }];
    setHiddenApps(next);
    const value = JSON.stringify(next);
    localStorage.setItem("nectar-dock-hidden-apps", value);
    invoke("save_setting", { key: "nectar-dock-hidden-apps", value }).catch(console.error);
    closeMenu();
  };

  const startItem = useMemo(() => dockItems.find(i => i.path === 'start') as AppInfo, [dockItems]);

  const attentionBadge = (app: AppInfo) => {
    if (!dockAttentionEnabled || legacyMode || !app.is_running) return null;
    const { flashing, count } = appAttention(app, attentionWindows);
    return flashing || count > 0 ? <AttentionBadge count={count} /> : null;
  };
  const pinnedItems = useMemo(() => dockItems.filter(i => i.path !== 'start' && i.is_pinned), [dockItems]);
  const unpinnedItems = useMemo(() => dockItems.filter(i => !i.is_pinned), [dockItems]);

  // Latest state for the Win+Number listener, which subscribes only once.
  useEffect(() => {
    pinnedItemsRef.current = pinnedItems;
    handleAppClickRef.current = handleAppClick;
  });

  // Which launcher the search icon couldn't open (it fell back to Windows Search), shown for a few seconds
  const [searchNote, setSearchNote] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    getCurrentWebviewWindow().listen<string>("dock-search-note", (event) => {
      if (cancelled) return;
      setSearchNote(event.payload);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!cancelled) setSearchNote(null);
      }, 4500);
    }).then((fn) => {
      if (cancelled) fn();
      else stop = fn;
    }).catch(() => {});
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stop?.();
    };
  }, []);

  useEffect(() => {
    // Backend claims Win+1-9 while the taskbar is hidden and tells us the slot, same as clicking that icon.
    let cancelled = false;
    let stop: (() => void) | undefined;
    getCurrentWebviewWindow().listen<number>("dock-win-number", (event) => {
      if (cancelled) return;
      const app = pinnedItemsRef.current[event.payload];
      if (app) {
        const key = itemKey(app);
        const wrapper = dockRef.current?.querySelector(`[data-app-key="${CSS.escape(key)}"]`);
        triggerLaunchBounce(wrapper ?? null);
        handleAppClickRef.current(app);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else stop = fn;
    }).catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const combinableItems = useMemo(() => dockItems.filter(i => i.path !== 'start'), [dockItems]);
  const mixedItems = useMemo(() => {
    if (!dockMixedReorder) return combinableItems;
    const known = combinableItems.filter(i => mixedOrder.includes(itemKey(i)));
    const unknown = combinableItems.filter(i => !mixedOrder.includes(itemKey(i)));
    known.sort((a, b) => mixedOrder.indexOf(itemKey(a)) - mixedOrder.indexOf(itemKey(b)));
    return [...known, ...unknown];
  }, [combinableItems, dockMixedReorder, mixedOrder]);

  // Keyed by identity, not path: web apps in one browser share an exe path.
  const handleReorder = (newKeys: string[]) => {
    const oldKeys = pinnedApps.map(itemKey);
    if (JSON.stringify(newKeys) !== JSON.stringify(oldKeys)) {
      const reordered = newKeys
        .map(key => pinnedApps.find(p => itemKey(p) === key))
        .filter((p): p is AppInfo => !!p);
      setPinnedApps(reordered);
    }
  };

  const handleDragEnd = () => {
    tourDockAction();
    setIsDragging(false);
    setPressedApp(null);
    invoke('save_pinned_apps', { apps: pinnedApps }).catch(console.error);
  };

  const handleUnpinnedReorder = (newPaths: string[]) => {
    setActiveOrder(newPaths);
  };

  const handleUnpinnedDragEnd = () => {
    setIsDragging(false);
    setPressedApp(null);
  };

  const handleMixedReorder = (newKeys: string[]) => {
    setMixedOrder(newKeys);
    const pinnedKeys = new Set(pinnedApps.map(itemKey));
    const newPinnedOrder = newKeys.filter(k => pinnedKeys.has(k));
    const oldPinnedOrder = pinnedApps.map(itemKey);
    if (JSON.stringify(newPinnedOrder) !== JSON.stringify(oldPinnedOrder)) {
      const reordered = newPinnedOrder
        .map(key => pinnedApps.find(p => itemKey(p) === key))
        .filter((p): p is AppInfo => !!p);
      setPinnedApps(reordered);
    }
  };

  const handleMixedDragEnd = (app: AppInfo) => {
    setIsDragging(false);
    setPressedApp(null);
    if (app.is_pinned) {
      invoke('save_pinned_apps', { apps: pinnedApps }).catch(console.error);
    }
  };

  useEffect(() => {
    // Only report true dock-window hover, not the edge-hover from Rust,
    // to avoid a feedback loop that keeps the dock open.
    invoke('set_dock_hovered', { hovered: isDockHovered }).catch(() => {});
  }, [isDockHovered]);

  useEffect(() => {
    invoke('set_dock_dragging', { dragging: isDragging }).catch(() => {});
  }, [isDragging]);

  useEffect(() => {
    const handleBlur = () => {
      closeMenu();
      closePopup();
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []);

  const hoveredPreviewSig = useMemo(() => {
    const item = hoveredApp ? dockItems.find(a => itemKey(a) === hoveredApp) : undefined;
    if (!item) return "";
    return `${item.is_running ? 1 : 0}:${item.all_hwnds?.map(([h]) => h).join(",") ?? item.hwnd ?? ""}`;
  }, [hoveredApp, dockItems]);

  const previewOrderRef = useRef(new Map<number, number>());

  useEffect(() => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    isPreviewHoveredRef.current = false;
    hoveredAppRef.current = hoveredApp;

    if (!dockPreviewEnabled) {
      setPreviewData(null);
      return;
    }

    if (!hoveredApp) {
      const timer = setTimeout(() => setPreviewData(null), 100);
      return () => clearTimeout(timer);
    }

    if (hoveredApp && !isDragging && !contextMenu) {
      const app = dockItemsRef.current.find(a => itemKey(a) === hoveredApp);
      if (app && app.is_running) {
        const rawHwnds: [number, string][] = app.all_hwnds && app.all_hwnds.length > 0
          ? app.all_hwnds
          : (app.hwnd ? [[app.hwnd, app.name]] : []);
        const hwndsToCapture = rawHwnds.slice(0, MAX_PREVIEW_WINDOWS);
        const extraCount = Math.max(0, rawHwnds.length - hwndsToCapture.length);
        const pixelScale = (window.devicePixelRatio || 1) * (scale || 1);

        previewTimerRef.current = setTimeout(async () => {
          try {
            const results = await Promise.all(
              hwndsToCapture.map(async ([hwnd, rawTitle]) => {
                const title = rawTitle?.trim() || app.name;
                for (let attempt = 0; attempt < 3; attempt++) {
                  if (attempt > 0) {
                    await new Promise((r) => setTimeout(r, 120));
                    if (hoveredAppRef.current !== itemKey(app)) break;
                  }
                  try {
                    const res = await invoke<[string, number] | null>("capture_window_thumbnail", { hwnd, maxWidth: Math.ceil(PREVIEW_MAX_WIDTH * pixelScale), maxHeight: Math.ceil(PREVIEW_MAX_HEIGHT * pixelScale) });
                    if (res && res[0]) {
                      const [image, lastFocused] = res;
                      return { hwnd, title, image, lastFocused };
                    }
                  } catch {}
                }
                return { hwnd, title, image: "", lastFocused: 0 };
              })
            );

            const captured = results
              .filter((r): r is { hwnd: number, title: string, image: string, lastFocused: number } => r !== null)
              .map(({ hwnd, title, image }) => ({ hwnd, title, image }));
            const order = previewOrderRef.current;
            if (order.size > 200) {
              const activeSet = new Set(captured.map(c => c.hwnd));
              for (const k of order.keys()) {
                if (!activeSet.has(k)) order.delete(k);
              }
            }
            for (const c of [...captured].sort((a, b) => a.hwnd - b.hwnd)) {
              if (!order.has(c.hwnd)) order.set(c.hwnd, order.size);
            }
            captured.sort((a, b) => (order.get(a.hwnd) ?? 0) - (order.get(b.hwnd) ?? 0));
            const sized = await Promise.all(captured.map(async (c) => ({ ...c, ratio: await imageRatio(c.image) })));

            const currentHovered = hoveredAppRef.current;
            if (sized.length > 0 && currentHovered === itemKey(app)) {
              setPreviewData({ id: itemKey(app), previews: sized, extraCount });
              tourDockAction();
            } else if (currentHovered === itemKey(app)) {
              setPreviewData(null);
            }
          } catch (e) {
            console.error("Failed to capture thumbnails:", e);
            setPreviewData(null);
          }
        }, previewDelay);
      } else {
        setPreviewData(null);
      }
    }

    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    };
  }, [hoveredApp, isDragging, hoveredPreviewSig, contextMenu, previewDelay, dockPreviewEnabled, scale]);

  // Sync updated Explorer/window titles into open preview cards without tearing down DWM thumbnails.
  useEffect(() => {
    const current = previewDataRef.current;
    if (!current) return;
    const app = dockItems.find((a) => itemKey(a) === current.id);
    if (!app?.all_hwnds?.length) return;
    const titleMap = new Map<number, string>(app.all_hwnds);
    let changed = false;
    const nextPreviews = current.previews.map((p) => {
      const nextTitle = titleMap.get(p.hwnd)?.trim() || app.name;
      if (nextTitle !== p.title) {
        changed = true;
        return { ...p, title: nextTitle };
      }
      return p;
    });
    const nextExtra = current.previews.length >= MAX_PREVIEW_WINDOWS
      ? Math.max(0, app.all_hwnds.length - MAX_PREVIEW_WINDOWS)
      : current.extraCount;
    if (changed || nextExtra !== current.extraCount) {
      setPreviewData({ ...current, previews: nextPreviews, extraCount: nextExtra });
    }
  }, [dockItems]);

  const dockItemsRef = useRef(dockItems);
  dockItemsRef.current = dockItems;

  useEffect(() => {
    let cancelled = false;
    let key: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisteners: Array<() => void> = [];
    const registerListen = (promise: Promise<() => void>) => {
      promise
        .then((fn) => {
          if (cancelled) fn();
          else unlisteners.push(fn);
        })
        .catch(() => {});
    };
    const clear = () => {
      key = null;
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const over = (x: number, y: number) => {
      if (cancelled) return;
      const ratio = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(x / ratio, y / ratio)?.closest('[data-app-key]');
      const next = el?.getAttribute('data-app-key') ?? null;
      if (next === key) return;
      clear();
      if (!next) return;
      key = next;
      tourDockAction();
      timer = setTimeout(() => {
        if (cancelled) return;
        const app = dockItemsRef.current.find((a) => itemKey(a) === next);
        const hwnd = app?.hwnd ?? app?.all_hwnds?.[0]?.[0];
        if (app?.is_running && hwnd) invoke('bring_window_forward', { hwnd }).catch(() => {});
      }, 650);
    };
    registerListen(getCurrentWebviewWindow().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'over') over(payload.position.x, payload.position.y);
      else clear();
    }));
    registerListen(listen<{ x: number; y: number }>('dock-file-drag', (event) => over(event.payload.x, event.payload.y)));
    registerListen(listen('dock-file-drag-end', clear));
    invoke('setup_shelf_drop').catch(() => {});
    return () => {
      cancelled = true;
      clear();
      for (const fn of unlisteners) fn();
    };
  }, []);

  const previewAppId = dockPreviewEnabled ? previewData?.id : undefined;
  useEffect(() => {
    if (!previewAppId) {
      setMediaSessions([]);
      return;
    }
    let cancelled = false;
    const refresh = () =>
      invoke<AppMediaSession[]>('get_app_media_sessions')
        .then((sessions) => { if (!cancelled) setMediaSessions(sessions); })
        .catch(() => {});
    refresh();
    const timer = setVisibleInterval(() => {
      if (!shouldPausePollsRef.current) refresh();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [previewAppId]);

  const controlMedia = (e: React.MouseEvent, session: AppMediaSession, action: 'previous' | 'play_pause' | 'next') => {
    e.stopPropagation();
    invoke('app_media_control', { appId: session.app_id, action })
      .then(() => setTimeout(() => invoke<AppMediaSession[]>('get_app_media_sessions').then(setMediaSessions).catch(() => {}), 300))
      .catch(() => {});
  };

  const renderPreviewMedia = (app: AppInfo) => {
    const session = sessionForApp(app, mediaSessions);
    if (!session || !session.title) return null;
    return (
      <div className="preview-media" onClick={(e) => e.stopPropagation()}>
        <div className="preview-media-info">
          <span className="preview-media-title">{session.title}</span>
          {session.artist && <span className="preview-media-artist">{session.artist}</span>}
        </div>
        <div className="preview-media-controls">
          <button aria-label={t("media.previous")} onClick={(e) => controlMedia(e, session, 'previous')}><SkipBackIcon size={14} /></button>
          <button
            aria-label={session.is_playing ? t("media.pause") : t("media.play")}
            onClick={(e) => controlMedia(e, session, 'play_pause')}
          >
            {session.is_playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
          </button>
          <button aria-label={t("media.next")} onClick={(e) => controlMedia(e, session, 'next')}><SkipForwardIcon size={14} /></button>
        </div>
      </div>
    );
  };

  const renderShortcut = (
    id: string,
    label: string,
    delay: number,
    onClick: (rect: DOMRect, e: React.MouseEvent) => void,
    icon: React.ReactNode,
    shortcutMenu?: DockShortcutMenu
  ) => {
    const tintExcluded = isAppTintExcluded(id, excludedTintApps);
    return (
      <motion.div
        key={id}
        initial={{ opacity: 0, scale: 0 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ opacity: { duration: 0.15, delay }, scale: { type: "spring", stiffness: 400, damping: 25, delay } }}
        className="dock-icon-wrapper dock-wave-item"
        onContextMenu={shortcutMenu ? (e) => handleContextMenu(e, null, shortcutMenu) : undefined}
        onMouseEnter={() => setHoveredApp(id)}
        onMouseLeave={() => { setHoveredApp(null); setPressedApp(null); }}
      >
        {(!dockPreviewEnabled || hoveredApp === id) && <div className="tooltip">{label}</div>}
        <div className="dock-wave-target">
          <div
            className="dock-launch-slot"
            onAnimationEnd={(e) => e.currentTarget.classList.remove('is-launching')}
          >
            <motion.div
              className={`dock-icon${!dockIconOnly ? " nectar-tint-tile" : ""}`}
              data-tint-excluded={tintExcluded ? "true" : undefined}
              variants={iconVariants}
              animate={pressedApp === id ? "tap" : (hoveredApp === id ? "hover" : "idle")}
              onPointerDown={() => setPressedApp(id)}
              onPointerUp={() => setPressedApp(null)}
              onPointerCancel={() => setPressedApp(null)}
              onClick={(e) => {
                e.stopPropagation();
                triggerLaunchBounce(e.currentTarget.closest('.dock-launch-slot'));
                onClick(e.currentTarget.getBoundingClientRect(), e);
              }}
            >
              {icon}
            </motion.div>
          </div>
        </div>
      </motion.div>
    );
  };

  const renderDockAppItem = (app: AppInfo, listKind: "pinned" | "unpinned" | "mixed") => {
    const key = itemKey(app);
    const tintExcluded = isAppTintExcluded(app.path || app.name, excludedTintApps);
    const isHost = isBrowserHost(app.path);
    const cacheKey = isHost ? `${app.path}:${app.name.toLowerCase()}` : (app.hwnd ? `${app.path}-${app.hwnd}` : app.path);
    // Running host items skip the shared path fallback, or the browser's icon leaks onto its PWAs.
    const allowPathFallback = !isHost || !app.is_running;
    const icon =
      customIcons[cacheKey] ||
      (allowPathFallback && customIcons[app.path]) ||
      iconsRef.current[cacheKey] ||
      (allowPathFallback && iconsRef.current[app.path]) ||
      app.icon;
    const isNectarOrSettings = isNectarWindow(app);

    const animateState =
      pressedApp === key
        ? "tap"
        : listKind === "pinned" && isDragging && !app.is_pinned
          ? "idle"
          : listKind === "unpinned" && isDragging && app.is_pinned
            ? "idle"
            : hoveredApp === key && !isDragging
              ? "hover"
              : "idle";

    return (
      <Reorder.Item
        as="div"
        key={key}
        value={key}
        style={{ position: 'relative' }}
        onDragStart={() => {
          resetWave();
          setIsDragging(true);
          setHoveredApp(null);
          setPressedApp(null);
        }}
        onDragEnd={() => {
          if (listKind === "pinned") handleDragEnd();
          else if (listKind === "unpinned") handleUnpinnedDragEnd();
          else handleMixedDragEnd(app);
        }}
        onContextMenu={(e) => handleContextMenu(e, app)}
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
        onAuxClick={(e) => handleMiddleClick(e, app)}
        onClick={(e) => {
          e.stopPropagation();
          if (!isDragging) {
            triggerLaunchBounce(e.currentTarget);
            if (e.ctrlKey && e.shiftKey && app.path !== 'start') {
              handleRunAsAdmin(app);
            } else if (e.shiftKey && app.path !== 'start') {
              handleNewInstance(app);
            } else {
              handleAppClick(app);
            }
          }
        }}
      >
        <motion.div
          className="dock-icon-wrapper dock-wave-item"
          data-app-key={key}
          initial={ITEM_INITIAL}
          animate={ITEM_ANIMATE}
          exit={listKind === "unpinned" ? { opacity: 0, scale: 0, transition: { duration: 0.12 } } : ITEM_EXIT}
          transition={ITEM_ENTRY_TRANSITION}
          onMouseEnter={() => setHoveredApp(key)}
          onMouseLeave={() => { if (!isPreviewHoveredRef.current) { setHoveredApp(null); setPressedApp(null); } }}
        >
          <AnimatePresence>
            {dockPreviewEnabled && previewData && previewData.id === key && hoveredApp === key && (
              <DockPreviewTooltip
                app={app}
                previews={previewData.previews}
                extraCount={previewData.extraCount}
                onClosePreview={handleClosePreview}
                onPinError={(msg) => showDockToast(msg, 4000)}
                renderMedia={renderPreviewMedia}
                zoom={scale}
                onMouseEnter={() => { isPreviewHoveredRef.current = true; }}
                onMouseLeave={() => { isPreviewHoveredRef.current = false; setHoveredApp(null); setPressedApp(null); }}
              />
            )}
          </AnimatePresence>

          {/* Fallback to text tooltip if previews are disabled, app isn't running, or preview failed to load */}
          {(!dockPreviewEnabled || (dockPreviewEnabled && hoveredApp === key && !previewData)) && (
            <div className="tooltip">{displayName(app)}</div>
          )}

          <div className="dock-wave-target">
            <div
              className="dock-launch-slot"
              onAnimationEnd={(e) => e.currentTarget.classList.remove('is-launching')}
            >
              <motion.div
                className={`dock-icon${!dockIconOnly ? " nectar-tint-tile" : ""}`}
                data-tint-excluded={tintExcluded ? "true" : undefined}
                variants={iconVariants}
                animate={animateState}
                whileDrag="drag"
                onPointerDown={() => setPressedApp(key)}
                onPointerUp={() => setPressedApp(null)}
                onPointerCancel={() => setPressedApp(null)}
              >
                {(icon || isNectarOrSettings) ? (
                  <DockAppIcon
                    src={isNectarOrSettings ? "/nectar.png" : (icon ?? undefined)}
                    alt={app.name}
                    nectar={isNectarOrSettings}
                    tintExcluded={tintExcluded}
                  />
                ) : (
                  <div className="fallback-icon">{app.name[0]}</div>
                )}
                {attentionBadge(app)}
              </motion.div>
            </div>
          </div>
          {app.is_running && <WindowDots count={app.all_hwnds?.length ?? 1} mode={windowIndicator} />}
        </motion.div>
      </Reorder.Item>
    );
  };

  const dockHideOffsetY = Math.max(120, Math.ceil((dockIconSize + 56) * scale));
  const dockTopRadius = scaledRadius(isImpacted || isExpanded ? 18 : 17, 6, 36);
  const dockBottomRadius = isImpacted || isExpanded ? 0 : scaledRadius(17, 6, 36);

  return (
    <div
      className={`dock-container ${isDragging ? 'dragging' : ''}`}
      style={{
        '--dock-icon-size': `${dockIconSize}px`,
        '--dock-icon-gap': `${dockIconGap}px`,
      } as React.CSSProperties}
      onClick={closeMenu}
    >
      <div style={{ width: '100%', height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'flex-end' }}>
        <motion.div
          className="dock-motion-shell"
          initial={{ y: -800, scale }}
          animate={{
            y: !isReady ? -800 : (isHidden ? dockHideOffsetY : 0),
            scale,
          }}
          transition={{
            y: dockSlideSpring,
            scale: { duration: 0 },
          }}
          style={{ originX: 0.5, originY: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-end' }}
          onAnimationComplete={() => {
            if (isDockRevealingRef.current) {
              isDockRevealingRef.current = false;
              setIsDockRevealing(false);
            }
            updateDockRectRef.current();
          }}
        >
        <motion.div
          ref={dockRef}
          layout={!startupAnimating && isExpanded}
          className={`dock ${isExpanded ? 'dock-expanded' : ''} ${isImpacted && !isExpanded ? 'dock-impacted' : ''} ${isHidden ? 'dock-hidden' : ''} ${dockIconOnly ? 'dock-icon-only' : ''} ${isAdaptive ? 'dock-adaptive' : ''}`}
          onMouseEnter={() => setIsDockHovered(true)}
          onMouseMove={handleDockMouseMove}
          onMouseLeave={() => { resetWave(); setIsDockHovered(false); setHoveredApp(null); setPressedApp(null); }}
        initial={{ opacity: 1, width: 34, height: 34, borderTopLeftRadius: 17, borderTopRightRadius: 17, borderBottomLeftRadius: 17, borderBottomRightRadius: 17 }}
        animate={{
          width: isExpanded ? (isAdaptive ? adaptiveWidth : 'auto') : 34,
          height: isExpanded ? 'auto' : 34,
          borderTopLeftRadius: dockTopRadius,
          borderTopRightRadius: dockTopRadius,
          borderBottomLeftRadius: dockBottomRadius,
          borderBottomRightRadius: dockBottomRadius,
          opacity: 1,
        }}
        transition={{
          width: dockSpring,
          height: dockSpring,
          layout: isDragging ? { duration: 0 } : dockLayoutSpring,
          borderTopLeftRadius: dockCornerSpring,
          borderTopRightRadius: dockCornerSpring,
          borderBottomLeftRadius: dockCornerSpring,
          borderBottomRightRadius: dockCornerSpring,
          opacity: { type: "tween", duration: 0.2 },
        }}
        style={{ originX: 0.5, originY: 1, minWidth: 34 }}
        onContextMenu={(e) => handleContextMenu(e, null)}
        onAnimationComplete={() => {
          updateDockRectRef.current();
        }}
      >
        <SurfaceShape
          edge="bottom"
          flare={isExpanded ? 13 : 0}
          radius={isImpacted || isExpanded ? 18 : 17}
          edgeRadius={isImpacted || isExpanded ? 0 : 17}
          minRadius={6}
          maxRadius={36}
          settling={startupAnimating}
        />
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              key="dock-content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15, delay: startupAnimating ? 0.3 : 0 }}
              className="dock-reorder-container"
            >
              {startItem && (() => {
                const startKey = itemKey(startItem);
                const startTintExcluded = isAppTintExcluded(startItem.path || startItem.name, excludedTintApps);
                return (
                  <motion.div
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ opacity: { duration: 0.15, delay: 0.15 }, scale: { type: "spring", stiffness: 400, damping: 25, delay: 0.15 } }}
                    className="dock-icon-wrapper dock-wave-item"
                    onContextMenu={(e) => handleContextMenu(e, startItem)}
                    onMouseEnter={() => setHoveredApp(startKey)}
                    onMouseLeave={() => { setHoveredApp(null); setPressedApp(null); }}
                  >
                    {(!dockPreviewEnabled || (dockPreviewEnabled && hoveredApp === startKey)) && (
                      <div className="tooltip">{t("dockmenu.start")}</div>
                    )}
                    <div className="dock-wave-target">
                      <div
                        className="dock-launch-slot"
                        onAnimationEnd={(e) => e.currentTarget.classList.remove('is-launching')}
                      >
                        <motion.div
                          className={`dock-icon${!dockIconOnly ? " nectar-tint-tile" : ""}`}
                          data-tint-excluded={startTintExcluded ? "true" : undefined}
                          variants={iconVariants}
                          animate={pressedApp === startKey ? "tap" : (hoveredApp === startKey ? "hover" : "idle")}
                          onPointerDown={() => setPressedApp(startKey)}
                          onPointerUp={() => setPressedApp(null)}
                          onPointerCancel={() => setPressedApp(null)}
                          onClick={(e) => {
                            e.stopPropagation();
                            triggerLaunchBounce(e.currentTarget.closest('.dock-launch-slot'));
                            handleAppClick(startItem);
                          }}
                        >
                          <img
                            src={resolveStartIcon(startIcon)}
                            alt="Start"
                            className={[
                              startIcon === "default" ? "nectar-icon-img" : "nectar-icon-img start-img",
                              !startTintExcluded ? "nectar-tintable-icon" : "",
                            ].filter(Boolean).join(" ")}
                            data-tint-excluded={startTintExcluded ? "true" : undefined}
                            style={startIcon.startsWith("custom:") ? { borderRadius: "8px" } : undefined}
                            draggable={false}
                          />
                        </motion.div>
                      </div>
                    </div>
                  </motion.div>
                );
              })()}
              
              {dockSearchEnabled && (() => {
                const searchTintExcluded = isAppTintExcluded('search', excludedTintApps);
                return (
                <motion.div
                  initial={{ opacity: 0, scale: 0 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ opacity: { duration: 0.15, delay: 0.18 }, scale: { type: "spring", stiffness: 400, damping: 25, delay: 0.18 } }}
                  className="dock-icon-wrapper dock-wave-item"
                  onContextMenu={(e) => handleContextMenu(e, null, { kind: 'search' })}
                  onMouseEnter={() => setHoveredApp('search')}
                  onMouseLeave={() => { setHoveredApp(null); setPressedApp(null); }}
                >
                  {searchNote ? (
                    <div className="tooltip tooltip-note">{t(`dock.searchNote.${searchNote}`)}</div>
                  ) : (!dockPreviewEnabled || (dockPreviewEnabled && hoveredApp === 'search')) && (
                    <div className="tooltip">{t("dockmenu.search")}</div>
                  )}
                  <div className="dock-wave-target">
                    <div
                      className="dock-launch-slot"
                      onAnimationEnd={(e) => e.currentTarget.classList.remove('is-launching')}
                    >
                      <motion.div
                        className={`dock-icon${!dockIconOnly ? " nectar-tint-tile" : ""}`}
                        data-tint-excluded={searchTintExcluded ? "true" : undefined}
                        variants={iconVariants}
                        animate={pressedApp === 'search' ? "tap" : (hoveredApp === 'search' ? "hover" : "idle")}
                        onPointerDown={() => setPressedApp('search')}
                        onPointerUp={() => setPressedApp(null)}
                        onPointerCancel={() => setPressedApp(null)}
                        onClick={(e) => {
                          e.stopPropagation();
                          triggerLaunchBounce(e.currentTarget.closest('.dock-launch-slot'));
                          invoke('open_app', { appName: 'search' }).catch((err) => console.error('Failed to open search:', err));
                        }}
                      >
                        <SearchIcon />
                      </motion.div>
                    </div>
                  </div>
                </motion.div>
                );
              })()}

              {dockCalendarEnabled && (() => {
                const calTintExcluded = isAppTintExcluded('calendar', excludedTintApps);
                return (
                <motion.div
                  initial={{ opacity: 0, scale: 0 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ opacity: { duration: 0.15, delay: 0.2 }, scale: { type: "spring", stiffness: 400, damping: 25, delay: 0.2 } }}
                  className="dock-icon-wrapper dock-wave-item"
                  onContextMenu={(e) => handleContextMenu(e, null, { kind: 'calendar' })}
                  onMouseEnter={() => setHoveredApp('calendar')}
                  onMouseLeave={() => { setHoveredApp(null); setPressedApp(null); }}
                >
                  {(!dockPreviewEnabled || (dockPreviewEnabled && hoveredApp === 'calendar')) && (
                    <div className="tooltip">{t("dockmenu.calendar")}</div>
                  )}
                  <div className="dock-wave-target">
                    <div
                      className="dock-launch-slot"
                      onAnimationEnd={(e) => e.currentTarget.classList.remove('is-launching')}
                    >
                      <motion.div
                        className={`dock-icon${!dockIconOnly ? " nectar-tint-tile" : ""}`}
                        data-tint-excluded={calTintExcluded ? "true" : undefined}
                        variants={iconVariants}
                        animate={pressedApp === 'calendar' ? "tap" : (hoveredApp === 'calendar' ? "hover" : "idle")}
                        onPointerDown={() => setPressedApp('calendar')}
                        onPointerUp={() => setPressedApp(null)}
                        onPointerCancel={() => setPressedApp(null)}
                        onClick={(e) => {
                          e.stopPropagation();
                          triggerLaunchBounce(e.currentTarget.closest('.dock-launch-slot'));
                          invoke('open_calendar_window').catch((err) => console.error('Failed to open calendar:', err));
                        }}
                      >
                        <CalendarIcon />
                      </motion.div>
                    </div>
                  </div>
                </motion.div>
                );
              })()}

              {!legacyMode && dockTray && renderShortcut(
                'tray', t('dockmenu.hiddenIcons'), 0.21,
                (rect, e) => invoke('open_tray_from_button', {
                  dx: (rect.left + rect.width / 2 - e.clientX) * window.devicePixelRatio,
                  dy: (rect.top - e.clientY) * window.devicePixelRatio,
                }).catch((err) => console.error('Failed to open tray:', err)),
                <ChevronUpIcon />,
                { kind: 'tray' }
              )}

              {!legacyMode && dockTray && trayBarEnabled && pinnedTrayKeys.length > 0 && (() => {
                const iconByKey = new Map(
                  trayIcons.filter((ic) => !ic.hidden_by_app).map((ic) => [ic.key, ic])
                );
                const pinnedTrayIcons = syncPinnedOrder(pinnedTrayKeys, trayOrder)
                  .map((k) => iconByKey.get(k))
                  .filter((ic): ic is TrayIconDto => Boolean(ic));
                if (pinnedTrayIcons.length === 0) return null;
                return (
                  <div className="dock-pinned-tray-pill" onClick={(e) => e.stopPropagation()}>
                    {pinnedTrayIcons.map((item) => {
                      const label = trayLabels[item.key] || item.title || item.exe_name || "?";
                      const resolvedIcon = customIcons[trayCustomIconKey(item.key)] || item.icon;
                      const trayExcluded = isAppTintExcluded(item.exe_name || item.title, excludedTintApps);
                      return (
                        <button
                          key={item.key}
                          type="button"
                          aria-label={label}
                          className="dock-icon-wrapper dock-pinned-tray-item"
                          onMouseEnter={() => setHoveredApp(`tray:${item.key}`)}
                          onMouseLeave={() => setHoveredApp(null)}
                          onFocus={() => setHoveredApp(`tray:${item.key}`)}
                          onBlur={() => setHoveredApp(null)}
                          onClick={(e) => {
                            e.stopPropagation();
                            const coords = trayInteractionCoords(e, scale);
                            if (e.detail > 1) {
                              return;
                            }
                            if (e.detail === 0) {
                              invoke('interact_tray_icon', { key: item.key, action: 'left', ...coords })
                                .catch((err) => console.error('Failed tray left click:', err));
                              return;
                            }
                            const prevTimer = trayClickTimersRef.current[item.key];
                            if (prevTimer) window.clearTimeout(prevTimer);
                            trayClickTimersRef.current[item.key] = window.setTimeout(() => {
                              delete trayClickTimersRef.current[item.key];
                              invoke('interact_tray_icon', { key: item.key, action: 'left', ...coords })
                                .catch((err) => console.error('Failed tray left click:', err));
                            }, 210);
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            const prevTimer = trayClickTimersRef.current[item.key];
                            if (prevTimer) {
                              window.clearTimeout(prevTimer);
                              delete trayClickTimersRef.current[item.key];
                            }
                            const coords = trayInteractionCoords(e, scale);
                            invoke('interact_tray_icon', { key: item.key, action: 'double', ...coords })
                              .catch((err) => console.error('Failed tray double click:', err));
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const { screenX, screenY, rect } = trayInteractionCoords(e, scale);
                            invoke('interact_tray_icon', { key: item.key, action: 'right', screenX, screenY, rect })
                              .catch((err) => console.error('Failed tray context click:', err));
                          }}
                          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
                          onAuxClick={(e) => {
                            if (e.button === 1) {
                              e.stopPropagation();
                              const { screenX, screenY, rect } = trayInteractionCoords(e, scale);
                              invoke('interact_tray_icon', { key: item.key, action: 'middle', screenX, screenY, rect })
                                .catch((err) => console.error('Failed tray middle click:', err));
                            }
                          }}
                        >
                          {hoveredApp === `tray:${item.key}` && <div className="tooltip">{label}</div>}
                          <div className="dock-pinned-tray-icon" data-tint-excluded={trayExcluded ? "true" : undefined}>
                            {resolvedIcon ? (
                              <img
                                src={resolvedIcon}
                                alt={label}
                                className={trayExcluded ? undefined : "nectar-tintable-icon"}
                                data-tint-excluded={trayExcluded ? "true" : undefined}
                                draggable={false}
                              />
                            ) : (
                              <span>{label.slice(0, 2)}</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}

              {!legacyMode && dockTaskView && renderShortcut(
                'taskview', t('dockmenu.taskView'), 0.22,
                () => invoke('open_app', { appName: 'taskview' }).catch((err) => console.error('Failed to open Task View:', err)),
                <TaskViewIcon />
              )}

              {!legacyMode && dockDrives.map((letter, i) => renderShortcut(
                `drive-${letter}`, t('dock.drive', { letter }), 0.24 + i * 0.02,
                () => invoke('open_dock_extra', { target: letter }).catch((err) => console.error('Failed to open drive:', err)),
                <DriveIcon letter={letter} />,
                { kind: 'drive', letter }
              ))}

              {!legacyMode && dockRecycle && renderShortcut(
                'recycle', t('dockmenu.recycleBin'), 0.26 + dockDrives.length * 0.02,
                () => invoke('open_dock_extra', { target: 'recycle' }).catch((err) => console.error('Failed to open Recycle Bin:', err)),
                <RecycleIcon />,
                { kind: 'recycle' }
              )}

              {!dockMixedReorder ? (
              <>
              <Reorder.Group
                as="div"
                axis="x"
                values={pinnedItems.map(itemKey)}
                onReorder={handleReorder}
                className="dock-reorder-group"
              >
                {pinnedItems.map((app) => renderDockAppItem(app, "pinned"))}
              </Reorder.Group>

              {pinnedItems.length > 0 && unpinnedItems.length > 0 && (
                <div className="dock-group-divider" />
              )}

              <Reorder.Group
                as="div"
                axis="x"
                values={unpinnedItems.map(itemKey)}
                onReorder={handleUnpinnedReorder}
                className="dock-reorder-group"
              >
                {unpinnedItems.map((app) => renderDockAppItem(app, "unpinned"))}
              </Reorder.Group>
              </>
              ) : (
              <Reorder.Group
                as="div"
                axis="x"
                values={mixedItems.map(itemKey)}
                onReorder={handleMixedReorder}
                className="dock-reorder-group"
              >
                {mixedItems.map((app) => renderDockAppItem(app, "mixed"))}
              </Reorder.Group>
              )}

              {dockShowDesktop && (
                <div
                  className="dock-show-desktop"
                  title={t('dockmenu.showDesktop')}
                  onClick={(e) => { e.stopPropagation(); invoke('show_desktop').catch(() => { }); }}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      </motion.div>
    </div>

      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            left: contextMenuLeft,
            top: Math.max(8, contextMenu.y - 10 - (contextMenuHeight || (contextMenu.app ? 200 : 100) * scale)),
            zIndex: 9999,
          }}
        >
        <div
          ref={menuRef}
          className="context-menu nectar-menu-pop"
          style={{
            position: 'static',
            zoom: scale
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.app && contextMenu.app.path !== 'start' ? (
            <>
              {contextMenu.app.is_running ? (
                <div className="menu-item" onClick={() => { handleNewInstance(contextMenu.app!); closeMenu(); }}>
                  <span className="menu-item-icon"><PlusSquare size={14} /></span>
                  <span className="menu-item-label">{t("dockmenu.newInstance")}</span>
                </div>
              ) : (
                <div className="menu-item" onClick={() => { handleAppClick(contextMenu.app!); closeMenu(); }}>
                  <span className="menu-item-icon"><ExternalLink size={14} /></span>
                  <span className="menu-item-label">{t("start.ctx.open")}</span>
                </div>
              )}
              {isExplorerApp(contextMenu.app) && explorerJumpList.length > 0 && renderExplorerJumpMenu(openSubmenuLeft)}
              {supportsWinFileActions(contextMenu.app) && (
                <div
                  className={`menu-item has-submenu${activeSubmenu === "more" ? " submenu-open" : ""}`}
                  onMouseEnter={() => openSubmenu("more")}
                  onMouseLeave={() => scheduleSubmenuClose("more")}
                  onClick={(e) => {
                    e.stopPropagation();
                    cancelSubmenuClose();
                    setActiveSubmenu((prev) => (prev === "more" ? null : "more"));
                  }}
                >
                  <span className="menu-item-icon"><MoreHorizontal size={14} /></span>
                  <span className="menu-item-label">{t("dockmenu.more")}</span>
                  <span className="submenu-arrow">▶</span>
                  <div
                    ref={activeSubmenu === "more" ? activeSubmenuRef : undefined}
                    className={`submenu nectar-menu-pop${openSubmenuLeft ? " submenu-left" : ""}`}
                    onMouseEnter={() => openSubmenu("more")}
                    onMouseLeave={() => scheduleSubmenuClose("more")}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="submenu-scroll nectar-scroll">
                      <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleRunAsAdmin(contextMenu.app!); closeMenu(); }}>
                        <span className="menu-item-icon"><Shield size={14} /></span>
                        <span className="menu-item-label">{t("start.ctx.runAsAdmin")}</span>
                      </div>
                      <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleOpenLocation(contextMenu.app!); closeMenu(); }}>
                        <span className="menu-item-icon"><FolderOpen size={14} /></span>
                        <span className="menu-item-label">{t("start.ctx.openLocation")}</span>
                      </div>
                      <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleOpenProperties(contextMenu.app!); closeMenu(); }}>
                        <span className="menu-item-icon"><Info size={14} /></span>
                        <span className="menu-item-label">{t("dockmenu.properties")}</span>
                      </div>
                      <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleCopyPath(contextMenu.app!); closeMenu(); }}>
                        <span className="menu-item-icon"><Copy size={14} /></span>
                        <span className="menu-item-label">{t("dockmenu.copyPath")}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {contextMenu.app.is_running && contextMenu.app.hwnd && (
                <div
                  className={`menu-item has-submenu${activeSubmenu === "window" ? " submenu-open" : ""}`}
                  onMouseEnter={() => openSubmenu("window")}
                  onMouseLeave={() => scheduleSubmenuClose("window")}
                  onClick={(e) => {
                    e.stopPropagation();
                    cancelSubmenuClose();
                    setActiveSubmenu((prev) => (prev === "window" ? null : "window"));
                  }}
                >
                  <span className="menu-item-icon"><AppWindow size={14} /></span>
                  <span className="menu-item-label">{t("dockmenu.windowMenu")}</span>
                  <span className="submenu-arrow">▶</span>
                  <div
                    ref={activeSubmenu === "window" ? activeSubmenuRef : undefined}
                    className={`submenu nectar-menu-pop${openSubmenuLeft ? " submenu-left" : ""}`}
                    onMouseEnter={() => openSubmenu("window")}
                    onMouseLeave={() => scheduleSubmenuClose("window")}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="submenu-scroll nectar-scroll">
                      <div
                        className="menu-item"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleWindowAction(contextMenu.app!, contextWindowState?.minimized ? "restore" : "minimize");
                          closeMenu();
                        }}
                      >
                        <span className="menu-item-icon"><Minimize2 size={14} /></span>
                        <span className="menu-item-label">
                          {contextWindowState?.minimized ? t("dockmenu.restore") : t("dockmenu.minimize")}
                        </span>
                      </div>
                      <div
                        className="menu-item"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleWindowAction(contextMenu.app!, "maximize");
                          closeMenu();
                        }}
                      >
                        <span className="menu-item-icon"><Maximize2 size={14} /></span>
                        <span className="menu-item-label">
                          {contextWindowState?.maximized ? t("dockmenu.restore") : t("dockmenu.maximize")}
                        </span>
                      </div>
                      <div
                        className="menu-item"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleTopmost(contextMenu.app!);
                          closeMenu();
                        }}
                      >
                        <span className="menu-item-icon"><Pin size={14} /></span>
                        <span className="menu-item-label">{t("dockmenu.alwaysOnTop")}</span>
                        {contextWindowState?.topmost && <Check size={13} className="menu-item-check" />}
                      </div>
                      <div className="menu-divider" />
                      <div
                        className="menu-item quit"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await bridgeInvoke('end_task', {
                            hwnd: contextMenu.app!.hwnd,
                            allHwnds: contextMenu.app!.all_hwnds?.map(([h]) => h) ?? null,
                          }).catch(() => {});
                          closeMenu();
                        }}
                      >
                        <span className="menu-item-icon"><XCircle size={14} /></span>
                        <span className="menu-item-label">{t("dockmenu.endTask")}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <div className="menu-divider" />
              <div className="menu-item" onClick={() => togglePin(contextMenu.app!)}>
                <span className="menu-item-icon">{contextMenu.app.is_pinned ? <PinOff size={14} /> : <Pin size={14} />}</span>
                <span className="menu-item-label">{contextMenu.app.is_pinned ? t("dockmenu.unpin") : t("dockmenu.pin")}</span>
              </div>
              <div
                className={`menu-item has-submenu${activeSubmenu === "appearance" ? " submenu-open" : ""}`}
                onMouseEnter={() => openSubmenu("appearance")}
                onMouseLeave={() => scheduleSubmenuClose("appearance")}
                onClick={(e) => {
                  e.stopPropagation();
                  cancelSubmenuClose();
                  setActiveSubmenu((prev) => (prev === "appearance" ? null : "appearance"));
                }}
              >
                <span className="menu-item-icon"><Palette size={14} /></span>
                <span className="menu-item-label">{t("dockmenu.customizeMenu")}</span>
                <span className="submenu-arrow">▶</span>
                <div
                  ref={activeSubmenu === "appearance" ? activeSubmenuRef : undefined}
                  className={`submenu nectar-menu-pop${openSubmenuLeft ? " submenu-left" : ""}`}
                  onMouseEnter={() => openSubmenu("appearance")}
                  onMouseLeave={() => scheduleSubmenuClose("appearance")}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="submenu-scroll nectar-scroll">
                  {contextMenu.app.is_pinned && (
                    <>
                      <div
                        className="menu-item"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenameApp(contextMenu.app!);
                          closeMenu();
                        }}
                      >
                        <span className="menu-item-icon"><Pencil size={14} /></span>
                        <span className="menu-item-label">{t("dockmenu.rename")}</span>
                      </div>
                      <div
                        className="menu-item"
                        onClick={(e) => {
                          e.stopPropagation();
                          const isHost = isBrowserHost(contextMenu.app!.path);
                          const ck = isHost ? `${contextMenu.app!.path}:${contextMenu.app!.name.toLowerCase()}` : contextMenu.app!.path;
                          iconPickerTargetRef.current = ck;
                          closeMenu();
                          setTimeout(() => {
                            document.getElementById('icon-file-input')?.click();
                          }, 50);
                        }}
                      >
                        <span className="menu-item-icon"><ImageIcon size={14} /></span>
                        <span className="menu-item-label">{t("dockmenu.changeIcon")}</span>
                      </div>
                      {(() => {
                        const isHost = isBrowserHost(contextMenu.app!.path);
                        const ck = isHost ? `${contextMenu.app!.path}:${contextMenu.app!.name.toLowerCase()}` : contextMenu.app!.path;
                        return customIcons[ck] ? (
                          <div
                            className="menu-item"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveCustomIcon(contextMenu.app!);
                              closeMenu();
                            }}
                          >
                            <span className="menu-item-icon"><RotateCcw size={14} /></span>
                            <span className="menu-item-label">{t("dockmenu.resetIcon")}</span>
                          </div>
                        ) : null;
                      })()}
                      <div className="menu-divider" />
                    </>
                  )}
                  <div
                    className="menu-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleAppTintExclusion(contextMenu.app!);
                    }}
                  >
                    <span className="menu-item-icon"><Palette size={14} /></span>
                    <span className="menu-item-label">
                      {isAppTintExcluded(contextMenu.app.path || contextMenu.app.name, excludedTintApps)
                        ? tr("dock.context.includeTint", "Include in icon tinting")
                        : tr("dock.context.excludeTint", "Keep original icon colors")}
                    </span>
                  </div>
                  <div className="menu-divider" />
                  {(contextMenu.app.is_pinned || contextMenu.app.is_running) && (
                    <div
                      className="menu-item"
                      onClick={(e) => {
                        e.stopPropagation();
                        hideFromDock(contextMenu.app!);
                      }}
                    >
                      <span className="menu-item-icon"><EyeOff size={14} /></span>
                      <span className="menu-item-label">{t("dockmenu.hide")}</span>
                    </div>
                  )}
                  <div
                    className="menu-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowAddPopup(true);
                      closeMenu();
                    }}
                  >
                    <span className="menu-item-icon"><Plus size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.addApp")}</span>
                  </div>
                  </div>
                </div>
              </div>
              {nectarOptionsMenu(openSubmenuLeft)}
              {contextMenu.app.is_running && contextMenu.app.hwnd && (
                <>
                  <div className="menu-divider" />
                  <div className="menu-item quit" onClick={() => { handleWindowAction(contextMenu.app!, "close_all"); closeMenu(); }}>
                    <span className="menu-item-icon"><X size={14} /></span>
                    <span className="menu-item-label">
                      {(contextMenu.app.all_hwnds?.length ?? 0) > 1
                        ? t("dockmenu.closeAllWindows")
                        : t("dockmenu.closeWindow")}
                    </span>
                  </div>
                </>
              )}
            </>
          ) : contextMenu.app?.path === 'start' ? (
            <>
              <div className="menu-item" onClick={() => { handleOpenWindowsTool("terminal"); closeMenu(); }}>
                <span className="menu-item-icon"><Terminal size={14} /></span>
                <span className="menu-item-label">{t("dockmenu.winTerminal")}</span>
              </div>
              <div className="menu-item" onClick={() => { handleOpenWindowsTool("explorer"); closeMenu(); }}>
                <span className="menu-item-icon"><Folder size={14} /></span>
                <span className="menu-item-label">{t("dockmenu.winExplorer")}</span>
              </div>
              <div className="menu-item" onClick={() => { handleOpenWindowsTool("run_dialog"); closeMenu(); }}>
                <span className="menu-item-icon"><Play size={14} /></span>
                <span className="menu-item-label">{t("dockmenu.winRun")}</span>
              </div>
              <div className="menu-item" onClick={() => { bridgeInvoke('open_app', { appName: 'taskmgr' }); closeMenu(); }}>
                <span className="menu-item-icon"><Activity size={14} /></span>
                <span className="menu-item-label">{t("dockmenu.taskManager")}</span>
              </div>
              <div className="menu-divider" />
              <div
                className={`menu-item has-submenu${activeSubmenu === "system" ? " submenu-open" : ""}`}
                onMouseEnter={() => openSubmenu("system")}
                onMouseLeave={() => scheduleSubmenuClose("system")}
                onClick={(e) => {
                  e.stopPropagation();
                  cancelSubmenuClose();
                  setActiveSubmenu((prev) => (prev === "system" ? null : "system"));
                }}
              >
                <span className="menu-item-icon"><Monitor size={14} /></span>
                <span className="menu-item-label">{t("dockmenu.winSystemMenu")}</span>
                <span className="submenu-arrow">▶</span>
                <div
                  ref={activeSubmenu === "system" ? activeSubmenuRef : undefined}
                  className={`submenu nectar-menu-pop${openSubmenuLeft ? " submenu-left" : ""}`}
                  onMouseEnter={() => openSubmenu("system")}
                  onMouseLeave={() => scheduleSubmenuClose("system")}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="submenu-scroll nectar-scroll">
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleOpenWindowsTool("terminal_admin"); closeMenu(); }}>
                    <span className="menu-item-icon"><Shield size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.winTerminalAdmin")}</span>
                  </div>
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleOpenWindowsTool("win_settings"); closeMenu(); }}>
                    <span className="menu-item-icon"><Settings size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.winSettings")}</span>
                  </div>
                  <div className="menu-divider" />
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleOpenWindowsTool("installed_apps"); closeMenu(); }}>
                    <span className="menu-item-icon"><AppWindow size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.winInstalledApps")}</span>
                  </div>
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleOpenWindowsTool("device_manager"); closeMenu(); }}>
                    <span className="menu-item-icon"><Cpu size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.winDeviceManager")}</span>
                  </div>
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleOpenWindowsTool("disk_management"); closeMenu(); }}>
                    <span className="menu-item-icon"><HardDrive size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.winDiskManagement")}</span>
                  </div>
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleOpenWindowsTool("network_connections"); closeMenu(); }}>
                    <span className="menu-item-icon"><Wifi size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.winNetwork")}</span>
                  </div>
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleOpenWindowsTool("event_viewer"); closeMenu(); }}>
                    <span className="menu-item-icon"><FileText size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.winEventViewer")}</span>
                  </div>
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleOpenWindowsTool("computer_mgmt"); closeMenu(); }}>
                    <span className="menu-item-icon"><Monitor size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.winComputerMgmt")}</span>
                  </div>
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleOpenWindowsTool("power_options"); closeMenu(); }}>
                    <span className="menu-item-icon"><Power size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.winPowerOptions")}</span>
                  </div>
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handleOpenWindowsTool("control_panel"); closeMenu(); }}>
                    <span className="menu-item-icon"><Sliders size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.winControlPanel")}</span>
                  </div>
                  <div className="menu-divider" />
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); bridgeInvoke('show_desktop'); closeMenu(); }}>
                    <span className="menu-item-icon"><Minimize2 size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.showDesktop")}</span>
                  </div>
                  </div>
                </div>
              </div>
              <div
                className={`menu-item has-submenu${activeSubmenu === "power" ? " submenu-open" : ""}`}
                onMouseEnter={() => openSubmenu("power")}
                onMouseLeave={() => scheduleSubmenuClose("power")}
                onClick={(e) => {
                  e.stopPropagation();
                  cancelSubmenuClose();
                  setActiveSubmenu((prev) => (prev === "power" ? null : "power"));
                }}
              >
                <span className="menu-item-icon"><Power size={14} /></span>
                <span className="menu-item-label">{t("dockmenu.powerMenu")}</span>
                <span className="submenu-arrow">▶</span>
                <div
                  ref={activeSubmenu === "power" ? activeSubmenuRef : undefined}
                  className={`submenu nectar-menu-pop${openSubmenuLeft ? " submenu-left" : ""}`}
                  onMouseEnter={() => openSubmenu("power")}
                  onMouseLeave={() => scheduleSubmenuClose("power")}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="submenu-scroll nectar-scroll">
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handlePowerAction("lock"); closeMenu(); }}>
                    <span className="menu-item-icon"><Lock size={14} /></span>
                    <span className="menu-item-label">{t("start.power.lock")}</span>
                  </div>
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handlePowerAction("sign_out"); closeMenu(); }}>
                    <span className="menu-item-icon"><LogOut size={14} /></span>
                    <span className="menu-item-label">{t("start.power.signOut")}</span>
                  </div>
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handlePowerAction("sleep"); closeMenu(); }}>
                    <span className="menu-item-icon"><Moon size={14} /></span>
                    <span className="menu-item-label">{t("start.power.sleep")}</span>
                  </div>
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handlePowerAction("hibernate"); closeMenu(); }}>
                    <span className="menu-item-icon"><Moon size={14} /></span>
                    <span className="menu-item-label">{t("start.power.hibernate")}</span>
                  </div>
                  <div className="menu-item" onClick={(e) => { e.stopPropagation(); handlePowerAction("restart"); closeMenu(); }}>
                    <span className="menu-item-icon"><RotateCcw size={14} /></span>
                    <span className="menu-item-label">{t("start.power.restart")}</span>
                  </div>
                  <div className="menu-item quit" onClick={(e) => { e.stopPropagation(); handlePowerAction("shutdown"); closeMenu(); }}>
                    <span className="menu-item-icon"><Power size={14} /></span>
                    <span className="menu-item-label">{t("start.power.shutdown")}</span>
                  </div>
                  </div>
                </div>
              </div>
              <div className="menu-divider" />
              {nectarOptionsMenu(openSubmenuLeft)}
            </>
          ) : contextMenu.shortcut ? (
            <>
              {contextMenu.shortcut.kind === "recycle" && (
                <>
                  <div className="menu-item" onClick={() => { bridgeInvoke('open_dock_extra', { target: 'recycle' }).catch(() => {}); closeMenu(); }}>
                    <span className="menu-item-icon"><ExternalLink size={14} /></span>
                    <span className="menu-item-label">{t("start.ctx.open")}</span>
                  </div>
                  <div
                    className="menu-item quit"
                    onClick={async () => {
                      closeMenu();
                      try {
                        await bridgeInvoke('empty_recycle_bin');
                      } catch (err) {
                        showDockToast(typeof err === 'string' ? err : tr('dock.shortcut.emptyBinFail', 'Could not empty Recycle Bin'), 3500);
                      }
                    }}
                  >
                    <span className="menu-item-icon"><Trash2 size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.emptyRecycleBin")}</span>
                  </div>
                  <div className="menu-item" onClick={() => { bridgeInvoke('open_app_properties', { appPath: 'recycle', hwnd: null }).catch(() => showDockToast(t("dockmenu.propertiesUnavailable"), 3500)); closeMenu(); }}>
                    <span className="menu-item-icon"><Info size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.properties")}</span>
                  </div>
                </>
              )}
              {contextMenu.shortcut.kind === "drive" && (() => {
                const letter = (contextMenu.shortcut as { kind: "drive"; letter: string }).letter;
                const drivePath = `${letter}:\\`;
                return (
                  <>
                    <div className="menu-item" onClick={() => { bridgeInvoke('open_dock_extra', { target: letter }).catch(() => {}); closeMenu(); }}>
                      <span className="menu-item-icon"><HardDrive size={14} /></span>
                      <span className="menu-item-label">{t("dock.drive", { letter })}</span>
                    </div>
                    <div className="menu-item" onClick={() => { bridgeInvoke('open_app_properties', { appPath: drivePath, hwnd: null }).catch(() => showDockToast(t("dockmenu.propertiesUnavailable"), 3500)); closeMenu(); }}>
                      <span className="menu-item-icon"><Info size={14} /></span>
                      <span className="menu-item-label">{t("dockmenu.properties")}</span>
                    </div>
                    <div className="menu-item" onClick={() => { handleOpenWindowsTool("disk_management"); closeMenu(); }}>
                      <span className="menu-item-icon"><Sliders size={14} /></span>
                      <span className="menu-item-label">{t("dockmenu.winDiskManagement")}</span>
                    </div>
                  </>
                );
              })()}
              {contextMenu.shortcut.kind === "tray" && (
                <>
                  <div className="menu-item" onClick={() => { bridgeInvoke('open_native_tray').catch(() => {}); closeMenu(); }}>
                    <span className="menu-item-icon"><ExternalLink size={14} /></span>
                    <span className="menu-item-label">{t("traybar.nativeTray")}</span>
                  </div>
                  <div className="menu-item" onClick={() => { handleOpenWindowsTool("notif_settings"); closeMenu(); }}>
                    <span className="menu-item-icon"><Bell size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.notificationSettings")}</span>
                  </div>
                </>
              )}
              {contextMenu.shortcut.kind === "search" && (
                <>
                  <div className="menu-item" onClick={() => { bridgeInvoke('open_app', { appName: 'search' }).catch(() => {}); closeMenu(); }}>
                    <span className="menu-item-icon"><SearchLucide size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.search")}</span>
                  </div>
                  <div className="menu-item" onClick={() => { handleOpenWindowsTool("win_settings"); closeMenu(); }}>
                    <span className="menu-item-icon"><Settings size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.winSettings")}</span>
                  </div>
                </>
              )}
              {contextMenu.shortcut.kind === "calendar" && (
                <>
                  <div className="menu-item" onClick={() => { bridgeInvoke('open_calendar_window').catch(() => {}); closeMenu(); }}>
                    <span className="menu-item-icon"><ExternalLink size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.openCalendar")}</span>
                  </div>
                  <div className="menu-item" onClick={() => { bridgeInvoke('open_app', { appName: 'ms-settings:dateandtime' }).catch(() => {}); closeMenu(); }}>
                    <span className="menu-item-icon"><Settings size={14} /></span>
                    <span className="menu-item-label">{t("dockmenu.dateTimeSettings")}</span>
                  </div>
                </>
              )}
              <div className="menu-divider" />
              {nectarOptionsMenu(openSubmenuLeft)}
            </>
          ) : (
            <>
              <div className="menu-item" onClick={() => { bridgeInvoke('open_app', { appName: 'taskmgr' }); closeMenu(); }}>
                <span className="menu-item-icon"><Activity size={14} /></span>
                <span className="menu-item-label">{t("dockmenu.taskManager")}</span>
              </div>
              <div className="menu-item" onClick={() => { bridgeInvoke('show_desktop'); closeMenu(); }}>
                <span className="menu-item-icon"><Minimize2 size={14} /></span>
                <span className="menu-item-label">{t("dockmenu.showDesktop")}</span>
              </div>
              <div className="menu-item" onClick={() => { handleOpenWindowsTool("win_settings"); closeMenu(); }}>
                <span className="menu-item-icon"><Settings size={14} /></span>
                <span className="menu-item-label">{t("dockmenu.winSettings")}</span>
              </div>
              <div className="menu-item" onClick={() => { handleOpenWindowsTool("run_dialog"); closeMenu(); }}>
                <span className="menu-item-icon"><Play size={14} /></span>
                <span className="menu-item-label">{t("dockmenu.winRun")}</span>
              </div>
              <div className="menu-divider" />
              <div className="menu-item" onClick={() => { setShowAddPopup(true); closeMenu(); }}>
                <span className="menu-item-icon"><Plus size={14} /></span>
                <span className="menu-item-label">{t("dockmenu.addApp")}</span>
              </div>
              {nectarOptionsMenu(openSubmenuLeft)}
            </>
          )}
        </div>
        </div>
      )}

      <input
        id="icon-file-input"
        type="file"
        accept=".png,.ico,.jpg,.jpeg,.svg,.bmp"
        style={{ display: 'none' }}
        onChange={handleIconFileSelect}
      />

      <AnimatePresence>
        {renameApp && (
          <RenamePopup
            containerRef={popupRef}
            app={renameApp}
            current={dockNames[itemKey(renameApp)] ?? ""}
            scale={scale}
            bottom={popupBottom}
            onSave={(name) => saveName(renameApp, name)}
            onClose={() => { setRenameApp(null); invoke('set_menu_open', { open: false, rect: null }).catch(() => {}); }}
          />
        )}
        {showAddPopup && (
          <AddAppPopup 
            containerRef={popupRef}
            onClose={closePopup} 
            onAdd={(app: AppInfo) => { togglePin(app); closePopup(); }}
            scale={scale}
            runningApps={activeApps}
            pinned={pinnedApps}
            bottom={popupBottom}
            excludedTintApps={excludedTintApps}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            className="dock-toast"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.2 }}
            style={{ zoom: scale }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

function RenamePopup({ app, current, containerRef, scale, bottom, onSave, onClose }: {
  app: AppInfo;
  current: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  scale: number;
  bottom: number;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(current || app.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke('set_window_keyboard_focus', { enabled: true })
      .catch(() => {})
      .finally(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    return () => {
      invoke('set_window_keyboard_focus', { enabled: false }).catch(() => {});
    };
  }, []);

  return (
    <div className="add-popup-anchor" style={{ zoom: scale, bottom }}>
      <motion.div
        ref={containerRef}
        className="add-app-popup rename-popup"
        style={{ transformOrigin: "bottom center" }}
        initial={{ opacity: 0, scaleY: 0 }}
        animate={{ opacity: 1, scaleY: 1 }}
        exit={{ opacity: 0, scaleY: 0, transition: { duration: 0.16, ease: "easeIn" } }}
        transition={{ opacity: { duration: 0.15 }, scaleY: { type: "spring", stiffness: 300, damping: 28, mass: 0.9 } }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="popup-search-row">
          <input
            ref={inputRef}
            type="text"
            className="popup-search-input"
            value={value}
            maxLength={40}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSave(value);
              if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div className="rename-actions">
          {current && <button type="button" className="rename-btn" onClick={() => onSave("")}>{t("dockmenu.renameReset")}</button>}
          <button type="button" className="rename-btn primary" onClick={() => onSave(value)}>{t("dockmenu.renameSave")}</button>
        </div>
      </motion.div>
    </div>
  );
}

function AddAppPopup({
  onClose,
  onAdd,
  containerRef,
  scale,
  runningApps,
  pinned,
  bottom,
  excludedTintApps,
}: {
  onClose: () => void;
  onAdd: (app: AppInfo) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  scale: number;
  runningApps: AppInfo[];
  pinned: AppInfo[];
  bottom: number;
  excludedTintApps: ReadonlySet<string>;
}) {
  const t = useT();
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [listIcons, setListIcons] = useState<Record<string, string | null>>({});
  const listIconsRef = useRef(listIcons);
  listIconsRef.current = listIcons;
  const inFlightIconsRef = useRef<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const browsingRef = useRef(false);

  const browseForProgram = async () => {
    browsingRef.current = true;
    try {
      const res = await invoke<[string, string] | null>("pick_program");
      if (res) onAdd({ name: res[0], path: res[1], icon: null, is_running: false });
    } catch (err) {
      console.error(err);
    } finally {
      browsingRef.current = false;
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 150);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    invoke('set_window_keyboard_focus', { enabled: true })
      .catch(() => {})
      .finally(() => inputRef.current?.focus());
    return () => {
      invoke('set_window_keyboard_focus', { enabled: false }).catch(() => {});
    };
  }, []);

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [debouncedSearch]);

  // Running apps that aren't pinned: already in memory, so the default view is instant.
  // Matching is fuzzy, a pinned .lnk and its running .exe are the same app.
  const runningSuggestions = useMemo(
    () => runningApps.filter((a) => a.path !== "start" && !pinned.some((p) => isSameApp(p, a))),
    [runningApps, pinned]
  );

  const sections = useMemo(() => {
    const s = debouncedSearch.trim().toLowerCase();
    // No query: running apps, then everything installed, minus what's pinned.
    // The backend already drops helper entries.
    if (!s) {
      const runningIds = new Set(runningSuggestions.map((a) => itemKey(a)));
      const rest = apps
        .filter(
          (a) =>
            a.path !== "start" &&
            !pinned.some((p) => isSameApp(p, a)) &&
            !runningIds.has(itemKey(a))
        )
        .slice(0, 60);
      const out: { title: string | null; items: AppInfo[] }[] = [];
      if (runningSuggestions.length > 0)
        out.push({ title: t("dockmenu.running"), items: runningSuggestions });
      if (rest.length > 0) out.push({ title: t("dockmenu.allApps"), items: rest });
      return out;
    }
    const starts: AppInfo[] = [];
    const contains: AppInfo[] = [];
    for (const a of apps) {
      // Search covers pinned apps too.
      if (a.path === "start") continue;
      const n = a.name.toLowerCase();
      if (n.startsWith(s)) starts.push(a);
      else if (n.includes(s)) contains.push(a);
    }
    const byName = (x: AppInfo, y: AppInfo) => x.name.localeCompare(y.name);
    starts.sort(byName);
    contains.sort(byName);
    return [{ title: null, items: [...starts, ...contains].slice(0, 50) }];
  }, [apps, debouncedSearch, pinned, runningSuggestions]);

  // Flat selectable list; section headers are not selectable.
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const flatIndex = useMemo(() => new Map(flat.map((a, i) => [a, i])), [flat]);

  // Keep selection in range as results narrow.
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  // Scroll on keyboard nav only, doing it on mount yanks the list.
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (!listRef.current) return;
    const row = listRef.current.querySelector(
      `[data-idx="${selectedIndex}"]`
    ) as HTMLElement | null;
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await invoke<AppInfo[]>("get_installed_apps");
        if (!cancelled) {
          setApps(res.sort((a, b) => a.name.localeCompare(b.name)));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flat.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const target = flat[selectedIndex];
        if (!target) return;
        // Already on the dock: just dismiss, never pin twice.
        if (pinned.some((p) => isSameApp(p, target))) onClose();
        else onAdd(target);
      }
    };
    const handleMouseDown = (e: MouseEvent) => {
      const popup = containerRef.current;
      if (popup && !popup.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleBlur = () => {
      if (!browsingRef.current) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("mousedown", handleMouseDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("mousedown", handleMouseDown, true);
    };
  }, [onClose, containerRef, flat, selectedIndex, onAdd, pinned]);

  // Fetch icons in parallel and apply them as one batch, deduplicating in-flight and negative results.
  useEffect(() => {
    let active = true;
    const seen = new Set<string>();
    const targets = flat.slice(0, 25).filter((a) => {
      if (!a.path || seen.has(a.path)) return false;
      seen.add(a.path);
      if (Object.prototype.hasOwnProperty.call(listIconsRef.current, a.path)) return false;
      if (inFlightIconsRef.current.has(a.path)) return false;
      return true;
    });
    if (targets.length === 0) return;

    const targetPaths = targets.map((a) => a.path);
    for (const p of targetPaths) inFlightIconsRef.current.add(p);

    Promise.all(
      targets.map(async (app) => {
        try {
          const icon = await invoke<string | null>("get_app_icon", { path: app.path });
          return [app.path, icon || null] as const;
        } catch (err) {
          console.error(err);
          return [app.path, null] as const;
        }
      })
    ).then((pairs) => {
      for (const p of targetPaths) inFlightIconsRef.current.delete(p);
      if (!active) return;
      const batch: Record<string, string | null> = {};
      for (const [path, icon] of pairs) {
        batch[path] = icon;
      }
      if (Object.keys(batch).length > 0) setListIcons((prev) => ({ ...prev, ...batch }));
    });

    return () => {
      active = false;
      for (const p of targetPaths) inFlightIconsRef.current.delete(p);
    };
  }, [flat]);

  return (
    <div className="add-popup-anchor" style={{ zoom: scale, bottom }}>
      <motion.div
        ref={containerRef}
        className="add-app-popup"
        style={{ transformOrigin: "bottom center" }}
        initial={{ opacity: 0, scaleY: 0 }}
        animate={{ opacity: 1, scaleY: 1 }}
        exit={{ opacity: 0, scaleY: 0, transition: { duration: 0.16, ease: "easeIn" } }}
        transition={{
          opacity: { duration: 0.15 },
          scaleY: { type: "spring", stiffness: 300, damping: 28, mass: 0.9 }
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="popup-search-row">
          <svg
            className="popup-search-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="popup-search-input"
            placeholder={t("dockmenu.searchApps")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="popup-apps-scroll" ref={listRef}>
          {loading ? (
            <div aria-hidden>
              {Array.from({ length: 8 }, (_, i) => (
                <div className="popup-app-row popup-skeleton-row" key={i}>
                  <div className="popup-app-icon popup-skeleton-box" />
                  <div className="popup-skeleton-line" />
                </div>
              ))}
            </div>
          ) : flat.length > 0 ? (
            sections.map((sec) => (
              <div key={sec.title ?? "all"}>
                {sec.title && <div className="popup-section-label">{sec.title}</div>}
                {sec.items.map((app) => {
                  const gi = flatIndex.get(app) ?? 0;
                  const icon = listIcons[app.path];
                  const alreadyPinned = pinned.some((p) => isSameApp(p, app));
                  const tintExcluded = isAppTintExcluded(app.path || app.name, excludedTintApps);
                  return (
                    <div
                      key={`${app.path}::${app.name}`}
                      data-idx={gi}
                      className={`popup-app-row${gi === selectedIndex ? " selected" : ""}${alreadyPinned ? " is-pinned" : ""}`}
                      onClick={() => (alreadyPinned ? onClose() : onAdd(app))}
                      onMouseEnter={() => setSelectedIndex(gi)}
                    >
                      <div className="popup-app-icon">
                        {icon ? (
                          <img
                            key={icon}
                            src={icon}
                            alt=""
                            className={!tintExcluded ? "nectar-tintable-icon" : undefined}
                            data-tint-excluded={tintExcluded ? "true" : undefined}
                            draggable={false}
                            style={{ opacity: 0 }}
                            onLoad={(e) => {
                              e.currentTarget.style.opacity = "1";
                            }}
                          />
                        ) : (
                          <span className="popup-app-initial">{app.name[0]}</span>
                        )}
                      </div>
                      <span className="popup-app-name">{app.name}</span>
                      <span className="popup-app-pin">{alreadyPinned ? "✓" : "+"}</span>
                    </div>
                  );
                })}
              </div>
            ))
          ) : (
            <div className="popup-empty">
              {debouncedSearch.trim()
                ? t("dockmenu.noResults")
                : t("dockmenu.emptyHint")}
            </div>
          )}
        </div>
        <div className="popup-browse-row" onClick={browseForProgram}>
          {t("dockmenu.browseProgram")}
        </div>
      </motion.div>
    </div>
  );
}

export default Dock;
