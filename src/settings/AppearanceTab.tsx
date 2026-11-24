import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  Palette,
  Droplet,
  Contrast,
  Droplets,
  Sun,
  Square,
  Maximize2,
  Layers,
  SwatchBook,
  Highlighter,
  BoxSelect,
  MonitorCheck,
  RefreshCw,
  Check,
  Sparkles,
  Sliders,
  Type,
  FileDown,
  Upload,
  Save,
  X,
  Image,
  Wand2,
  Shapes,
  Blend,
  FolderCog,
  AlertTriangle,
  RotateCcw,
  MousePointer,
  FolderOpen,
  Pin,
  EyeOff,
} from "lucide-react";
import { SettingRow } from "./SettingRow";
import { SettingSection } from "./SettingSection";
import { Dropdown } from "./Dropdown";
import { ColorPalettePicker, normalizeHex } from "./ColorPalettePicker";
import { useT } from "../i18n";
import { WindowsAccentSync } from "./WindowsAccentSync";
import { GlassWallpaper } from "./GlassWallpaper";
import { useSyncedSetting } from "./useSyncedSetting";
import { bridgeInvoke } from "../utils/tauriBridge";
import { DEFAULT_ACCENT_COLOR, THEME_PRESETS, hexToHsl, hslToHex, type ThemePreset } from "../theme";
import {
  buildThemeEnvelope,
  captureCurrentThemeSnapshot,
  MAX_CUSTOM_PRESETS,
  MAX_PRESET_NAME_LENGTH,
  parseCustomPresets,
  parseThemeEnvelope,
  type CustomThemePreset,
  type ThemeExportKey,
} from "../themePresets";
import {
  ICON_TILE_SHAPES,
  ICON_TINT_DEFAULTS,
  ICON_TINT_MODES,
  ICON_TINT_SOURCES,
  buildIconColorMatrixValues,
  parseExcludedTintApps,
  sanitizeIconHexColor,
  sanitizeIconTileShape,
  sanitizeIconTintMode,
  sanitizeIconTintSource,
  sanitizeIconTintStrength,
  type IconTileShape,
  type IconTintMode,
  type IconTintSource,
} from "../utils/iconTint";

const parseClampedFloat = (min: number, max: number, fallback: number) => (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? fallback));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 100) / 100)) : fallback;
};
const parseDensity = (v: unknown): string => {
  const s = String(v ?? "comfortable");
  return s === "compact" || s === "spacious" ? s : "comfortable";
};
const parseMotionSpeed = (v: unknown): string => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "1"));
  if (!Number.isFinite(n)) return "1";
  if (n <= 0.1) return "0";
  if (n <= 0.85) return "0.75";
  if (n >= 1.2) return "1.4";
  return "1";
};
const parseFontFamily = (v: unknown): string => {
  const s = String(v ?? "system");
  return s === "clean" || s === "rounded" || s === "mono" ? s : "system";
};
const parseMotionPreset = (v: unknown): MotionPreset => {
  const s = String(v ?? "springy");
  return s === "snappy" || s === "liquid" || s === "minimal" ? s : "springy";
};
const parseMenuStyle = (v: unknown): MenuStyle => {
  const s = String(v ?? "glass");
  return s === "frosted" || s === "solid" || s === "neon-rim" ? s : "glass";
};
const parseMenuHoverStyle = (v: unknown): MenuHoverStyle => {
  const s = String(v ?? "pill");
  return s === "accent-bar" || s === "glow" || s === "outline" ? s : "pill";
};
const parseIconMode = (v: unknown): IconTintMode =>
  sanitizeIconTintMode(typeof v === "string" ? v : v == null ? null : String(v));
const parseIconSource = (v: unknown): IconTintSource =>
  sanitizeIconTintSource(typeof v === "string" ? v : v == null ? null : String(v));
const parseIconShape = (v: unknown): IconTileShape =>
  sanitizeIconTileShape(typeof v === "string" ? v : v == null ? null : String(v));
const parseIconColor = (v: unknown): string =>
  sanitizeIconHexColor(typeof v === "string" ? v : null, ICON_TINT_DEFAULTS.color);
const parseIconStrength = (v: unknown): number =>
  sanitizeIconTintStrength(v == null ? null : String(v));
const parseWallpaperAccent = (v: unknown): string =>
  typeof v === "string" ? normalizeHex(v) ?? "" : "";
const parseExcludedList = (v: unknown): string[] => {
  if (Array.isArray(v)) return parseExcludedTintApps(JSON.stringify(v));
  return parseExcludedTintApps(typeof v === "string" ? v : null);
};
const serializeExcludedList = (list: string[]): string => JSON.stringify(list);
const parseCustomPresetList = (v: unknown): CustomThemePreset[] => parseCustomPresets(v);
const serializeCustomPresetList = (list: CustomThemePreset[]): string => JSON.stringify(list);

type MotionPreset = "snappy" | "springy" | "liquid" | "minimal";
type MenuStyle = "glass" | "frosted" | "solid" | "neon-rim";
type MenuHoverStyle = "pill" | "accent-bar" | "glow" | "outline";

const MOTION_PRESETS: readonly MotionPreset[] = ["snappy", "springy", "liquid", "minimal"];
const MENU_STYLES: readonly MenuStyle[] = ["glass", "frosted", "solid", "neon-rim"];
const MENU_HOVER_STYLES: readonly MenuHoverStyle[] = ["pill", "accent-bar", "glow", "outline"];

interface WallpaperPaletteResult {
  dominant: string;
  accent: string;
  surfaceDark: string;
  surfaceLight: string;
  secondary: string;
  swatches: string[];
  isDark: boolean;
  source: string;
}

interface WindowsIconTintReport {
  foldersUpdated: number;
  shortcutsUpdated: number;
  skipped: number;
  errors: string[];
}

interface WindowsIconBackupStatus {
  hasBackup: boolean;
  foldersCount: number;
  shortcutsCount: number;
  appliedMode?: string | null;
  appliedColor?: string | null;
}

const STYLES = ["solid", "frosted", "liquid", "material"];
const DEFAULT_SELECTION_COLOR = "#0a84ff";

function computeEffectiveBgHex(color: string, saturation: number, brightness: number): string {
  const safe = normalizeHex(color) ?? DEFAULT_ACCENT_COLOR;
  const hsl = hexToHsl(safe);
  const h = ((hsl.h % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, saturation * 100));
  const l = Math.max(0, Math.min(100, brightness * 100));
  return hslToHex(h, s, l);
}

function presetBackground(preset: ThemePreset): string {
  return computeEffectiveBgHex(preset.color, preset.saturation, preset.brightness);
}

function computePresetSwatchColors(preset: CustomThemePreset): { bgColor: string; dotColor: string } {
  const mode = preset.settings["nectar-theme-mode"] ?? "custom";
  const style = preset.settings["nectar-theme-style"] ?? "solid";
  const rawColor = preset.settings["nectar-theme-color"] ?? "#1c1c24";
  const sat = Number.parseFloat(preset.settings["nectar-theme-saturation"] ?? "0.45");
  const bright = Number.parseFloat(preset.settings["nectar-theme-brightness"] ?? "0.15");
  const safeSat = Number.isFinite(sat) ? sat : 0.45;
  const safeBright = Number.isFinite(bright) ? bright : 0.15;
  const accentMode = preset.settings["nectar-theme-accent"] ?? "mono";
  const rawAccent = normalizeHex(preset.settings["nectar-theme-accent-color"] ?? "") ?? DEFAULT_ACCENT_COLOR;

  let bgColor: string;
  if (style === "material") {
    const hsl = hexToHsl(rawAccent);
    const tint = Math.min(hsl.s, 60);
    bgColor = mode === "light" ? hslToHex(hsl.h, tint * 0.6, 95) : hslToHex(hsl.h, tint * 0.35, 12);
  } else if (mode === "light") {
    bgColor = "#f5f5f7";
  } else if (mode === "dark") {
    bgColor = "#14141a";
  } else {
    bgColor = computeEffectiveBgHex(rawColor, safeSat, safeBright);
  }

  const dotColor =
    accentMode === "mono" && style !== "material"
      ? mode === "light"
        ? "#27272a"
        : "#d4d4d8"
      : rawAccent;

  return { bgColor, dotColor };
}

function computePreviewTileStyle(
  mode: IconTintMode,
  hex: string,
  strength: number,
  shape: IconTileShape,
  isLight: boolean
): CSSProperties {
  const safeHex = sanitizeIconHexColor(hex);
  const r = Number.parseInt(safeHex.slice(1, 3), 16);
  const g = Number.parseInt(safeHex.slice(3, 5), 16);
  const b = Number.parseInt(safeHex.slice(5, 7), 16);
  const borderRadius =
    shape === "circle" ? "50%" : shape === "rounded" ? "20%" : shape === "none" ? "0px" : "27%";
  const isActive = mode !== "original" && strength > 0.01;

  if (!isActive || shape === "none") {
    return {
      borderRadius,
      background: "transparent",
      borderColor: "transparent",
      boxShadow: "none",
    };
  }

  if (mode === "dark-glass") {
    return {
      borderRadius,
      background: isLight ? "rgba(28, 28, 38, 0.86)" : "rgba(16, 16, 24, 0.82)",
      borderColor: `rgba(${r}, ${g}, ${b}, ${(0.28 * strength + 0.1).toFixed(3)})`,
      boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 4px 12px rgba(0, 0, 0, 0.32)",
    };
  }
  if (mode === "pastel") {
    const pr = Math.round(r + (255 - r) * 0.45);
    const pg = Math.round(g + (255 - g) * 0.45);
    const pb = Math.round(b + (255 - b) * 0.45);
    return {
      borderRadius,
      background: `rgba(${pr}, ${pg}, ${pb}, ${(isLight ? 0.34 : 0.22).toFixed(3)})`,
      borderColor: `rgba(${pr}, ${pg}, ${pb}, 0.36)`,
      boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.22)",
    };
  }
  if (mode === "duotone") {
    const dr = Math.round(r * 0.22);
    const dg = Math.round(g * 0.22);
    const db = Math.round(b * 0.26);
    return {
      borderRadius,
      background: `rgba(${dr}, ${dg}, ${db}, 0.82)`,
      borderColor: `rgba(${r}, ${g}, ${b}, 0.52)`,
      boxShadow: `0 2px 10px rgba(${r}, ${g}, ${b}, 0.24)`,
    };
  }
  return {
    borderRadius,
    background: `rgba(${r}, ${g}, ${b}, ${(isLight ? 0.18 : 0.22).toFixed(3)})`,
    borderColor: `rgba(${r}, ${g}, ${b}, ${(isLight ? 0.34 : 0.4).toFixed(3)})`,
    boxShadow: `inset 0 1px 0 rgba(255, 255, 255, ${isLight ? 0.35 : 0.14})`,
  };
}

function renderMiniDockGlyph(id: string) {
  switch (id) {
    case "explorer":
      return (
        <svg viewBox="0 0 36 36" width="24" height="24" aria-hidden="true">
          <defs>
            <linearGradient id="nectarPrevFld" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#ffd46b" />
              <stop offset="100%" stopColor="#d98719" />
            </linearGradient>
          </defs>
          <path d="M5 10.5C5 8.8 6.3 7.5 8 7.5H14.2L16.6 10.2H28C29.7 10.2 31 11.5 31 13.2V25.5C31 27.2 29.7 28.5 28 28.5H8C6.3 28.5 5 27.2 5 25.5V10.5Z" fill="url(#nectarPrevFld)" />
          <rect x="7.5" y="13.5" width="21" height="12.5" rx="2.5" fill="#fff7e2" fillOpacity="0.28" />
        </svg>
      );
    case "browser":
      return (
        <svg viewBox="0 0 36 36" width="24" height="24" aria-hidden="true">
          <defs>
            <linearGradient id="nectarPrevBrw" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#5cc8ff" />
              <stop offset="100%" stopColor="#1b6ef3" />
            </linearGradient>
          </defs>
          <circle cx="18" cy="18" r="12.5" fill="url(#nectarPrevBrw)" />
          <ellipse cx="18" cy="18" rx="5.5" ry="12" fill="none" stroke="#ffffff" strokeOpacity="0.72" strokeWidth="1.7" />
          <path d="M6.5 18H29.5" stroke="#ffffff" strokeOpacity="0.72" strokeWidth="1.7" />
          <circle cx="24" cy="12.5" r="2.6" fill="#7df9ff" />
        </svg>
      );
    case "terminal":
      return (
        <svg viewBox="0 0 36 36" width="24" height="24" aria-hidden="true">
          <rect x="4.5" y="6.5" width="27" height="23" rx="5.5" fill="#1e2430" stroke="#4ade80" strokeOpacity="0.55" strokeWidth="1.6" />
          <path d="M11 14.5L15.8 18.2L11 21.8" fill="none" stroke="#4ade80" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M18.5 22H25" stroke="#a7f3d0" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      );
    case "music":
      return (
        <svg viewBox="0 0 36 36" width="24" height="24" aria-hidden="true">
          <defs>
            <linearGradient id="nectarPrevMus" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#ff6b95" />
              <stop offset="100%" stopColor="#9333ea" />
            </linearGradient>
          </defs>
          <rect x="4.5" y="4.5" width="27" height="27" rx="8" fill="url(#nectarPrevMus)" />
          <path d="M22.5 11.5V21.5M22.5 11.5L15 13.5V23.2" fill="none" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="13.2" cy="23.5" r="2.6" fill="#ffffff" />
          <circle cx="20.7" cy="21.7" r="2.6" fill="#ffffff" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 36 36" width="24" height="24" aria-hidden="true">
          <defs>
            <linearGradient id="nectarPrevSet" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#94a3b8" />
              <stop offset="100%" stopColor="#475569" />
            </linearGradient>
          </defs>
          <circle cx="18" cy="18" r="12" fill="url(#nectarPrevSet)" />
          <circle cx="18" cy="18" r="6.5" fill="none" stroke="#f8fafc" strokeWidth="2.6" strokeDasharray="3.3 2.4" />
          <circle cx="18" cy="18" r="2.7" fill="#38bdf8" />
        </svg>
      );
  }
}

const MINI_DOCK_PREVIEW_APPS = [
  { id: "explorer", label: "Explorer", active: true },
  { id: "browser", label: "Browser", active: true },
  { id: "terminal", label: "Terminal", active: true },
  { id: "music", label: "Music", active: false },
  { id: "settings", label: "Settings", active: false },
] as const;

function hexToRgbaChannels(hex: string, alpha: number): string {
  const safe = normalizeHex(hex) ?? DEFAULT_SELECTION_COLOR;
  const r = parseInt(safe.slice(1, 3), 16);
  const g = parseInt(safe.slice(3, 5), 16);
  const b = parseInt(safe.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface MarqueeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const DEFAULT_MARQUEE: MarqueeBox = { left: 10, top: 14, width: 56, height: 72 };

function SelectionPreviewCard({ selectionColor }: { selectionColor: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const [marquee, setMarquee] = useState<MarqueeBox>(DEFAULT_MARQUEE);

  const toPercent = (clientX: number, clientY: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    return {
      x: Math.max(2, Math.min(98, ((clientX - rect.left) / rect.width) * 100)),
      y: Math.max(4, Math.min(96, ((clientY - rect.top) / rect.height) * 100)),
    };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = toPercent(e.clientX, e.clientY);
    originRef.current = pt;
    movedRef.current = false;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!originRef.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const pt = toPercent(e.clientX, e.clientY);
    const dx = Math.abs(pt.x - originRef.current.x);
    const dy = Math.abs(pt.y - originRef.current.y);
    if (dx > 1.5 || dy > 1.5) {
      movedRef.current = true;
      setMarquee({
        left: Math.min(originRef.current.x, pt.x),
        top: Math.min(originRef.current.y, pt.y),
        width: Math.max(4, dx),
        height: Math.max(6, dy),
      });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (originRef.current && !movedRef.current) {
      setMarquee(DEFAULT_MARQUEE);
    }
    originRef.current = null;
    movedRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const fillRgba = hexToRgbaChannels(selectionColor, 0.28);
  const borderRgba = hexToRgbaChannels(selectionColor, 0.85);

  return (
    <div
      ref={boxRef}
      className="selection-preview-box"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="img"
      aria-label={selectionColor.toUpperCase()}
    >
      <div className="selection-preview-icons" aria-hidden="true">
        <div className="selection-preview-icon">
          <span className="selection-preview-dot selection-preview-dot--a" />
          <i />
        </div>
        <div className="selection-preview-icon">
          <span className="selection-preview-dot selection-preview-dot--b" />
          <i />
        </div>
      </div>
      <div
        className="selection-marquee-demo"
        style={{
          left: `${marquee.left}%`,
          top: `${marquee.top}%`,
          width: `${marquee.width}%`,
          height: `${marquee.height}%`,
          backgroundColor: fillRgba,
          borderColor: borderRgba,
        }}
      />
    </div>
  );
}

interface AppearanceTabProps {
  themeMode: string;
  handleThemeModeChange: (mode: string) => void;
  themeColor: string;
  handleThemeColorChange: (color: string) => void;
  themeOpacity: number;
  handleOpacityChange: (val: number) => void;
  themePanelOpacity: number;
  handlePanelOpacityChange: (val: number) => void;
  themeSaturation: number;
  handleSaturationChange: (val: number) => void;
  themeBrightness: number;
  handleBrightnessChange: (val: number) => void;
  cornersEnabled: boolean;
  toggleCorners: () => void;
  scale: number;
  handleScaleChange: (val: number) => void;
  themeStyle: string;
  handleThemeStyleChange: (style: string) => void;
  themeAccent: string;
  handleAccentChange: (accent: string) => void;
  themeAccentColor: string;
  handleAccentColorChange: (color: string) => void;
  applyThemePreset: (preset: ThemePreset) => void;
  applyThemeSettingsMap: (
    rawMap: Partial<Record<ThemeExportKey, string>> | Record<string, unknown>,
    extraEntries?: Record<string, string | null>
  ) => void;
  selectionColor: string;
  handleSelectionColorChange: (hex: string) => void;
  resetSelectionColor: () => void;
  syncWindowsSelection: boolean;
  toggleSyncWindowsSelection: () => void;
  selectionSyncError: string;
  selectionNeedsExplorerRefresh: boolean;
  explorerRefreshState: "idle" | "refreshing";
  explorerRefreshDone: boolean;
  refreshDesktopSelection: () => void;
  legacyMode: boolean;
}

export function AppearanceTab({
  themeMode,
  handleThemeModeChange,
  themeColor,
  handleThemeColorChange,
  themeOpacity,
  handleOpacityChange,
  themePanelOpacity,
  handlePanelOpacityChange,
  themeSaturation,
  handleSaturationChange,
  themeBrightness,
  handleBrightnessChange,
  cornersEnabled,
  toggleCorners,
  scale,
  handleScaleChange,
  themeStyle,
  handleThemeStyleChange,
  themeAccent,
  handleAccentChange,
  themeAccentColor,
  handleAccentColorChange,
  applyThemePreset,
  applyThemeSettingsMap,
  selectionColor,
  handleSelectionColorChange,
  resetSelectionColor,
  syncWindowsSelection,
  toggleSyncWindowsSelection,
  selectionSyncError,
  selectionNeedsExplorerRefresh,
  explorerRefreshState,
  explorerRefreshDone,
  refreshDesktopSelection,
  legacyMode,
}: AppearanceTabProps) {
  const t = useT();
  const [customPresets, setCustomPresets] = useSyncedSetting(
    "nectar-custom-presets",
    parseCustomPresetList,
    serializeCustomPresetList
  );
  const [presetName, setPresetName] = useState("");
  const [themeIoNote, setThemeIoNote] = useState<string | null>(null);
  const themeIoTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const [glassBlur, setGlassBlur] = useSyncedSetting("nectar-glass-blur", parseClampedFloat(0, 2, 1), (v) => String(v), { debounceMs: 120 });
  const [edgeIntensity, setEdgeIntensity] = useSyncedSetting("nectar-edge-intensity", parseClampedFloat(0, 2, 1), (v) => String(v), { debounceMs: 120 });
  const [radiusScale, setRadiusScale] = useSyncedSetting("nectar-radius-scale", parseClampedFloat(0.6, 1.35, 1), (v) => String(v), { debounceMs: 120 });
  const [uiDensity, setUiDensity] = useSyncedSetting("nectar-ui-density", parseDensity, (v) => v);
  const [motionSpeed, setMotionSpeed] = useSyncedSetting("nectar-motion-speed", parseMotionSpeed, (v) => v);
  const [fontFamily, setFontFamily] = useSyncedSetting("nectar-font-family", parseFontFamily, (v) => v);

  // Wave 9: Wallpaper palette, Unified Icon Palette & Menus/Motion
  const [wallpaperAccent] = useSyncedSetting("nectar-wallpaper-accent", parseWallpaperAccent, (v) => v);
  const [iconTintMode, setIconTintMode] = useSyncedSetting("nectar-icon-tint-mode", parseIconMode, (v) => v);
  const [iconTintSource, setIconTintSource] = useSyncedSetting("nectar-icon-tint-source", parseIconSource, (v) => v);
  const [iconTintColor, setIconTintColor] = useSyncedSetting("nectar-icon-tint-color", parseIconColor, (v) => v);
  const [iconTintStrength, setIconTintStrength] = useSyncedSetting(
    "nectar-icon-tint-strength",
    parseIconStrength,
    (v) => v.toFixed(2),
    { debounceMs: 100 }
  );
  const [iconTileShape, setIconTileShape] = useSyncedSetting("nectar-icon-tile-shape", parseIconShape, (v) => v);
  const [excludedApps, setExcludedApps] = useSyncedSetting(
    "nectar-icon-tint-excluded",
    parseExcludedList,
    serializeExcludedList
  );
  const [motionPreset, setMotionPreset] = useSyncedSetting("nectar-motion-preset", parseMotionPreset, (v) => v);
  const [menuStyle, setMenuStyle] = useSyncedSetting("nectar-menu-style", parseMenuStyle, (v) => v);
  const [menuHoverStyle, setMenuHoverStyle] = useSyncedSetting("nectar-menu-hover-style", parseMenuHoverStyle, (v) => v);

  const [extractedPalette, setExtractedPalette] = useState<WallpaperPaletteResult | null>(null);
  const [selectedSwatch, setSelectedSwatch] = useState<string | null>(null);
  const [paletteBusy, setPaletteBusy] = useState(false);
  const [paletteError, setPaletteError] = useState<string | null>(null);
  const [paletteNote, setPaletteNote] = useState<string | null>(null);
  const paletteTimerRef = useRef<number | null>(null);

  const [applyFolders, setApplyFolders] = useState(true);
  const [applyDesktopShortcuts, setApplyDesktopShortcuts] = useState(true);
  const [backupStatus, setBackupStatus] = useState<WindowsIconBackupStatus | null>(null);
  const [winIconBusy, setWinIconBusy] = useState<"apply" | "restore" | null>(null);
  const [winIconNote, setWinIconNote] = useState<string | null>(null);
  const [winIconError, setWinIconError] = useState<string | null>(null);
  const winIconTimerRef = useRef<number | null>(null);

  const [bouncingPreviewIdx, setBouncingPreviewIdx] = useState<number | null>(null);
  const previewBounceTimerRef = useRef<number | null>(null);
  const [menuHoveredIdx, setMenuHoveredIdx] = useState<number>(1);
  const [menuPopEpoch, setMenuPopEpoch] = useState<number>(0);

  const [liveThemeState, setLiveThemeState] = useState<{ accent: string; isLight: boolean }>(() => {
    if (typeof document === "undefined") {
      return { accent: DEFAULT_ACCENT_COLOR, isLight: false };
    }
    const root = document.documentElement;
    const cssAccent = normalizeHex(getComputedStyle(root).getPropertyValue("--nectar-accent").trim());
    return {
      accent: cssAccent ?? normalizeHex(themeAccentColor) ?? DEFAULT_ACCENT_COLOR,
      isLight: root.classList.contains("light-mode"),
    };
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const ref of [themeIoTimerRef, paletteTimerRef, winIconTimerRef, previewBounceTimerRef]) {
        if (ref.current !== null) {
          window.clearTimeout(ref.current);
          ref.current = null;
        }
      }
    };
  }, []);

  useEffect(() => {
    const syncLiveTokens = () => {
      if (!mountedRef.current || typeof document === "undefined") return;
      const root = document.documentElement;
      const cssAccent = normalizeHex(getComputedStyle(root).getPropertyValue("--nectar-accent").trim());
      setLiveThemeState({
        accent: cssAccent ?? normalizeHex(themeAccentColor) ?? DEFAULT_ACCENT_COLOR,
        isLight: root.classList.contains("light-mode"),
      });
    };
    syncLiveTokens();
    window.addEventListener("nectar-theme-applied", syncLiveTokens);
    return () => window.removeEventListener("nectar-theme-applied", syncLiveTokens);
  }, [themeMode, themeStyle, themeAccent, themeAccentColor]);

  const refreshBackupStatus = useCallback(async () => {
    try {
      const status = await bridgeInvoke<WindowsIconBackupStatus>("windows_icons_backup_status");
      if (mountedRef.current && status && typeof status === "object") {
        setBackupStatus(status);
      }
    } catch {
      // Keep existing backup state if backend command is unavailable
    }
  }, []);

  useEffect(() => {
    void refreshBackupStatus();
  }, [refreshBackupStatus]);

  const flashIoNote = (msg: string) => {
    if (!mountedRef.current) return;
    setThemeIoNote(msg);
    if (themeIoTimerRef.current !== null) {
      window.clearTimeout(themeIoTimerRef.current);
    }
    themeIoTimerRef.current = window.setTimeout(() => {
      themeIoTimerRef.current = null;
      if (mountedRef.current) setThemeIoNote(null);
    }, 2600);
  };

  const flashPaletteNote = (msg: string) => {
    if (!mountedRef.current) return;
    setPaletteNote(msg);
    if (paletteTimerRef.current !== null) {
      window.clearTimeout(paletteTimerRef.current);
    }
    paletteTimerRef.current = window.setTimeout(() => {
      paletteTimerRef.current = null;
      if (mountedRef.current) setPaletteNote(null);
    }, 2800);
  };

  const flashWinIconNote = (msg: string) => {
    if (!mountedRef.current) return;
    setWinIconNote(msg);
    if (winIconTimerRef.current !== null) {
      window.clearTimeout(winIconTimerRef.current);
    }
    winIconTimerRef.current = window.setTimeout(() => {
      winIconTimerRef.current = null;
      if (mountedRef.current) setWinIconNote(null);
    }, 4500);
  };

  const handleExtractWallpaperPalette = async () => {
    if (paletteBusy) return;
    setPaletteBusy(true);
    setPaletteError(null);
    setPaletteNote(null);
    try {
      const res = await bridgeInvoke<WallpaperPaletteResult>("extract_wallpaper_palette");
      if (!mountedRef.current) return;
      if (!res || !Array.isArray(res.swatches) || res.swatches.length === 0) {
        setPaletteError(t("appearance.wallpaperPalette.error"));
        return;
      }
      const cleanSwatches = res.swatches
        .map((s) => normalizeHex(s))
        .filter((s): s is string => s !== null);
      if (cleanSwatches.length === 0) {
        setPaletteError(t("appearance.wallpaperPalette.error"));
        return;
      }
      const normalized: WallpaperPaletteResult = {
        ...res,
        dominant: normalizeHex(res.dominant) ?? cleanSwatches[0] ?? DEFAULT_ACCENT_COLOR,
        accent: normalizeHex(res.accent) ?? cleanSwatches[0] ?? DEFAULT_ACCENT_COLOR,
        surfaceDark: normalizeHex(res.surfaceDark) ?? "#16161d",
        surfaceLight: normalizeHex(res.surfaceLight) ?? "#f4f4f8",
        secondary: normalizeHex(res.secondary) ?? cleanSwatches[1] ?? DEFAULT_ACCENT_COLOR,
        swatches: cleanSwatches.slice(0, 5),
      };
      setExtractedPalette(normalized);
      setSelectedSwatch(normalized.accent);
    } catch (e) {
      if (!mountedRef.current) return;
      setPaletteError(typeof e === "string" ? e : e instanceof Error ? e.message : t("appearance.wallpaperPalette.error"));
    } finally {
      if (mountedRef.current) setPaletteBusy(false);
    }
  };

  const applyWallpaperColors = (
    chosenHex: string,
    palette: WallpaperPaletteResult,
    alsoIcons: boolean
  ) => {
    const accentHex = normalizeHex(chosenHex) ?? normalizeHex(palette.accent) ?? DEFAULT_ACCENT_COLOR;
    const surfaceHex =
      normalizeHex(palette.isDark ? palette.surfaceDark : palette.surfaceLight) ??
      normalizeHex(palette.dominant) ??
      accentHex;
    const hsl = hexToHsl(surfaceHex);
    const sat = Math.round(Math.max(0, Math.min(1, hsl.s / 100)) * 1000) / 1000;
    const bright = Math.round(Math.max(0, Math.min(1, hsl.l / 100)) * 1000) / 1000;

    const themeMap: Partial<Record<ThemeExportKey, string>> = {
      "nectar-theme-mode": "custom",
      "nectar-theme-color": surfaceHex,
      "nectar-theme-saturation": String(sat),
      "nectar-theme-brightness": String(bright),
      "nectar-theme-accent": "custom",
      "nectar-theme-accent-color": accentHex,
    };
    if (alsoIcons) {
      themeMap["nectar-icon-tint-source"] = "wallpaper";
      if (iconTintMode === "original") {
        themeMap["nectar-icon-tint-mode"] = "tinted";
      }
    }
    setSelectedSwatch(accentHex);
    setPaletteError(null);
    applyThemeSettingsMap(themeMap, {
      "nectar-wallpaper-accent": accentHex,
    });
    flashPaletteNote(t("appearance.wallpaperPalette.applied"));
  };

  const effectiveTintColor =
    iconTintSource === "custom"
      ? iconTintColor
      : iconTintSource === "wallpaper"
        ? wallpaperAccent || iconTintColor || liveThemeState.accent
        : liveThemeState.accent;

  const previewMatrix = buildIconColorMatrixValues(
    iconTintMode,
    effectiveTintColor,
    iconTintStrength,
    liveThemeState.isLight
  );
  const previewTileStyle = computePreviewTileStyle(
    iconTintMode,
    effectiveTintColor,
    iconTintStrength,
    iconTileShape,
    liveThemeState.isLight
  );
  const previewIconFilter =
    iconTintMode !== "original" && iconTintStrength > 0.01
      ? "url(#nectar-settings-icon-preview-filter)"
      : "none";

  const handleApplyWindowsIcons = async () => {
    if (winIconBusy || iconTintMode === "original" || (!applyFolders && !applyDesktopShortcuts)) return;
    setWinIconBusy("apply");
    setWinIconError(null);
    setWinIconNote(null);
    try {
      const report = await bridgeInvoke<WindowsIconTintReport>("apply_windows_icon_tint", {
        options: {
          mode: iconTintMode,
          colorHex: effectiveTintColor,
          strength: iconTintStrength,
          shape: iconTileShape,
          applyFolders,
          applyDesktopShortcuts,
        },
      });
      if (!mountedRef.current) return;
      await refreshBackupStatus();
      if (!mountedRef.current) return;
      if (report?.errors && report.errors.length > 0) {
        setWinIconError(report.errors.join("; "));
      }
      flashWinIconNote(
        t("appearance.icons.winApplied", {
          folders: report?.foldersUpdated ?? 0,
          shortcuts: report?.shortcutsUpdated ?? 0,
        })
      );
    } catch (e) {
      if (!mountedRef.current) return;
      setWinIconError(typeof e === "string" ? e : e instanceof Error ? e.message : t("appearance.icons.winError"));
    } finally {
      if (mountedRef.current) setWinIconBusy(null);
    }
  };

  const handleRestoreWindowsIcons = async () => {
    if (winIconBusy) return;
    setWinIconBusy("restore");
    setWinIconError(null);
    setWinIconNote(null);
    try {
      const report = await bridgeInvoke<WindowsIconTintReport>("restore_windows_icons");
      if (!mountedRef.current) return;
      await refreshBackupStatus();
      if (!mountedRef.current) return;
      if (report?.errors && report.errors.length > 0) {
        setWinIconError(report.errors.join("; "));
      }
      flashWinIconNote(
        t("appearance.icons.winRestored", {
          folders: report?.foldersUpdated ?? 0,
          shortcuts: report?.shortcutsUpdated ?? 0,
        })
      );
    } catch (e) {
      if (!mountedRef.current) return;
      setWinIconError(typeof e === "string" ? e : e instanceof Error ? e.message : t("appearance.icons.winError"));
    } finally {
      if (mountedRef.current) setWinIconBusy(null);
    }
  };

  const triggerPreviewBounce = (idx: number) => {
    setBouncingPreviewIdx(idx);
    if (previewBounceTimerRef.current !== null) {
      window.clearTimeout(previewBounceTimerRef.current);
    }
    previewBounceTimerRef.current = window.setTimeout(() => {
      previewBounceTimerRef.current = null;
      if (mountedRef.current) setBouncingPreviewIdx(null);
    }, 520);
  };

  const handleSaveCustomPreset = () => {
    const cleanName = presetName.trim().slice(0, MAX_PRESET_NAME_LENGTH);
    if (!cleanName || customPresets.length >= MAX_CUSTOM_PRESETS) return;
    const settings = captureCurrentThemeSnapshot();
    const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const next: CustomThemePreset[] = [
      ...customPresets,
      { id, name: cleanName, createdAt: Date.now(), settings },
    ];
    void setCustomPresets(next);
    setPresetName("");
    flashIoNote(t("appearance.customPresets.saved", { name: cleanName }));
  };

  const handleExportTheme = async () => {
    const defaultName = presetName.trim() || "nectar-theme";
    const payloadJson = JSON.stringify(buildThemeEnvelope(defaultName), null, 2);
    try {
      const saved = await bridgeInvoke<boolean>("export_theme_dialog", {
        payloadJson,
        defaultName,
      });
      if (mountedRef.current && saved) {
        flashIoNote(t("appearance.themeIo.exported"));
      }
    } catch {
      if (mountedRef.current) flashIoNote(t("appearance.themeIo.error"));
    }
  };

  const handleImportTheme = async () => {
    try {
      const raw = await bridgeInvoke<string | null>("import_theme_dialog");
      if (!mountedRef.current || !raw) return;
      const env = parseThemeEnvelope(raw);
      if (!env) {
        flashIoNote(t("appearance.themeIo.invalid"));
        return;
      }
      applyThemeSettingsMap(env.settings);
      flashIoNote(t("appearance.themeIo.imported", { name: env.name }));
    } catch {
      if (mountedRef.current) flashIoNote(t("appearance.themeIo.invalid"));
    }
  };
  const isMaterial = !legacyMode && themeStyle === "material";
  const showCustomColor = themeMode === "custom";
  // Material You builds the whole palette from the accent, so these don't apply there.
  const showAdvancedSliders = !isMaterial && (themeMode === "custom" || themeMode === "adaptive");
  const effectiveBgHex = computeEffectiveBgHex(themeColor, themeSaturation, themeBrightness);
  const isActivePreset = (preset: ThemePreset) =>
    themeMode === "custom" &&
    themeColor.toLowerCase() === preset.color.toLowerCase() &&
    Math.abs(themeSaturation - preset.saturation) < 0.01 &&
    Math.abs(themeBrightness - preset.brightness) < 0.01;

  return (
    <>
      <SettingSection id="appearance-theme" title={t("appearance.theme.group")} defaultOpen>
        {!legacyMode && (
          <>
            <SettingRow icon={Layers} label={t("appearance.style")} desc={t("appearance.style.desc")} divider={false} />
            <div className="style-tiles" role="radiogroup" aria-label={t("appearance.style")}>
              {STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  role="radio"
                  aria-checked={themeStyle === style}
                  className={`style-tile${themeStyle === style ? " active" : ""}`}
                  onClick={() => handleThemeStyleChange(style)}
                >
                  <span className={`style-tile-preview style-preview-${style}`}>
                    <span className="style-tile-pill">
                      <i />
                      <i />
                    </span>
                    <span className="style-tile-dock">
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                  </span>
                  <span className="style-tile-label">{t(`appearance.style.${style}`)}</span>
                </button>
              ))}
            </div>
            <div className="setting-divider" />
            {(themeStyle === "frosted" || themeStyle === "liquid") && <GlassWallpaper />}
          </>
        )}

        <SettingRow icon={Palette} label={t("appearance.mode")} desc={t("appearance.mode.desc")}>
          <Dropdown
            value={themeMode}
            onChange={handleThemeModeChange}
            options={[
              { value: "auto", label: t("appearance.mode.auto") },
              { value: "dark", label: t("appearance.mode.dark") },
              { value: "light", label: t("appearance.mode.light") },
              { value: "custom", label: t("appearance.mode.custom") },
              { value: "adaptive", label: t("appearance.mode.adaptive") },
            ]}
          />
        </SettingRow>

        <SettingRow
          icon={Image}
          label={t("appearance.wallpaperPalette")}
          desc={t("appearance.wallpaperPalette.desc")}
          settingKey="appearance.wallpaperPalette"
          divider={!extractedPalette && !paletteError && !paletteNote}
        >
          <button
            type="button"
            className="agent-sound-btn"
            disabled={paletteBusy}
            onClick={() => void handleExtractWallpaperPalette()}
          >
            <Wand2 size={12} strokeWidth={2} />
            <span>
              {paletteBusy
                ? t("appearance.wallpaperPalette.extracting")
                : t("appearance.wallpaperPalette.extract")}
            </span>
          </button>
        </SettingRow>

        {(extractedPalette || paletteError || paletteNote) && (
          <>
            <div className="wallpaper-palette-wrap">
              {extractedPalette && (
                <div className="wallpaper-palette-card">
                  <div className="wallpaper-palette-top">
                    <span className="wallpaper-palette-source">
                      {t("appearance.wallpaperPalette.source", { source: extractedPalette.source })}
                    </span>
                    <button
                      type="button"
                      className="agent-sound-btn"
                      onClick={() =>
                        applyWallpaperColors(
                          selectedSwatch ?? extractedPalette.accent,
                          extractedPalette,
                          true
                        )
                      }
                    >
                      <Sparkles size={12} strokeWidth={2} />
                      <span>{t("appearance.wallpaperPalette.apply")}</span>
                    </button>
                  </div>
                  <div className="wallpaper-palette-swatches" role="group" aria-label={t("appearance.wallpaperPalette")}>
                    {extractedPalette.swatches.map((hex) => {
                      const active = selectedSwatch?.toLowerCase() === hex.toLowerCase();
                      return (
                        <button
                          key={hex}
                          type="button"
                          className={`wallpaper-swatch-btn${active ? " active" : ""}`}
                          style={{ background: hex }}
                          title={hex.toUpperCase()}
                          aria-label={t("appearance.wallpaperPalette.swatchAria", { hex: hex.toUpperCase() })}
                          onClick={() => applyWallpaperColors(hex, extractedPalette, false)}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
              {paletteNote && (
                <div className="wallpaper-palette-note" role="status">
                  <Check size={12} strokeWidth={2.2} />
                  <span>{paletteNote}</span>
                </div>
              )}
              {paletteError && (
                <div className="settings-inline-warning wallpaper-palette-error" role="alert">
                  <AlertTriangle size={13} />
                  <span>{paletteError}</span>
                </div>
              )}
            </div>
            <div className="setting-divider" />
          </>
        )}

        <SettingRow icon={SwatchBook} label={t("appearance.presets")} desc={t("appearance.presets.desc")} settingKey="appearance.presets" divider={false}>
          <div className="preset-swatches">
            {THEME_PRESETS.map((preset) => {
              const name = t(`appearance.preset.${preset.name.toLowerCase()}`);
              return (
                <button
                  key={preset.name}
                  type="button"
                  className={`preset-swatch${isActivePreset(preset) ? " active" : ""}`}
                  style={{ background: presetBackground(preset) }}
                  onClick={() => applyThemePreset(preset)}
                  title={name}
                  aria-label={name}
                >
                  <span style={{ background: preset.accent }} />
                </button>
              );
            })}
          </div>
        </SettingRow>

        <div className="custom-presets-wrap" data-setting-key="appearance.customPresets">
          <div className="custom-preset-form">
            <input
              type="text"
              className="custom-preset-input"
              maxLength={MAX_PRESET_NAME_LENGTH}
              value={presetName}
              placeholder={t("appearance.customPresets.placeholder")}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveCustomPreset();
              }}
            />
            <button
              type="button"
              className="agent-sound-btn"
              disabled={!presetName.trim() || customPresets.length >= MAX_CUSTOM_PRESETS}
              onClick={handleSaveCustomPreset}
            >
              <Save size={12} strokeWidth={2} />
              <span>{t("appearance.customPresets.save")}</span>
            </button>
          </div>
          {customPresets.length > 0 && (
            <div className="custom-preset-list">
              {customPresets.map((preset) => {
                const { bgColor, dotColor } = computePresetSwatchColors(preset);
                return (
                  <div key={preset.id} className="custom-preset-chip">
                    <button
                      type="button"
                      className="custom-preset-apply"
                      onClick={() => {
                        applyThemeSettingsMap(preset.settings);
                        flashIoNote(t("appearance.customPresets.applied", { name: preset.name }));
                      }}
                    >
                      <span className="custom-preset-swatch" style={{ background: bgColor }}>
                        <i style={{ background: dotColor }} />
                      </span>
                      <span className="custom-preset-name">{preset.name}</span>
                    </button>
                    <button
                      type="button"
                      className="custom-preset-del"
                      title={t("appearance.customPresets.delete")}
                      aria-label={t("appearance.customPresets.delete")}
                      onClick={() =>
                        void setCustomPresets(customPresets.filter((p) => p.id !== preset.id))
                      }
                    >
                      <X size={11} strokeWidth={2.2} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="theme-io-row" data-setting-key="appearance.themeIo">
            <div className="theme-io-actions">
              <button type="button" className="agent-sound-btn" onClick={handleExportTheme}>
                <FileDown size={12} strokeWidth={2} />
                <span>{t("appearance.themeIo.export")}</span>
              </button>
              <button type="button" className="agent-sound-btn" onClick={handleImportTheme}>
                <Upload size={12} strokeWidth={2} />
                <span>{t("appearance.themeIo.import")}</span>
              </button>
            </div>
            {themeIoNote && <span className="theme-io-note">{themeIoNote}</span>}
          </div>
        </div>
        <div className="setting-divider" />

        {!legacyMode && (
          <SettingRow
            icon={Highlighter}
            label={t("appearance.accent")}
            desc={isMaterial ? t("appearance.accent.descMaterial") : t("appearance.accent.desc")}
            settingKey="appearance.accent"
          >
            <Dropdown
              value={isMaterial && themeAccent === "mono" ? "system" : themeAccent}
              onChange={handleAccentChange}
              options={[
                ...(isMaterial ? [] : [{ value: "mono", label: t("appearance.accent.mono") }]),
                { value: "system", label: t("appearance.accent.system") },
                { value: "custom", label: t("appearance.accent.custom") },
                { value: "artwork", label: t("appearance.accent.artwork") },
              ]}
            />
          </SettingRow>
        )}

        {!legacyMode && themeAccent === "custom" && (
          <>
            <SettingRow icon={Droplet} label={t("appearance.accentColor")} desc={t("appearance.accentColor.desc")}>
              <ColorPalettePicker
                value={themeAccentColor}
                onChange={handleAccentColorChange}
                resetHex={DEFAULT_ACCENT_COLOR}
                onReset={() => handleAccentColorChange(DEFAULT_ACCENT_COLOR)}
                ariaLabel={t("appearance.accentColor")}
              />
            </SettingRow>
            <WindowsAccentSync color={themeAccentColor} />
          </>
        )}

        {showCustomColor && (
          <SettingRow icon={Droplet} label={t("appearance.color")} desc={t("appearance.color.desc")}>
            <ColorPalettePicker
              value={effectiveBgHex}
              fallbackHue={hexToHsl(normalizeHex(themeColor) ?? DEFAULT_ACCENT_COLOR).h}
              onChange={handleThemeColorChange}
              ariaLabel={t("appearance.color")}
            />
          </SettingRow>
        )}

        <SettingRow
          icon={BoxSelect}
          label={t("appearance.selectionColor")}
          desc={t("appearance.selectionColor.desc")}
          divider={false}
        >
          <ColorPalettePicker
            value={selectionColor}
            onChange={handleSelectionColorChange}
            resetHex={DEFAULT_SELECTION_COLOR}
            onReset={resetSelectionColor}
            ariaLabel={t("appearance.selectionColor")}
          />
        </SettingRow>

        <SelectionPreviewCard selectionColor={selectionColor} />
        {(syncWindowsSelection || selectionNeedsExplorerRefresh || explorerRefreshDone || selectionSyncError) && (
          <div
            className={`selection-desktop-bar${selectionNeedsExplorerRefresh ? " pending" : ""}`}
            role="status"
          >
            <span className={`selection-desktop-hint${selectionSyncError ? " error" : ""}`}>
              {selectionSyncError
                ? selectionSyncError
                : explorerRefreshDone
                  ? t("appearance.selectionRefreshed")
                  : selectionNeedsExplorerRefresh
                    ? t("appearance.selectionNeedsExplorer")
                    : t("appearance.selectionSyncedHint")}
            </span>
            <button
              type="button"
              className={`agent-sound-btn selection-desktop-btn${explorerRefreshDone ? " done" : ""}`}
              disabled={explorerRefreshState === "refreshing"}
              onClick={refreshDesktopSelection}
            >
              {explorerRefreshDone ? (
                <Check size={12} strokeWidth={2.2} />
              ) : (
                <RefreshCw size={12} strokeWidth={2} />
              )}
              <span>
                {explorerRefreshState === "refreshing"
                  ? t("appearance.selectionRefreshing")
                  : explorerRefreshDone
                    ? t("appearance.selectionRefreshedBtn")
                    : t("appearance.selectionApplyDesktopBtn")}
              </span>
            </button>
          </div>
        )}
        <div className="setting-divider" />

        <SettingRow
          icon={MonitorCheck}
          label={t("appearance.syncWindowsSelection")}
          desc={t("appearance.syncWindowsSelection.desc")}
        >
          <label className="toggle-switch">
            <input type="checkbox" checked={syncWindowsSelection} onChange={toggleSyncWindowsSelection} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow
          icon={Contrast}
          label={t("appearance.opacity")}
          desc={t("appearance.opacity.desc", { percent: Math.round(themeOpacity * 100) })}
          divider={showAdvancedSliders}
        >
          <input
            type="range"
            min="0.35"
            max="1.0"
            step="0.05"
            value={themeOpacity}
            onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
            className="settings-slider"
          />
        </SettingRow>

        <SettingRow
          icon={Layers}
          label={t("appearance.panelOpacity")}
          desc={t("appearance.panelOpacity.desc", { percent: Math.round(themePanelOpacity * 100) })}
          divider={false}
        >
          <input
            type="range"
            min="0.3"
            max="1.0"
            step="0.05"
            value={themePanelOpacity}
            onChange={(e) => handlePanelOpacityChange(parseFloat(e.target.value))}
            className="settings-slider"
          />
        </SettingRow>

        {showAdvancedSliders && (
          <>
            <SettingRow
              icon={Droplets}
              label={t("appearance.saturation")}
              desc={t("appearance.saturation.desc", { percent: Math.round(themeSaturation * 100) })}
            >
              <input
                type="range"
                min="0.0"
                max="1.0"
                step="0.02"
                value={themeSaturation}
                onChange={(e) => handleSaturationChange(parseFloat(e.target.value))}
                className="settings-slider"
              />
            </SettingRow>

            <SettingRow
              icon={Sun}
              label={t("appearance.brightness")}
              desc={t("appearance.brightness.desc", { percent: Math.round(themeBrightness * 100) })}
              divider={false}
            >
              <input
                type="range"
                min="0.0"
                max="1.0"
                step="0.02"
                value={themeBrightness}
                onChange={(e) => handleBrightnessChange(parseFloat(e.target.value))}
                className="settings-slider"
              />
            </SettingRow>
          </>
        )}
      </SettingSection>

      <SettingSection id="appearance-icons" title={t("appearance.icons.group")}>
        <svg
          aria-hidden="true"
          focusable="false"
          style={{
            position: "fixed",
            left: -9999,
            top: -9999,
            width: 0,
            height: 0,
            pointerEvents: "none",
            overflow: "hidden",
          }}
        >
          <defs>
            <filter id="nectar-settings-icon-preview-filter" colorInterpolationFilters="sRGB">
              <feColorMatrix type="matrix" values={previewMatrix} />
            </filter>
          </defs>
        </svg>

        <div className="icon-palette-preview-card">
          <div className="icon-palette-preview-header">
            <span className="icon-palette-preview-title">{t("appearance.icons.previewLabel")}</span>
            <span className="icon-palette-preview-sub">{t("appearance.icons.previewHint")}</span>
          </div>
          <div className="icon-preview-dock" role="group" aria-label={t("appearance.icons.previewLabel")}>
            {MINI_DOCK_PREVIEW_APPS.map((app, idx) => (
              <button
                key={app.id}
                type="button"
                className={`icon-preview-item${bouncingPreviewIdx === idx ? " bouncing" : ""}`}
                title={app.label}
                aria-label={app.label}
                onClick={() => triggerPreviewBounce(idx)}
              >
                <span className="icon-preview-tile" style={previewTileStyle}>
                  <span className="icon-preview-glyph" style={{ filter: previewIconFilter }}>
                    {renderMiniDockGlyph(app.id)}
                  </span>
                </span>
                <span className={`icon-preview-dot${app.active ? " active" : ""}`} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
        <div className="setting-divider" />

        <SettingRow
          icon={Sparkles}
          label={t("appearance.icons.mode")}
          desc={t("appearance.icons.mode.desc")}
          settingKey="appearance.icons.mode"
          stacked
        >
          <div className="segmented-pill-group" role="radiogroup" aria-label={t("appearance.icons.mode")}>
            {ICON_TINT_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={iconTintMode === mode}
                className={`segmented-pill-btn${iconTintMode === mode ? " active" : ""}`}
                onClick={() => void setIconTintMode(mode)}
              >
                {t(`appearance.icons.mode.${mode}`)}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow
          icon={Shapes}
          label={t("appearance.icons.shape")}
          desc={t("appearance.icons.shape.desc")}
          settingKey="appearance.icons.shape"
          stacked
        >
          <div className="segmented-pill-group" role="radiogroup" aria-label={t("appearance.icons.shape")}>
            {ICON_TILE_SHAPES.map((shape) => (
              <button
                key={shape}
                type="button"
                role="radio"
                aria-checked={iconTileShape === shape}
                className={`segmented-pill-btn${iconTileShape === shape ? " active" : ""}`}
                onClick={() => void setIconTileShape(shape)}
              >
                <span className={`icon-shape-badge icon-shape-badge--${shape}`} aria-hidden="true" />
                <span>{t(`appearance.icons.shape.${shape}`)}</span>
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow
          icon={Palette}
          label={t("appearance.icons.source")}
          desc={t("appearance.icons.source.desc")}
          settingKey="appearance.icons.source"
          stacked
        >
          <div className="segmented-pill-group" role="radiogroup" aria-label={t("appearance.icons.source")}>
            {ICON_TINT_SOURCES.map((source) => (
              <button
                key={source}
                type="button"
                role="radio"
                aria-checked={iconTintSource === source}
                className={`segmented-pill-btn${iconTintSource === source ? " active" : ""}`}
                onClick={() => void setIconTintSource(source)}
              >
                {t(`appearance.icons.source.${source}`)}
              </button>
            ))}
          </div>
        </SettingRow>

        {iconTintSource === "custom" && (
          <SettingRow
            icon={Droplet}
            label={t("appearance.icons.customColor")}
            desc={t("appearance.icons.customColor.desc")}
          >
            <ColorPalettePicker
              value={iconTintColor}
              onChange={(hex) => void setIconTintColor(hex)}
              resetHex={ICON_TINT_DEFAULTS.color}
              onReset={() => void setIconTintColor(ICON_TINT_DEFAULTS.color)}
              ariaLabel={t("appearance.icons.customColor")}
            />
          </SettingRow>
        )}

        {iconTintSource === "wallpaper" && (
          <>
            <SettingRow
              icon={Image}
              label={t("appearance.icons.wallpaperSwatch")}
              desc={
                wallpaperAccent
                  ? wallpaperAccent.toUpperCase()
                  : t("appearance.wallpaperPalette.desc")
              }
              divider={!paletteError}
            >
              <div className="icon-wallpaper-inline">
                <span
                  className="icon-wallpaper-dot"
                  style={{ background: effectiveTintColor }}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  className="agent-sound-btn"
                  disabled={paletteBusy}
                  onClick={() => void handleExtractWallpaperPalette()}
                >
                  <Wand2 size={12} strokeWidth={2} />
                  <span>
                    {paletteBusy
                      ? t("appearance.wallpaperPalette.extracting")
                      : t("appearance.wallpaperPalette.extract")}
                  </span>
                </button>
              </div>
            </SettingRow>
            {paletteError && (
              <>
                <div className="settings-inline-warning" role="alert">
                  <AlertTriangle size={13} />
                  <span>{paletteError}</span>
                </div>
                <div className="setting-divider" />
              </>
            )}
          </>
        )}

        <SettingRow
          icon={Blend}
          label={t("appearance.icons.strength")}
          desc={t("appearance.icons.strength.desc", { percent: Math.round(iconTintStrength * 100) })}
          settingKey="appearance.icons.strength"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={iconTintStrength}
              onChange={(e) => void setIconTintStrength(parseFloat(e.target.value))}
              className="settings-slider"
            />
            <span className="setting-value-badge">{Math.round(iconTintStrength * 100)}%</span>
          </div>
        </SettingRow>

        {excludedApps.length > 0 && (
          <SettingRow
            icon={EyeOff}
            label={t("appearance.icons.excluded", { count: excludedApps.length })}
            desc={t("appearance.icons.excluded.desc")}
            stacked
          >
            <div className="icon-excluded-list">
              {excludedApps.map((app) => (
                <span key={app} className="icon-excluded-chip">
                  <span className="icon-excluded-name">{app}</span>
                  <button
                    type="button"
                    className="icon-excluded-remove"
                    title={t("appearance.icons.excluded.remove", { name: app })}
                    aria-label={t("appearance.icons.excluded.remove", { name: app })}
                    onClick={() => void setExcludedApps(excludedApps.filter((item) => item !== app))}
                  >
                    <X size={11} strokeWidth={2.2} />
                  </button>
                </span>
              ))}
            </div>
          </SettingRow>
        )}

        <SettingRow
          icon={FolderCog}
          label={t("appearance.icons.windows")}
          desc={t("appearance.icons.windows.desc")}
          settingKey="appearance.icons.windows"
          divider={false}
          stacked
        >
          <div className="win-icons-panel">
            <div className="win-icons-checks">
              <label className="win-icons-check">
                <input
                  type="checkbox"
                  checked={applyFolders}
                  onChange={(e) => setApplyFolders(e.target.checked)}
                />
                <span>{t("appearance.icons.winFolders")}</span>
              </label>
              <label className="win-icons-check">
                <input
                  type="checkbox"
                  checked={applyDesktopShortcuts}
                  onChange={(e) => setApplyDesktopShortcuts(e.target.checked)}
                />
                <span>{t("appearance.icons.winShortcuts")}</span>
              </label>
            </div>

            <div className={`win-icons-backup-badge${backupStatus?.hasBackup ? " active" : ""}`}>
              <span>
                {backupStatus?.hasBackup
                  ? t("appearance.icons.winBackupActive", {
                      folders: backupStatus.foldersCount,
                      shortcuts: backupStatus.shortcutsCount,
                    })
                  : t("appearance.icons.winBackupNone")}
              </span>
            </div>

            {iconTintMode === "original" && (
              <div className="win-icons-hint">{t("appearance.icons.winOriginalHint")}</div>
            )}

            <div className="win-icons-actions">
              <button
                type="button"
                className="agent-sound-btn win-icons-apply-btn"
                disabled={
                  winIconBusy !== null ||
                  iconTintMode === "original" ||
                  (!applyFolders && !applyDesktopShortcuts)
                }
                onClick={() => void handleApplyWindowsIcons()}
              >
                <Sparkles size={12} strokeWidth={2} />
                <span>
                  {winIconBusy === "apply"
                    ? t("appearance.icons.winApplying")
                    : t("appearance.icons.winApply")}
                </span>
              </button>
              <button
                type="button"
                className="agent-sound-btn"
                disabled={winIconBusy !== null || (backupStatus !== null && !backupStatus.hasBackup)}
                onClick={() => void handleRestoreWindowsIcons()}
              >
                <RotateCcw size={12} strokeWidth={2} />
                <span>
                  {winIconBusy === "restore"
                    ? t("appearance.icons.winRestoring")
                    : t("appearance.icons.winRestore")}
                </span>
              </button>
            </div>

            {winIconNote && (
              <div className="win-icons-note" role="status">
                <Check size={12} strokeWidth={2.2} />
                <span>{winIconNote}</span>
              </div>
            )}

            {winIconError && (
              <div className="settings-inline-warning win-icons-error" role="alert">
                <AlertTriangle size={13} />
                <span>{winIconError}</span>
              </div>
            )}
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection id="appearance-menus" title={t("appearance.menus.group")}>
        <div className="menu-preview-stage">
          <div className="menu-preview-meta">
            <span>{t("appearance.menus.previewLabel")}</span>
          </div>
          <div key={menuPopEpoch} className="menu-preview-popover nectar-menu-pop" role="region" aria-label={t("appearance.menus.previewLabel")}>
            {[
              { icon: FolderOpen, key: "appearance.menus.previewItem1" },
              { icon: Pin, key: "appearance.menus.previewItem2" },
              { icon: EyeOff, key: "appearance.menus.previewItem3" },
            ].map(({ icon: ItemIcon, key }, idx) => (
              <button
                key={key}
                type="button"
                className={`menu-preview-item${menuHoveredIdx === idx ? " active" : ""}`}
                onMouseEnter={() => setMenuHoveredIdx(idx)}
                onFocus={() => setMenuHoveredIdx(idx)}
                onClick={() => setMenuHoveredIdx(idx)}
              >
                <ItemIcon size={13} strokeWidth={1.8} />
                <span>{t(key)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="setting-divider" />

        <SettingRow
          icon={Sparkles}
          label={t("appearance.menus.motionPreset")}
          desc={t("appearance.menus.motionPreset.desc")}
          settingKey="appearance.menus.motionPreset"
          stacked
        >
          <div className="segmented-pill-group" role="radiogroup" aria-label={t("appearance.menus.motionPreset")}>
            {MOTION_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={motionPreset === preset}
                className={`segmented-pill-btn${motionPreset === preset ? " active" : ""}`}
                onClick={() => {
                  void setMotionPreset(preset);
                  setMenuPopEpoch((n) => n + 1);
                }}
              >
                {t(`appearance.menus.motion.${preset}`)}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow
          icon={Layers}
          label={t("appearance.menus.style")}
          desc={t("appearance.menus.style.desc")}
          settingKey="appearance.menus.style"
          stacked
        >
          <div className="segmented-pill-group" role="radiogroup" aria-label={t("appearance.menus.style")}>
            {MENU_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                role="radio"
                aria-checked={menuStyle === style}
                className={`segmented-pill-btn${menuStyle === style ? " active" : ""}`}
                onClick={() => {
                  void setMenuStyle(style);
                  setMenuPopEpoch((n) => n + 1);
                }}
              >
                {t(`appearance.menus.style.${style}`)}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow
          icon={MousePointer}
          label={t("appearance.menus.hoverStyle")}
          desc={t("appearance.menus.hoverStyle.desc")}
          settingKey="appearance.menus.hoverStyle"
          divider={false}
          stacked
        >
          <div className="segmented-pill-group" role="radiogroup" aria-label={t("appearance.menus.hoverStyle")}>
            {MENU_HOVER_STYLES.map((hover) => (
              <button
                key={hover}
                type="button"
                role="radio"
                aria-checked={menuHoverStyle === hover}
                className={`segmented-pill-btn${menuHoverStyle === hover ? " active" : ""}`}
                onClick={() => void setMenuHoverStyle(hover)}
              >
                {t(`appearance.menus.hover.${hover}`)}
              </button>
            ))}
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection id="appearance-display" title={t("appearance.display.group")}>
        {!legacyMode && (themeStyle === "frosted" || themeStyle === "liquid") && (
          <SettingRow
            icon={Sparkles}
            label={t("appearance.glassBlur")}
            desc={t("appearance.glassBlur.desc", { percent: Math.round(glassBlur * 100) })}
            settingKey="appearance.glassBlur"
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={glassBlur}
                onChange={(e) => void setGlassBlur(parseFloat(e.target.value))}
                className="settings-slider"
              />
              <span className="setting-value-badge">{Math.round(glassBlur * 100)}%</span>
            </div>
          </SettingRow>
        )}

        <SettingRow
          icon={Sliders}
          label={t("appearance.edgeIntensity")}
          desc={t("appearance.edgeIntensity.desc", { percent: Math.round(edgeIntensity * 100) })}
          settingKey="appearance.edgeIntensity"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={edgeIntensity}
              onChange={(e) => void setEdgeIntensity(parseFloat(e.target.value))}
              className="settings-slider"
            />
            <span className="setting-value-badge">{Math.round(edgeIntensity * 100)}%</span>
          </div>
        </SettingRow>

        <SettingRow
          icon={Square}
          label={t("appearance.radiusScale")}
          desc={t("appearance.radiusScale.desc", { percent: Math.round(radiusScale * 100) })}
          settingKey="appearance.radiusScale"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="range"
              min="0.6"
              max="1.35"
              step="0.05"
              value={radiusScale}
              onChange={(e) => void setRadiusScale(parseFloat(e.target.value))}
              className="settings-slider"
            />
            <span className="setting-value-badge">{Math.round(radiusScale * 100)}%</span>
          </div>
        </SettingRow>

        <SettingRow icon={Layers} label={t("appearance.density")} desc={t("appearance.density.desc")} settingKey="appearance.density">
          <Dropdown
            value={uiDensity}
            onChange={(val) => void setUiDensity(val)}
            options={[
              { value: "compact", label: t("appearance.density.compact") },
              { value: "comfortable", label: t("appearance.density.comfortable") },
              { value: "spacious", label: t("appearance.density.spacious") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={RefreshCw} label={t("appearance.motionSpeed")} desc={t("appearance.motionSpeed.desc")} settingKey="appearance.motionSpeed">
          <Dropdown
            value={motionSpeed}
            onChange={(val) => void setMotionSpeed(val)}
            options={[
              { value: "0", label: t("appearance.motion.off") },
              { value: "1.4", label: t("appearance.motion.fast") },
              { value: "1", label: t("appearance.motion.normal") },
              { value: "0.75", label: t("appearance.motion.smooth") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={Type} label={t("appearance.fontFamily")} desc={t("appearance.fontFamily.desc")} settingKey="appearance.fontFamily">
          <Dropdown
            value={fontFamily}
            onChange={(val) => void setFontFamily(val)}
            options={[
              { value: "system", label: t("appearance.font.system") },
              { value: "clean", label: t("appearance.font.clean") },
              { value: "rounded", label: t("appearance.font.rounded") },
              { value: "mono", label: t("appearance.font.mono") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={Square} label={t("appearance.corners")} desc={t("appearance.corners.desc")} settingKey="appearance.corners">
          <label className="toggle-switch">
            <input type="checkbox" checked={cornersEnabled} onChange={toggleCorners} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow
          icon={Maximize2}
          label={t("appearance.scale")}
          desc={t("appearance.scale.desc", { percent: Math.round(scale * 100) })}
          settingKey="appearance.scale"
          divider={false}
        >
          <div className="scale-button-container">
            <button
              onClick={() => handleScaleChange(Math.max(0.8, parseFloat((scale - 0.1).toFixed(1))))}
              disabled={scale <= 0.8}
              className="scale-adjust-btn"
              title={t("appearance.scale.decrease")}
            >
              —
            </button>
            <span className="scale-display-value">{Math.round(scale * 100)}%</span>
            <button
              onClick={() => handleScaleChange(Math.min(1.3, parseFloat((scale + 0.1).toFixed(1))))}
              disabled={scale >= 1.3}
              className="scale-adjust-btn"
              title={t("appearance.scale.increase")}
            >
              +
            </button>
          </div>
        </SettingRow>
      </SettingSection>
    </>
  );
}
