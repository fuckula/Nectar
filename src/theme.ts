import { bridgeInvoke, bridgeListen } from "./utils/tauriBridge";
import { applyBackdrop, enableBackdrop, usesBackdrop } from "./backdrop";
import { clearLocalSettingWrites, isLocalSettingWriteActive } from "./hooks/useSettingsSync";
import { loadSettingsFromBackend } from "./utils/settingsHydration";
import { applyIconTintTokens } from "./utils/iconTint";
import { rgbStringToHex } from "./music/palette";

// Convert a hex color string to RGB components
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean.split('').map(char => char + char).join('');
  }
  return {
    r: parseInt(clean.substring(0, 2), 16) || 0,
    g: parseInt(clean.substring(2, 4), 16) || 0,
    b: parseInt(clean.substring(4, 6), 16) || 0,
  };
}

// Convert a hex color string to rgba with a specified alpha
function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface HSL {
  h: number;
  s: number;
  l: number;
}

// Convert Hex to HSL
export function hexToHsl(hex: string): HSL {
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = hex.split('').map(char => char + char).join('');
  }
  const r = (parseInt(hex.substring(0, 2), 16) || 0) / 255;
  const g = (parseInt(hex.substring(2, 4), 16) || 0) / 255;
  const b = (parseInt(hex.substring(4, 6), 16) || 0) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return {
    h: Math.round(h * 36000) / 100,
    s: Math.round(s * 10000) / 100,
    l: Math.round(l * 10000) / 100,
  };
}

// Convert HSL back to Hex color string
export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;

  if (0 <= h && h < 60) {
    r = c; g = x; b = 0;
  } else if (60 <= h && h < 120) {
    r = x; g = c; b = 0;
  } else if (120 <= h && h < 180) {
    r = 0; g = c; b = x;
  } else if (180 <= h && h < 240) {
    r = 0; g = x; b = c;
  } else if (240 <= h && h < 300) {
    r = x; g = 0; b = c;
  } else if (300 <= h && h < 360) {
    r = c; g = 0; b = x;
  }

  const toHex = (val: number) => {
    const hexVal = Math.round((val + m) * 255).toString(16);
    return hexVal.length === 1 ? '0' + hexVal : hexVal;
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export interface ThemePreset {
  name: string;
  color: string;
  saturation: number;
  brightness: number;
  accent: string;
}

// Background hue comes from `color`, kept low in saturation so surfaces stay calm; the accent is picked by eye.
export const THEME_PRESETS: ThemePreset[] = [
  { name: "Graphite", color: "#8e8e93", saturation: 0.04, brightness: 0.09, accent: "#0a84ff" },
  { name: "Midnight", color: "#5e8bff", saturation: 0.4, brightness: 0.1, accent: "#7aa2ff" },
  { name: "Ocean", color: "#2ec4d6", saturation: 0.45, brightness: 0.09, accent: "#35d0e0" },
  { name: "Forest", color: "#34c77b", saturation: 0.28, brightness: 0.09, accent: "#4ade80" },
  { name: "Plum", color: "#c77dff", saturation: 0.3, brightness: 0.11, accent: "#c58bff" },
  { name: "Rose", color: "#ff5e8a", saturation: 0.3, brightness: 0.11, accent: "#ff6b95" },
  { name: "Ember", color: "#ff7a45", saturation: 0.32, brightness: 0.1, accent: "#ff8a5c" },
  { name: "Latte", color: "#c0742d", saturation: 0.18, brightness: 0.95, accent: "#b8641c" },
  { name: "Mist", color: "#0a84ff", saturation: 0.2, brightness: 0.95, accent: "#0a6ee0" },
];

export const DEFAULT_ACCENT_COLOR = "#0a84ff";
export const DEFAULT_SELECTION_COLOR = "#0a84ff";

export const THEME_STYLES = ["solid", "frosted", "liquid", "material"] as const;

// Background opacity each style is designed around; picking a style sets it, the slider can still change it.
export const STYLE_OPACITY: Record<string, number> = {
  solid: 0.8,
  frosted: 0.6,
  liquid: 0.45,
  material: 0.96,
};

const FONT_STACKS: Record<"system" | "clean" | "rounded" | "mono", string> = {
  system: "'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
  clean: "'Inter', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
  rounded: "'SF Pro Rounded', 'Nunito', 'Segoe UI Variable Display', 'Quicksand', 'Segoe UI', ui-rounded, sans-serif",
  mono: "'Cascadia Mono', 'JetBrains Mono', 'Fira Code', Consolas, ui-monospace, monospace",
};

const darkScheme = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

// "auto" follows the Windows app mode (WebView2 reports it as prefers-color-scheme).
function resolveMode(mode: string): string {
  if (mode !== "auto") return mode;
  return darkScheme && !darkScheme.matches ? "light" : "dark";
}

// Relative sRGB luminance (0..1).
function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const channel = (i: number) => {
    const v = (parseInt(full.substring(i, i + 2), 16) || 0) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

// Black or white, whichever reads better on the given color.
function contrastText(hex: string): string {
  return relativeLuminance(hex) > 0.4 ? "#000000" : "#ffffff";
}

// Hysteresis deadband (0.34..0.44) prevents .light-mode flickering mid-drag.
function isLightSurfaceWithHysteresis(hex: string, prevLight: boolean): boolean {
  const lum = relativeLuminance(hex);
  return prevLight ? lum > 0.34 : lum > 0.44;
}

function isHex(color: string | null | undefined): color is string {
  return !!color && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color);
}

const hsla = (h: number, s: number, l: number, a = 1) => `hsla(${h}, ${s}%, ${l}%, ${a})`;

function safeFloat(raw: unknown, fallback: number): number {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : parseFloat(String(raw));
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function serializeSettingForStorage(value: unknown): string | null {
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

function extractMediaAccentHex(payload: unknown): string | null {
  if (typeof payload === "string") {
    return rgbStringToHex(payload);
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of [
      "media_accent",
      "mediaAccent",
      "media_accent_hex",
      "mediaAccentHex",
      "hex",
      "color",
      "accent",
    ]) {
      const candidate = obj[key];
      if (typeof candidate === "string") {
        const normalized = rgbStringToHex(candidate);
        if (normalized) return normalized;
      }
    }
  }
  return null;
}

let runtimeMediaAccentHex: string | null = null;

function applySurfaceTokens(root: HTMLElement, style: string, isLight: boolean) {
  const glassBlur = clamp(safeFloat(localStorage.getItem("nectar-glass-blur"), 1), 0, 2);
  root.style.setProperty("--nectar-glass-blur-mult", String(glassBlur));
  root.style.setProperty("--nectar-popover-blur", "calc(16px * var(--nectar-glass-blur-mult, 1))");

  const edgeIntensity = clamp(safeFloat(localStorage.getItem("nectar-edge-intensity"), 1), 0, 2);
  root.style.setProperty("--nectar-edge-intensity", String(edgeIntensity));

  const baseRimAlpha = isLight
    ? 0.14
    : style === "material"
      ? 0.16
      : style === "solid"
        ? 0.14
        : 0.22;
  const rimAlpha = clamp(baseRimAlpha * edgeIntensity, 0, 0.55);
  root.style.setProperty("--nectar-rim-alpha", rimAlpha.toFixed(3));

  if (style === "solid" && !isLight) {
    root.style.setProperty("--surface-outline", "transparent");
  } else if (isLight) {
    root.style.setProperty("--surface-outline", `rgba(0, 0, 0, ${rimAlpha.toFixed(3)})`);
  } else if (style === "material") {
    root.style.setProperty(
      "--surface-outline",
      "var(--nectar-border, rgba(255, 255, 255, 0.16))",
    );
  } else {
    root.style.setProperty("--surface-outline", `rgba(255, 255, 255, ${rimAlpha.toFixed(3)})`);
  }

  const radiusScale = clamp(safeFloat(localStorage.getItem("nectar-radius-scale"), 1), 0.6, 1.35);
  root.style.setProperty("--nectar-radius-scale", String(radiusScale));

  const rawDensity = localStorage.getItem("nectar-ui-density");
  const density =
    rawDensity === "compact" || rawDensity === "comfortable" || rawDensity === "spacious"
      ? rawDensity
      : "comfortable";
  root.dataset.density = density;

  const rawPreset = localStorage.getItem("nectar-motion-preset");
  const motionPreset =
    rawPreset === "snappy" || rawPreset === "springy" || rawPreset === "liquid" || rawPreset === "minimal"
      ? rawPreset
      : "springy";
  const presetDurationMult =
    motionPreset === "snappy"
      ? 0.78
      : motionPreset === "liquid"
        ? 1.28
        : motionPreset === "minimal"
          ? 0.65
          : 1;
  const presetEase =
    motionPreset === "snappy"
      ? "cubic-bezier(0.2, 0.9, 0.25, 1)"
      : motionPreset === "liquid"
        ? "cubic-bezier(0.16, 1, 0.3, 1)"
        : motionPreset === "minimal"
          ? "cubic-bezier(0.2, 0, 0, 1)"
          : "cubic-bezier(0.22, 1.15, 0.32, 1)";
  root.dataset.motionPreset = motionPreset;
  root.style.setProperty("--nectar-ease", presetEase);

  const motionSpeed = clamp(safeFloat(localStorage.getItem("nectar-motion-speed"), 1), 0, 1.5);
  const effectiveMotionScale =
    motionSpeed === 0 ? 0 : clamp(motionSpeed / presetDurationMult, 0.35, 2.2);
  root.style.setProperty("--nectar-motion-scale", String(effectiveMotionScale));
  root.classList.toggle("reduced-motion", motionSpeed === 0);

  const rawMenuStyle = localStorage.getItem("nectar-menu-style");
  root.dataset.menuStyle =
    rawMenuStyle === "glass" || rawMenuStyle === "frosted" || rawMenuStyle === "solid" || rawMenuStyle === "neon-rim"
      ? rawMenuStyle
      : "glass";

  const rawMenuHover = localStorage.getItem("nectar-menu-hover-style");
  root.dataset.menuHover =
    rawMenuHover === "pill" || rawMenuHover === "accent-bar" || rawMenuHover === "glow" || rawMenuHover === "outline"
      ? rawMenuHover
      : "pill";

  const rawDockIndicator = localStorage.getItem("nectar-dock-indicator");
  root.dataset.dockIndicator =
    rawDockIndicator === "dots" ||
    rawDockIndicator === "pill" ||
    rawDockIndicator === "bar" ||
    rawDockIndicator === "glow" ||
    rawDockIndicator === "fixed" ||
    rawDockIndicator === "none"
      ? rawDockIndicator
      : "dots";

  const rawFont = localStorage.getItem("nectar-font-family");
  const fontFamily: keyof typeof FONT_STACKS =
    rawFont === "system" || rawFont === "clean" || rawFont === "rounded" || rawFont === "mono"
      ? rawFont
      : "system";
  root.style.setProperty("--nectar-font-sans", FONT_STACKS[fontFamily]);
  root.dataset.font = fontFamily;

  const rawPerf = localStorage.getItem("nectar-perf-profile");
  const perfProfile =
    rawPerf === "balanced" || rawPerf === "eco" || rawPerf === "max"
      ? rawPerf
      : localStorage.getItem("nectar-ram-saver") === "true"
        ? "eco"
        : "balanced";
  root.dataset.perfProfile = perfProfile;
}

function applySelectionVariables(root: HTMLElement, resolvedAccent: string) {
  const customSel = localStorage.getItem("nectar-selection-color");
  const selHex = isHex(customSel)
    ? customSel
    : isHex(resolvedAccent)
      ? resolvedAccent
      : DEFAULT_SELECTION_COLOR;
  const { r, g, b } = hexToRgb(selHex);
  root.style.setProperty("--nectar-selection", selHex);
  root.style.setProperty("--nectar-selection-bg", `rgba(${r}, ${g}, ${b}, 0.28)`);
  root.style.setProperty("--nectar-selection-border", `rgba(${r}, ${g}, ${b}, 0.82)`);
}

// Material You style tonal palette: tinted surfaces and a pastel (dark) or deep (light) primary.
function applyMaterialPalette(root: HTMLElement, seed: string, light: boolean, op: number, opExpanded: number, opPanel: number) {
  const { h, s } = hexToHsl(seed);
  const tint = Math.min(s, 60);
  const set = (name: string, value: string) => root.style.setProperty(name, value);
  if (light) {
    set("--nectar-bg", hsla(h, tint * 0.6, 95, op));
    set("--nectar-bg-expanded", hsla(h, tint * 0.55, 92, opExpanded));
    set("--nectar-bg-panel", hsla(h, tint * 0.55, 92, opPanel));
    set("--nectar-bg-solid", hsla(h, tint * 0.55, 92, 1));
    set("--nectar-bg-elevated", hsla(h, tint * 0.55, 95, 0.96));
    set("--nectar-setting-window-bg", hsla(h, tint * 0.55, 93, 0.99));
    set("--nectar-text", hsla(h, 18, 12));
    set("--nectar-text-muted", hsla(h, 12, 28, 0.75));
    set("--nectar-border", hsla(h, 15, 30, 0.16));
    set("--nectar-group-bg", hsla(h, 35, 45, 0.08));
    set("--nectar-scrollbar-thumb", hsla(h, 15, 25, 0.22));
    set("--nectar-highlight", hsla(h, Math.max(s, 45), 38));
    set("--nectar-on-highlight", "#ffffff");
  } else {
    set("--nectar-bg", hsla(h, tint * 0.35, 9, op));
    set("--nectar-bg-expanded", hsla(h, tint * 0.35, 12, opExpanded));
    set("--nectar-bg-panel", hsla(h, tint * 0.35, 12, opPanel));
    set("--nectar-bg-solid", hsla(h, tint * 0.35, 12, 1));
    set("--nectar-bg-elevated", hsla(h, tint * 0.35, 14, 0.96));
    set("--nectar-setting-window-bg", hsla(h, tint * 0.35, 12, 0.98));
    set("--nectar-text", hsla(h, 25, 92));
    set("--nectar-text-muted", hsla(h, 14, 78, 0.8));
    set("--nectar-border", hsla(h, 18, 70, 0.16));
    set("--nectar-group-bg", hsla(h, 35, 70, 0.08));
    set("--nectar-scrollbar-thumb", hsla(h, 20, 80, 0.2));
    set("--nectar-highlight", hsla(h, Math.max(s, 55), 78));
    set("--nectar-on-highlight", hsla(h, 55, 16));
  }
  set("--nectar-accent", seed);
}

let themeGeneration = 0;
let accentGeneration = 0;

// Highlights (active pills, toggles, sliders, today) are monochrome unless an accent is chosen.
// Material You always has one: it uses the accent, or the Windows accent, as its seed.
async function applyAccent(
  root: HTMLElement,
  surface: string,
  material: { op: number; opExpanded: number; opPanel: number; fallback: string } | null,
  legacy: boolean,
  themeGen: number,
  preloadedSystemAccent?: string
) {
  const generation = ++accentGeneration;
  const accentMode = legacy ? "mono" : localStorage.getItem("nectar-theme-accent") || "mono";
  let color: string | null = null;
  if (accentMode === "custom") {
    const raw = localStorage.getItem("nectar-theme-accent-color");
    color = isHex(raw) ? raw : DEFAULT_ACCENT_COLOR;
  } else if (accentMode === "artwork") {
    if (isHex(runtimeMediaAccentHex)) {
      color = runtimeMediaAccentHex;
    } else {
      const rawFallback = localStorage.getItem("nectar-theme-accent-color");
      color = isHex(rawFallback) ? rawFallback : DEFAULT_ACCENT_COLOR;
    }
  } else if (accentMode === "system" || material) {
    if (isHex(preloadedSystemAccent ?? null)) {
      color = preloadedSystemAccent!;
    } else {
      color = await bridgeInvoke<string>("get_system_accent_color").catch(() => null);
      if (generation !== accentGeneration || themeGen !== themeGeneration) return;
    }
  }
  if (themeGen !== themeGeneration) return;

  if (material) {
    const light = root.classList.contains("light-mode");
    const seed = isHex(color) ? color : material.fallback;
    applyMaterialPalette(root, seed, light, material.op, material.opExpanded, material.opPanel);
    applySelectionVariables(root, seed);
    applyIconTintTokens(root, seed, light);
    return;
  }
  const isLight = root.classList.contains("light-mode");
  if (!isHex(color)) {
    // Monochrome: set a crisp neutral accent and highlight-text contrast so prior colors never leak.
    const monoAccent = isLight ? "#27272a" : "#d4d4d8";
    root.style.setProperty("--nectar-accent", monoAccent);
    root.style.removeProperty("--nectar-highlight");
    root.style.setProperty("--nectar-on-highlight", surface);
    applySelectionVariables(root, monoAccent);
    applyIconTintTokens(root, monoAccent, isLight);
    return;
  }
  root.style.setProperty("--nectar-accent", color);
  root.style.setProperty("--nectar-highlight", color);
  root.style.setProperty("--nectar-on-highlight", contrastText(color));
  applySelectionVariables(root, color);
  applyIconTintTokens(root, color, isLight);
}

export async function applyTheme(
  mode: string,
  customColor: string,
  opacity?: number,
  saturation?: number,
  brightness?: number
) {
  const generation = ++themeGeneration;
  const root = document.documentElement;
  mode = resolveMode(mode);

  // Legacy Mode keeps the classic look: no glass or Material You, and monochrome highlights.
  const legacy = localStorage.getItem("nectar-legacy-mode") === "true";
  const rawStyle = legacy ? "solid" : localStorage.getItem("nectar-theme-style") || "solid";
  const style = (THEME_STYLES as readonly string[]).includes(rawStyle) ? rawStyle : "solid";
  root.classList.remove(...THEME_STYLES.map((s) => `style-${s}`));
  root.classList.add(`style-${style}`);

  if (opacity === undefined || opacity === null || !Number.isFinite(opacity)) {
    opacity = safeFloat(localStorage.getItem('nectar-theme-opacity'), 0.80);
  }

  if (saturation === undefined || saturation === null || !Number.isFinite(saturation)) {
    saturation = safeFloat(localStorage.getItem('nectar-theme-saturation'), 0.50);
  }

  if (brightness === undefined || brightness === null || !Number.isFinite(brightness)) {
    brightness = safeFloat(localStorage.getItem('nectar-theme-brightness'), 0.15);
  }

  const op = Math.max(0.25, Math.min(1.0, opacity));
  const opExpanded = Math.min(1.0, Math.max(op + 0.18, 0.86));
  // Large panels (calendar, command center, start menu, launcher) follow the
  // user's opacity with a small boost for legibility instead of clamping to
  // near-opaque, so liquid themes stay transparent at rest as well as on hover.
  const opPanel = Math.min(1.0, Math.max(op + 0.12, 0.55));
  let surface = '#000000';
  let preloadedSystemAccent: string | undefined;
  root.style.setProperty('--nectar-opacity', String(op));
  root.style.setProperty('--nectar-opacity-expanded', String(opExpanded));
  root.style.setProperty('--nectar-opacity-panel', String(opPanel));

  if (mode === 'light') {
    surface = '#f5f5f7';
    root.style.setProperty('--nectar-bg', `rgba(250, 250, 252, ${op})`);
    root.style.setProperty('--nectar-bg-expanded', `rgba(245, 245, 248, ${opExpanded})`);
    root.style.setProperty('--nectar-bg-panel', `rgba(245, 245, 247, ${opPanel})`);
    root.style.setProperty('--nectar-bg-solid', '#f5f5f7');
    root.style.setProperty('--nectar-bg-elevated', 'rgba(250, 250, 253, 0.96)');
    root.style.setProperty('--nectar-setting-window-bg', 'rgba(244, 244, 248, 0.99)');
    root.style.setProperty('--nectar-text', '#1c1c1e');
    root.style.setProperty('--nectar-text-muted', 'rgba(28, 28, 30, 0.65)');
    root.style.setProperty('--nectar-border', 'rgba(0, 0, 0, 0.12)');
    root.style.setProperty('--nectar-group-bg', 'rgba(0, 0, 0, 0.05)');
    root.style.setProperty('--nectar-scrollbar-thumb', 'rgba(0, 0, 0, 0.18)');
    root.classList.add('light-mode');
    root.classList.remove('dark-mode');
    root.classList.add('theme-light');
    root.classList.remove('theme-dark', 'theme-custom', 'theme-adaptive');
  } else if (mode === 'custom') {
    const hsl = hexToHsl(customColor);
    hsl.s = saturation * 100;
    hsl.l = brightness * 100;
    const finalBgColor = hslToHex(hsl.h, hsl.s, hsl.l);
    const isLight = isLightSurfaceWithHysteresis(finalBgColor, root.classList.contains('light-mode'));
    surface = finalBgColor;

    root.style.setProperty('--nectar-bg', hexToRgba(finalBgColor, op));
    root.style.setProperty('--nectar-bg-expanded', hexToRgba(finalBgColor, opExpanded));
    root.style.setProperty('--nectar-bg-panel', hexToRgba(finalBgColor, opPanel));
    root.style.setProperty('--nectar-bg-solid', finalBgColor);
    root.style.setProperty('--nectar-bg-elevated', hexToRgba(finalBgColor, 0.96));
    root.style.setProperty('--nectar-setting-window-bg', hexToRgba(finalBgColor, 0.98));
    root.style.setProperty('--nectar-text', isLight ? '#1c1c1e' : '#ffffff');
    root.style.setProperty('--nectar-text-muted', isLight ? 'rgba(28, 28, 30, 0.65)' : 'rgba(255, 255, 255, 0.65)');
    root.style.setProperty('--nectar-border', isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.12)');
    root.style.setProperty('--nectar-group-bg', isLight ? 'rgba(0, 0, 0, 0.04)' : 'rgba(255, 255, 255, 0.04)');
    root.style.setProperty('--nectar-scrollbar-thumb', isLight ? 'rgba(0, 0, 0, 0.18)' : 'rgba(255, 255, 255, 0.16)');
    root.classList.add('theme-custom');
    root.classList.remove('theme-light', 'theme-dark', 'theme-adaptive');
    if (isLight) {
      root.classList.add('light-mode');
      root.classList.remove('dark-mode');
    } else {
      root.classList.add('dark-mode');
      root.classList.remove('light-mode');
    }
  } else if (mode === 'adaptive') {
    try {
      const accentHex = await bridgeInvoke<string>('get_system_accent_color');
      if (generation !== themeGeneration) return;
      preloadedSystemAccent = accentHex;
      const hsl = hexToHsl(accentHex);
      hsl.s = saturation * 100;
      hsl.l = brightness * 100;
      const finalBgColor = hslToHex(hsl.h, hsl.s, hsl.l);
      const isLight = isLightSurfaceWithHysteresis(finalBgColor, root.classList.contains('light-mode'));
      surface = finalBgColor;

      root.style.setProperty('--nectar-bg', hexToRgba(finalBgColor, op));
      root.style.setProperty('--nectar-bg-expanded', hexToRgba(finalBgColor, opExpanded));
      root.style.setProperty('--nectar-bg-panel', hexToRgba(finalBgColor, opPanel));
      root.style.setProperty('--nectar-bg-solid', finalBgColor);
      root.style.setProperty('--nectar-bg-elevated', hexToRgba(finalBgColor, 0.96));
      root.style.setProperty('--nectar-setting-window-bg', hexToRgba(finalBgColor, 0.98));
      root.style.setProperty('--nectar-text', isLight ? '#1c1c1e' : '#ffffff');
      root.style.setProperty('--nectar-text-muted', isLight ? 'rgba(28, 28, 30, 0.65)' : 'rgba(255, 255, 255, 0.65)');
      root.style.setProperty('--nectar-border', isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.12)');
      root.style.setProperty('--nectar-group-bg', isLight ? 'rgba(0, 0, 0, 0.04)' : 'rgba(255, 255, 255, 0.04)');
      root.style.setProperty('--nectar-scrollbar-thumb', isLight ? 'rgba(0, 0, 0, 0.18)' : 'rgba(255, 255, 255, 0.16)');
      root.classList.add('theme-adaptive');
      root.classList.remove('theme-light', 'theme-dark', 'theme-custom');
      if (isLight) {
        root.classList.add('light-mode');
        root.classList.remove('dark-mode');
      } else {
        root.classList.add('dark-mode');
        root.classList.remove('light-mode');
      }
    } catch (e) {
      if (generation !== themeGeneration) return;
      console.error("Failed to apply adaptive theme:", e);
      return applyTheme('dark', customColor, op, saturation, brightness);
    }
  } else {
    // default/dark
    root.style.setProperty('--nectar-bg', `rgba(0, 0, 0, ${op})`);
    root.style.setProperty('--nectar-bg-expanded', `rgba(0, 0, 0, ${opExpanded})`);
    root.style.setProperty('--nectar-bg-panel', `rgba(0, 0, 0, ${opPanel})`);
    root.style.setProperty('--nectar-bg-solid', '#0c0c10');
    root.style.setProperty('--nectar-bg-elevated', 'rgba(20, 21, 27, 0.96)');
    root.style.setProperty('--nectar-setting-window-bg', 'rgba(18, 19, 25, 0.99)');
    root.style.setProperty('--nectar-text', '#ffffff');
    root.style.setProperty('--nectar-text-muted', 'rgba(255, 255, 255, 0.6)');
    root.style.setProperty('--nectar-border', 'rgba(255, 255, 255, 0.1)');
    root.style.setProperty('--nectar-group-bg', 'rgba(255, 255, 255, 0.04)');
    root.style.setProperty('--nectar-scrollbar-thumb', 'rgba(255, 255, 255, 0.16)');
    root.classList.add('dark-mode');
    root.classList.remove('light-mode');
    root.classList.add('theme-dark');
    root.classList.remove('theme-light', 'theme-custom', 'theme-adaptive');
  }

  applySurfaceTokens(root, style, root.classList.contains('light-mode'));

  await Promise.all([
    applyAccent(
      root,
      surface,
      style === "material" ? { op, opExpanded, opPanel, fallback: isHex(customColor) ? customColor : DEFAULT_ACCENT_COLOR } : null,
      legacy,
      generation,
      preloadedSystemAccent
    ),
    applyBackdrop(root, style),
  ]);

  if (generation !== themeGeneration) return;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("nectar-theme-applied"));
  }
}

/** Read all theme values from localStorage and apply them to CSS variables. */
export function applyThemeFromStorage() {
  const mode = localStorage.getItem('nectar-theme-mode') || 'dark';
  const color = localStorage.getItem('nectar-theme-color') || '#007aff';
  const opacity = safeFloat(localStorage.getItem('nectar-theme-opacity'), 0.80);
  const saturation = safeFloat(localStorage.getItem('nectar-theme-saturation'), 0.50);
  const brightness = safeFloat(localStorage.getItem('nectar-theme-brightness'), 0.15);
  return applyTheme(mode, color, opacity, saturation, brightness);
}

export const refreshThemeFromStorage = applyThemeFromStorage;

// `backdrop`: this window draws the notch or dock, which show the wallpaper in the glass styles.
export function initTheme(options: { backdrop?: boolean } = {}) {
  if (options.backdrop) enableBackdrop();
  let disposed = false;

  const syncMode = localStorage.getItem('nectar-theme-mode') || 'dark';
  const syncColor = localStorage.getItem('nectar-theme-color') || '#007aff';
  const syncOpacity = safeFloat(localStorage.getItem('nectar-theme-opacity'), 0.80);
  const syncSaturation = safeFloat(localStorage.getItem('nectar-theme-saturation'), 0.50);
  const syncBrightness = safeFloat(localStorage.getItem('nectar-theme-brightness'), 0.15);

  // Fast synchronous draw using cached localStorage
  void applyTheme(syncMode, syncColor, syncOpacity, syncSaturation, syncBrightness);

  const initialExtraKeys = [
    'nectar-theme-accent',
    'nectar-theme-accent-color',
    'nectar-selection-color',
    'nectar-theme-style',
    'nectar-glass-wallpaper',
    'nectar-legacy-mode',
    'nectar-scale',
    'nectar-glass-blur',
    'nectar-edge-intensity',
    'nectar-radius-scale',
    'nectar-ui-density',
    'nectar-motion-speed',
    'nectar-motion-preset',
    'nectar-menu-style',
    'nectar-menu-hover-style',
    'nectar-dock-indicator',
    'nectar-font-family',
    'nectar-perf-profile',
    'nectar-ram-saver',
    'nectar-icon-tint-mode',
    'nectar-icon-tint-source',
    'nectar-icon-tint-color',
    'nectar-icon-tint-strength',
    'nectar-icon-tile-shape',
    'nectar-icon-tint-excluded',
    'nectar-wallpaper-accent',
  ];

  // Sync settings.json in background to avoid flickers (deduplicated per window)
  loadSettingsFromBackend().then((settings) => {
    if (disposed || !settings || Object.keys(settings).length === 0) return;
    const mode = settings['nectar-theme-mode'] ? String(settings['nectar-theme-mode']) : syncMode;
    const color = settings['nectar-theme-color'] ? String(settings['nectar-theme-color']) : syncColor;
    const opacityVal = safeFloat(settings['nectar-theme-opacity'], syncOpacity);
    const saturationVal = safeFloat(settings['nectar-theme-saturation'], syncSaturation);
    const brightnessVal = safeFloat(settings['nectar-theme-brightness'], syncBrightness);

    let styleOrAccentChanged = false;
    for (const key of initialExtraKeys) {
      if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
      const next = serializeSettingForStorage(settings[key]);
      if (next !== null) {
        if (next !== localStorage.getItem(key)) {
          localStorage.setItem(key, next);
          styleOrAccentChanged = true;
        }
      } else if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        styleOrAccentChanged = true;
      }
    }

    if (
      mode !== syncMode ||
      color !== syncColor ||
      opacityVal !== syncOpacity ||
      saturationVal !== syncSaturation ||
      brightnessVal !== syncBrightness ||
      styleOrAccentChanged
    ) {
      localStorage.setItem('nectar-theme-mode', mode);
      localStorage.setItem('nectar-theme-color', color);
      localStorage.setItem('nectar-theme-opacity', String(opacityVal));
      localStorage.setItem('nectar-theme-saturation', String(saturationVal));
      localStorage.setItem('nectar-theme-brightness', String(brightnessVal));
      void applyTheme(mode, color, opacityVal, saturationVal, brightnessVal);
    }
  }).catch(console.error);

  // Hydrate runtime media artwork accent once on init
  bridgeInvoke<unknown>('get_runtime_state')
    .then((state) => {
      if (disposed) return;
      const nextHex = extractMediaAccentHex(state);
      if (nextHex !== runtimeMediaAccentHex) {
        runtimeMediaAccentHex = nextHex;
        if (localStorage.getItem('nectar-theme-accent') === 'artwork') {
          void applyThemeFromStorage();
        }
      }
    })
    .catch(() => {});

  const nectarThemeKeys = [
    'nectar-theme-mode',
    'nectar-theme-color',
    'nectar-theme-opacity',
    'nectar-theme-saturation',
    'nectar-theme-brightness',
    'nectar-theme-accent',
    'nectar-theme-accent-color',
    'nectar-selection-color',
    'nectar-theme-style',
    'nectar-glass-wallpaper',
    'nectar-legacy-mode',
    'nectar-scale',
    'nectar-glass-blur',
    'nectar-edge-intensity',
    'nectar-radius-scale',
    'nectar-ui-density',
    'nectar-motion-speed',
    'nectar-motion-preset',
    'nectar-menu-style',
    'nectar-menu-hover-style',
    'nectar-dock-indicator',
    'nectar-font-family',
    'nectar-perf-profile',
    'nectar-ram-saver',
    'nectar-icon-tint-mode',
    'nectar-icon-tint-source',
    'nectar-icon-tint-color',
    'nectar-icon-tint-strength',
    'nectar-icon-tile-shape',
    'nectar-icon-tint-excluded',
    'nectar-wallpaper-accent',
  ];

  const sub = <T,>(ev: string, fn: (e: { payload: T }) => void) => {
    let un: (() => void) | undefined;
    bridgeListen<T>(ev, (payload) => fn({ payload })).then((f) => {
      if (disposed) f();
      else un = f;
    });
    return () => un?.();
  };

  const handleThemeSettingEvent = (
    payload: { key: string; value: any } | null | undefined,
    ignoreActiveLocal: boolean
  ) => {
    if (!payload) return;
    const { key, value } = payload;
    if (!nectarThemeKeys.includes(key)) return;
    if (ignoreActiveLocal && isLocalSettingWriteActive(key)) return;
    try {
      const serialized = serializeSettingForStorage(value);
      if (serialized === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, serialized);
      }
    } catch {
      // Ignore restricted storage errors
    }
    void applyThemeFromStorage();
  };

  // Listen to setting changes broadcasted from settings window
  const stopSettings = sub<{ key: string; value: any }>('settings-changed', (event) => {
    handleThemeSettingEvent(event.payload, true);
  });

  // Apply batched theme writes in a single pass with no intermediate H/S/L flashes
  const stopBatch = sub<{ entries: Record<string, any> }>('settings-batch-changed', (event) => {
    const entries = event.payload?.entries;
    if (!entries || typeof entries !== 'object') return;
    let touched = false;
    for (const [key, value] of Object.entries(entries)) {
      if (!nectarThemeKeys.includes(key) || isLocalSettingWriteActive(key)) continue;
      touched = true;
      try {
        const serialized = serializeSettingForStorage(value);
        if (serialized === null) {
          localStorage.removeItem(key);
        } else {
          localStorage.setItem(key, serialized);
        }
      } catch {
        // Ignore restricted storage errors
      }
    }
    if (touched) void applyThemeFromStorage();
  });

  // Windows sends this for accent and other system setting changes
  const stopAccent = sub<string>('system-accent-changed', () => {
    const currentMode = localStorage.getItem('nectar-theme-mode') || 'dark';
    if (
      currentMode === 'adaptive' ||
      currentMode === 'auto' ||
      localStorage.getItem('nectar-theme-accent') === 'system' ||
      localStorage.getItem('nectar-theme-style') === 'material' ||
      usesBackdrop(localStorage.getItem('nectar-theme-style'))
    ) {
      void applyThemeFromStorage();
    }
  });

  const stopMediaAccent = sub<unknown>('media-accent-changed', (event) => {
    const nextHex = extractMediaAccentHex(event.payload);
    if (nextHex !== runtimeMediaAccentHex) {
      runtimeMediaAccentHex = nextHex;
      if (localStorage.getItem('nectar-theme-accent') === 'artwork') {
        void applyThemeFromStorage();
      }
    }
  });

  // The wallpaper backdrop is lined up with the window's place on its monitor
  const stopMonitors = sub('monitors-changed', () => {
    if (usesBackdrop(localStorage.getItem('nectar-theme-style'))) void applyThemeFromStorage();
  });

  // Follow Windows light/dark in auto mode
  const onSchemeChange = () => {
    if ((localStorage.getItem('nectar-theme-mode') || 'dark') === 'auto') void applyThemeFromStorage();
  };
  darkScheme?.addEventListener('change', onSchemeChange);

  const onLocalThemeSettingChanged = () => {
    void applyThemeFromStorage();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("theme-setting-changed", onLocalThemeSettingChanged);
  }

  // Listen to external edits (e.g. settings.json edited outside the app)
  const stopExternal = sub<{ key: string; value: any }>('settings-external-changed', (event) => {
    handleThemeSettingEvent(event.payload, false);
  });

  // Listen to settings reset so theme keys clear and default theme reapplies cleanly
  const stopReset = sub<unknown>('settings-reset', () => {
    clearLocalSettingWrites();
    try {
      for (const key of nectarThemeKeys) {
        localStorage.removeItem(key);
      }
    } catch {
      // Ignore restricted storage errors
    }
    void applyThemeFromStorage();
  });

  return () => {
    disposed = true;
    stopSettings();
    stopBatch();
    stopAccent();
    stopMediaAccent();
    stopExternal();
    stopReset();
    stopMonitors();
    darkScheme?.removeEventListener('change', onSchemeChange);
    if (typeof window !== "undefined") {
      window.removeEventListener("theme-setting-changed", onLocalThemeSettingChanged);
    }
  };
}
