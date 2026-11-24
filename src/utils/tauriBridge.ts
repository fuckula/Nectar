import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { emit as tauriEmit, listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let previewMockPromise: Promise<typeof import("./tauriPreviewMock")> | null = null;

function loadPreviewMock() {
  previewMockPromise ??= import("./tauriPreviewMock");
  return previewMockPromise;
}

export async function bridgeInvoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isTauriRuntime()) {
    return tauriInvoke<T>(cmd, args);
  }
  const mock = await loadPreviewMock();
  return mock.previewInvoke<T>(cmd, args);
}

export function bridgeListen<T = unknown>(
  event: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    return tauriListen<T>(event, (e) => handler(e.payload));
  }
  return loadPreviewMock().then((mock) => mock.previewListen<T>(event, handler));
}

export function bridgeEmit(event: string, payload?: unknown): Promise<void> {
  if (isTauriRuntime()) {
    return tauriEmit(event, payload);
  }
  return loadPreviewMock().then((mock) => mock.previewEmit(event, payload));
}

export function applyPreviewThemeParams(): void {
  if (typeof window === "undefined" || isTauriRuntime()) return;
  const params = new URLSearchParams(window.location.search);
  const style = params.get("style");
  const mode = params.get("theme");
  const root = document.documentElement;
  if (style && ["solid", "frosted", "liquid", "material"].includes(style)) {
    localStorage.setItem("nectar-theme-style", style);
    localStorage.setItem("nectar-legacy-mode", "false");
    root.classList.remove("style-solid", "style-frosted", "style-liquid", "style-material");
    root.classList.add(`style-${style}`);
  }
  if (mode === "light" || mode === "dark") {
    localStorage.setItem("nectar-theme-mode", mode);
    if (mode === "light") root.classList.add("light-mode");
    else root.classList.remove("light-mode");
  }
}
