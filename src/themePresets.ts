export const THEME_EXPORT_KEYS = [
  "nectar-theme-style",
  "nectar-theme-mode",
  "nectar-theme-accent",
  "nectar-theme-accent-color",
  "nectar-theme-color",
  "nectar-theme-opacity",
  "nectar-theme-saturation",
  "nectar-theme-brightness",
  "nectar-glass-wallpaper",
  "nectar-glass-blur",
  "nectar-edge-intensity",
  "nectar-radius-scale",
  "nectar-ui-density",
  "nectar-motion-speed",
  "nectar-motion-preset",
  "nectar-menu-style",
  "nectar-menu-hover-style",
  "nectar-dock-indicator",
  "nectar-font-family",
  "nectar-selection-color",
  "nectar-legacy-mode",
  "nectar-icon-tint-mode",
  "nectar-icon-tint-source",
  "nectar-icon-tint-color",
  "nectar-icon-tint-strength",
  "nectar-icon-tile-shape",
] as const;

export type ThemeExportKey = (typeof THEME_EXPORT_KEYS)[number];

export interface CustomThemePreset {
  id: string;
  name: string;
  createdAt: number;
  settings: Partial<Record<ThemeExportKey, string>>;
}

export interface ThemeFileEnvelope {
  schema: "nectar-theme-v1";
  name: string;
  exportedAt: string;
  settings: Partial<Record<ThemeExportKey, string>>;
}

export const MAX_CUSTOM_PRESETS = 16;
export const MAX_PRESET_NAME_LENGTH = 32;

const THEME_STYLES = new Set(["solid", "frosted", "liquid", "material"]);
const THEME_MODES = new Set(["dark", "light", "auto", "custom", "adaptive"]);
const THEME_ACCENTS = new Set(["mono", "system", "custom", "artwork"]);
const UI_DENSITIES = new Set(["compact", "comfortable", "spacious"]);
const FONT_FAMILIES = new Set(["system", "clean", "rounded", "mono"]);
const ICON_TINT_MODES = new Set(["original", "dark-glass", "tinted", "pastel", "duotone"]);
const ICON_TINT_SOURCES = new Set(["accent", "custom", "wallpaper"]);
const ICON_TILE_SHAPES = new Set(["squircle", "circle", "rounded", "none"]);
const MOTION_PRESETS = new Set(["snappy", "springy", "liquid", "minimal"]);
const MENU_STYLES = new Set(["glass", "frosted", "solid", "neon-rim"]);
const MENU_HOVER_STYLES = new Set(["pill", "accent-bar", "glow", "outline"]);
const DOCK_INDICATORS = new Set(["dots", "pill", "bar", "glow", "fixed", "none"]);

const NUMERIC_RANGES: Partial<Record<ThemeExportKey, [number, number]>> = {
  "nectar-theme-opacity": [0.35, 1],
  "nectar-theme-saturation": [0, 1],
  "nectar-theme-brightness": [0, 1],
  "nectar-glass-blur": [0, 2],
  "nectar-edge-intensity": [0, 2],
  "nectar-radius-scale": [0.6, 1.35],
  "nectar-motion-speed": [0, 1.5],
  "nectar-icon-tint-strength": [0, 1],
};

export const THEME_DEFAULT_VALUES: Record<ThemeExportKey, string> = {
  "nectar-theme-style": "solid",
  "nectar-theme-mode": "dark",
  "nectar-theme-accent": "mono",
  "nectar-theme-accent-color": "#0a84ff",
  "nectar-theme-color": "#0a84ff",
  "nectar-theme-opacity": "0.8",
  "nectar-theme-saturation": "0.45",
  "nectar-theme-brightness": "0.15",
  "nectar-glass-wallpaper": "false",
  "nectar-glass-blur": "1",
  "nectar-edge-intensity": "1",
  "nectar-radius-scale": "1",
  "nectar-ui-density": "comfortable",
  "nectar-motion-speed": "1",
  "nectar-motion-preset": "springy",
  "nectar-menu-style": "glass",
  "nectar-menu-hover-style": "pill",
  "nectar-dock-indicator": "dots",
  "nectar-font-family": "system",
  "nectar-selection-color": "#0a84ff",
  "nectar-legacy-mode": "false",
  "nectar-icon-tint-mode": "original",
  "nectar-icon-tint-source": "accent",
  "nectar-icon-tint-color": "#5282ff",
  "nectar-icon-tint-strength": "0.75",
  "nectar-icon-tile-shape": "squircle",
};

const HEX_KEYS = new Set<ThemeExportKey>([
  "nectar-theme-accent-color",
  "nectar-theme-color",
  "nectar-selection-color",
  "nectar-icon-tint-color",
]);

const BOOLEAN_KEYS = new Set<ThemeExportKey>([
  "nectar-glass-wallpaper",
  "nectar-legacy-mode",
]);

function normalizeHex(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const hex6 = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hex6) return `#${hex6[1].toLowerCase()}`;
  const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed);
  if (hex3) {
    return `#${hex3[1]}${hex3[1]}${hex3[2]}${hex3[2]}${hex3[3]}${hex3[3]}`.toLowerCase();
  }
  return null;
}

function normalizeBooleanString(raw: unknown): string | null {
  if (typeof raw === "boolean") return raw ? "true" : "false";
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "true" || trimmed === "false") return trimmed;
  }
  return null;
}

function normalizeClampedFloat(raw: unknown, min: number, max: number): string | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) return null;
  const clamped = Math.max(min, Math.min(max, parsed));
  return String(Math.round(clamped * 1000) / 1000);
}

function sanitizeSettingValue(key: ThemeExportKey, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  if (HEX_KEYS.has(key)) {
    return normalizeHex(raw);
  }

  if (BOOLEAN_KEYS.has(key)) {
    return normalizeBooleanString(raw);
  }

  const range = NUMERIC_RANGES[key];
  if (range) {
    return normalizeClampedFloat(raw, range[0], range[1]);
  }

  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();

  switch (key) {
    case "nectar-theme-style":
      return THEME_STYLES.has(trimmed) ? trimmed : null;
    case "nectar-theme-mode":
      return THEME_MODES.has(trimmed) ? trimmed : null;
    case "nectar-theme-accent":
      return THEME_ACCENTS.has(trimmed) ? trimmed : null;
    case "nectar-ui-density":
      return UI_DENSITIES.has(trimmed) ? trimmed : null;
    case "nectar-font-family":
      return FONT_FAMILIES.has(trimmed) ? trimmed : null;
    case "nectar-icon-tint-mode":
      return ICON_TINT_MODES.has(trimmed) ? trimmed : null;
    case "nectar-icon-tint-source":
      return ICON_TINT_SOURCES.has(trimmed) ? trimmed : null;
    case "nectar-icon-tile-shape":
      return ICON_TILE_SHAPES.has(trimmed) ? trimmed : null;
    case "nectar-motion-preset":
      return MOTION_PRESETS.has(trimmed) ? trimmed : null;
    case "nectar-menu-style":
      return MENU_STYLES.has(trimmed) ? trimmed : null;
    case "nectar-menu-hover-style":
      return MENU_HOVER_STYLES.has(trimmed) ? trimmed : null;
    case "nectar-dock-indicator":
      return DOCK_INDICATORS.has(trimmed) ? trimmed : null;
    default:
      return null;
  }
}

/**
 * Validates and filters an arbitrary object against the 26-key theme allowlist,
 * clamping numeric ranges and rejecting invalid colors, booleans, or enums.
 */
export function sanitizeThemeSettings(
  raw: unknown
): Partial<Record<ThemeExportKey, string>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const record = raw as Record<string, unknown>;
  const out: Partial<Record<ThemeExportKey, string>> = {};

  for (const key of THEME_EXPORT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const sanitized = sanitizeSettingValue(key, record[key]);
    if (sanitized !== null) {
      out[key] = sanitized;
    }
  }

  return out;
}

/**
 * Parses and sanitizes persisted custom theme presets (array or JSON string),
 * capping at 16 presets and 32-character names.
 */
export function parseCustomPresets(raw: unknown): CustomThemePreset[] {
  let source = raw;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return [];
    try {
      source = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(source)) return [];

  const result: CustomThemePreset[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < source.length && result.length < MAX_CUSTOM_PRESETS; i++) {
    const item = source[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;

    const rawName = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!rawName) continue;
    const name = rawName.slice(0, MAX_PRESET_NAME_LENGTH);

    const settings = sanitizeThemeSettings(obj.settings);
    if (Object.keys(settings).length === 0) continue;

    const createdAt =
      typeof obj.createdAt === "number" && Number.isFinite(obj.createdAt) && obj.createdAt >= 0
        ? obj.createdAt
        : 0;

    let id =
      typeof obj.id === "string" && obj.id.trim()
        ? obj.id.trim().slice(0, 64)
        : `preset-${i + 1}`;
    if (seenIds.has(id)) {
      id = `${id.slice(0, 56)}-${i + 1}`;
    }
    seenIds.add(id);

    result.push({ id, name, createdAt, settings });
  }

  return result;
}

/** Captures and sanitizes all active theme keys from `localStorage` (falling back to canonical defaults). */
export function captureCurrentThemeSnapshot(): Partial<Record<ThemeExportKey, string>> {
  const raw: Record<string, unknown> = {};
  try {
    for (const key of THEME_EXPORT_KEYS) {
      const value = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
      raw[key] = value !== null ? value : THEME_DEFAULT_VALUES[key];
    }
  } catch {
    for (const key of THEME_EXPORT_KEYS) {
      raw[key] = THEME_DEFAULT_VALUES[key];
    }
  }
  return sanitizeThemeSettings(raw);
}

function isStorageLike(value: unknown): value is Pick<Storage, "getItem"> {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Storage).getItem === "function"
  );
}

/**
 * Builds a shareable `nectar-theme-v1` file envelope from a Storage instance,
 * raw settings map, or the current `localStorage` snapshot.
 */
export function buildThemeEnvelope(
  name: string,
  storageOrMap?: Pick<Storage, "getItem"> | Record<string, unknown>
): ThemeFileEnvelope {
  const cleanName =
    typeof name === "string" && name.trim()
      ? name.trim().slice(0, MAX_PRESET_NAME_LENGTH)
      : "Custom Theme";

  let settings: Partial<Record<ThemeExportKey, string>>;
  if (!storageOrMap) {
    settings = captureCurrentThemeSnapshot();
  } else if (isStorageLike(storageOrMap)) {
    const raw: Record<string, unknown> = {};
    for (const key of THEME_EXPORT_KEYS) {
      const val = storageOrMap.getItem(key);
      if (val !== null) raw[key] = val;
    }
    settings = sanitizeThemeSettings(raw);
  } else {
    settings = sanitizeThemeSettings(storageOrMap);
  }

  return {
    schema: "nectar-theme-v1",
    name: cleanName,
    exportedAt: new Date().toISOString(),
    settings,
  };
}

/** Parses and validates a JSON-encoded `nectar-theme-v1` envelope. */
export function parseThemeEnvelope(rawJson: string): ThemeFileEnvelope | null {
  if (typeof rawJson !== "string") return null;
  const trimmed = rawJson.trim();
  if (!trimmed || trimmed.length > 262_144) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema !== "nectar-theme-v1") return null;

  const settings = sanitizeThemeSettings(obj.settings);
  if (Object.keys(settings).length === 0) return null;

  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim().slice(0, MAX_PRESET_NAME_LENGTH)
      : "Imported Theme";
  const exportedAt =
    typeof obj.exportedAt === "string" && obj.exportedAt.trim()
      ? obj.exportedAt.trim()
      : new Date().toISOString();

  return {
    schema: "nectar-theme-v1",
    name,
    exportedAt,
    settings,
  };
}
