import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useT } from "../i18n";
import { isTauriRuntime } from "../utils/tauriBridge";
import "./WindowControls.css";

export function WindowControls() {
  const t = useT();
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    getCurrentWebviewWindow()
      .onFocusChanged(({ payload }) => setFocused(payload))
      .then((fn) => {
        if (cancelled) fn();
        else cleanup = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  const win = isTauriRuntime() ? getCurrentWebviewWindow() : null;

  return (
    <div className={`wc${focused ? "" : " blurred"}`}>
      <button className="wc-btn minimize" aria-label={t("window.minimize")} onClick={() => win?.minimize().catch(() => {})} />
      <button
        className="wc-btn close"
        aria-label={t("window.close")}
        onClick={() => {
          if (!win) return;
          invoke("hide_on_demand_window", { label: win.label }).catch(() => {
            win.hide().catch(() => {});
          });
        }}
      />
    </div>
  );
}
