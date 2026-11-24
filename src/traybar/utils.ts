import type { MouseEvent } from "react";

export function trayCustomIconKey(trayKey: string): string {
  return `tray-icon:${trayKey}`;
}

export function parseStringList(raw: unknown): string[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string" && item.length > 0 && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function parsePinnedTrayKeys(raw: unknown): string[] {
  return parseStringList(raw);
}

export function parseStringMap(raw: unknown): Record<string, string> {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === "string" && k.length > 0 && typeof v === "string" && v.trim().length > 0) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function sortTrayIcons<T extends { key: string }>(icons: T[], orderKeys: string[]): T[] {
  if (orderKeys.length === 0) return icons;
  const rank = new Map<string, number>();
  orderKeys.forEach((k, idx) => rank.set(k, idx));
  return icons
    .map((item, origIdx) => ({
      item,
      origIdx,
      pos: rank.get(item.key) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.pos - b.pos || a.origIdx - b.origIdx)
    .map((x) => x.item);
}

export function syncPinnedOrder(pinnedKeys: string[], orderKeys: string[]): string[] {
  if (orderKeys.length === 0 || pinnedKeys.length <= 1) return pinnedKeys;
  const rank = new Map<string, number>();
  orderKeys.forEach((k, idx) => rank.set(k, idx));
  return pinnedKeys
    .map((key, origIdx) => ({
      key,
      origIdx,
      pos: rank.get(key) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.pos - b.pos || a.origIdx - b.origIdx)
    .map((x) => x.key);
}

export function rasterizeImageFileToPngDataUrl(file: File, maxSize = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read icon file"));
    reader.onload = () => {
      const dataUri = typeof reader.result === "string" ? reader.result : "";
      if (!dataUri) {
        reject(new Error("Empty icon file"));
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth || maxSize;
          const h = img.naturalHeight || maxSize;
          const scale = Math.min(maxSize / Math.max(1, w), maxSize / Math.max(1, h), 1);
          const drawW = Math.max(1, Math.round(w * scale));
          const drawH = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement("canvas");
          canvas.width = maxSize;
          canvas.height = maxSize;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(dataUri);
            return;
          }
          ctx.clearRect(0, 0, maxSize, maxSize);
          const ox = Math.floor((maxSize - drawW) / 2);
          const oy = Math.floor((maxSize - drawH) / 2);
          ctx.drawImage(img, ox, oy, drawW, drawH);
          resolve(canvas.toDataURL("image/png"));
        } catch {
          resolve(dataUri);
        }
      };
      img.onerror = () => resolve(dataUri);
      img.src = dataUri;
    };
    reader.readAsDataURL(file);
  });
}

export function trayInteractionCoords(
  e: MouseEvent<HTMLElement>,
  zoom = 1
): {
  screenX: number;
  screenY: number;
  rect: [number, number, number, number];
} {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const r = e.currentTarget.getBoundingClientRect();
  const offsetW = e.currentTarget.offsetWidth || r.width;
  // Modern Chromium (128+/WebView2) includes CSS zoom inside getBoundingClientRect() and clientX/Y,
  // whereas older engines return unzoomed CSS pixels.
  const rectScale = safeZoom !== 1 && Math.abs(r.width - offsetW) < 1 ? safeZoom : 1;
  const winX = typeof window !== "undefined" ? window.screenX || 0 : 0;
  const winY = typeof window !== "undefined" ? window.screenY || 0 : 0;
  const isKeyboardActivated = e.detail === 0 && e.clientX === 0 && e.clientY === 0;
  const clickX = isKeyboardActivated ? (r.left + r.width / 2) * rectScale : e.clientX;
  const clickY = isKeyboardActivated ? (r.top + r.height / 2) * rectScale : e.clientY;
  const screenX = Math.round((winX + clickX) * dpr);
  const screenY = Math.round((winY + clickY) * dpr);
  const rect: [number, number, number, number] = [
    Math.round((winX + r.left * rectScale) * dpr),
    Math.round((winY + r.top * rectScale) * dpr),
    Math.round((winX + r.right * rectScale) * dpr),
    Math.round((winY + r.bottom * rectScale) * dpr),
  ];
  return { screenX, screenY, rect };
}
