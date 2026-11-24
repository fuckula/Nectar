import { Volume2, Sun, ArrowLeftToLine, ArrowRightToLine, MoveVertical, SlidersHorizontal, Timer, Palette } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { SettingSection } from "./SettingSection";
import { Dropdown } from "./Dropdown";
import { EdgeDelay } from "./EdgeDelay";
import { EdgeSides } from "./EdgeSides";
import { useSyncedSetting } from "./useSyncedSetting";
import { useT } from "../i18n";

const parseVpos = (v: unknown): string => (v === "top" || v === "bottom" ? String(v) : "center");
const parseOverlayStyle = (v: unknown): string => (v === "slim" || v === "wide" ? String(v) : "default");
const parseTimeoutMs = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "2000"), 10);
  return Number.isFinite(n) ? Math.min(5000, Math.max(1000, n)) : 2000;
};
const parseBoolFalse = (v: unknown): boolean => v === true || v === "true";

interface OverlaysTabProps {
  volumeOverlayEnabled: boolean;
  toggleVolumeOverlay: () => void;
  volumeEdgeEnabled: boolean;
  toggleVolumeEdge: () => void;
  brightnessOverlayEnabled: boolean;
  toggleBrightnessOverlay: () => void;
  brightnessEdgeEnabled: boolean;
  toggleBrightnessEdge: () => void;
}

export function OverlaysTab({
  volumeOverlayEnabled,
  toggleVolumeOverlay,
  volumeEdgeEnabled,
  toggleVolumeEdge,
  brightnessOverlayEnabled,
  toggleBrightnessOverlay,
  brightnessEdgeEnabled,
  toggleBrightnessEdge,
}: OverlaysTabProps) {
  const t = useT();
  const [overlayVpos, setOverlayVpos] = useSyncedSetting("nectar-overlay-vpos", parseVpos, (v) => v);
  const [overlayStyle, setOverlayStyle] = useSyncedSetting("nectar-overlay-style", parseOverlayStyle, (v) => v);
  const [overlayTimeoutMs, setOverlayTimeoutMs] = useSyncedSetting("nectar-overlay-timeout-ms", parseTimeoutMs, (v) => String(v), { debounceMs: 120 });
  const [overlayAccentFill, setOverlayAccentFill] = useSyncedSetting("nectar-overlay-accent-fill", parseBoolFalse, (v) => String(v));

  return (
    <>
      <SettingSection id="overlays-main" title={t("overlays.group")} defaultOpen>
        <SettingRow icon={Volume2} label={t("overlays.volume")} desc={t("overlays.volume.desc")} settingKey="overlays.volume">
          <label className="toggle-switch">
            <input type="checkbox" checked={volumeOverlayEnabled} onChange={toggleVolumeOverlay} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        {volumeOverlayEnabled && (
          <SettingRow icon={ArrowLeftToLine} label={t("overlays.edgeHover")} desc={t("overlays.edgeHover.left")} settingKey="overlays.edgeHover">
            <label className="toggle-switch">
              <input type="checkbox" checked={volumeEdgeEnabled} onChange={toggleVolumeEdge} />
              <span className="slider"></span>
            </label>
          </SettingRow>
        )}

        <SettingRow icon={Sun} label={t("overlays.brightness")} desc={t("overlays.brightness.desc")} settingKey="overlays.brightness">
          <label className="toggle-switch">
            <input type="checkbox" checked={brightnessOverlayEnabled} onChange={toggleBrightnessOverlay} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        {brightnessOverlayEnabled && (
          <SettingRow icon={ArrowRightToLine} label={t("overlays.edgeHover")} desc={t("overlays.edgeHover.right")}>
            <label className="toggle-switch">
              <input type="checkbox" checked={brightnessEdgeEnabled} onChange={toggleBrightnessEdge} />
              <span className="slider"></span>
            </label>
          </SettingRow>
        )}

        <EdgeSides />

        {(volumeEdgeEnabled || brightnessEdgeEnabled) && <EdgeDelay />}
      </SettingSection>

      <SettingSection id="overlays-appearance" title={t("overlays.appearance.group")} defaultOpen>
        <SettingRow icon={MoveVertical} label={t("overlays.vpos")} desc={t("overlays.vpos.desc")} settingKey="overlays.vpos">
          <Dropdown
            value={overlayVpos}
            onChange={(val) => void setOverlayVpos(val)}
            options={[
              { value: "top", label: t("overlays.vpos.top") },
              { value: "center", label: t("overlays.vpos.center") },
              { value: "bottom", label: t("overlays.vpos.bottom") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={SlidersHorizontal} label={t("overlays.style")} desc={t("overlays.style.desc")} settingKey="overlays.style">
          <Dropdown
            value={overlayStyle}
            onChange={(val) => void setOverlayStyle(val)}
            options={[
              { value: "slim", label: t("overlays.style.slim") },
              { value: "default", label: t("overlays.style.default") },
              { value: "wide", label: t("overlays.style.wide") },
            ]}
          />
        </SettingRow>

        <SettingRow
          icon={Timer}
          label={t("overlays.timeout")}
          desc={t("overlays.timeout.desc", { seconds: (overlayTimeoutMs / 1000).toFixed(2).replace(/\.?0+$/, "") })}
          settingKey="overlays.timeout"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="range"
              min="1000"
              max="5000"
              step="250"
              value={overlayTimeoutMs}
              onChange={(e) => void setOverlayTimeoutMs(parseInt(e.target.value, 10))}
              className="settings-slider"
            />
            <span className="setting-value-badge">{(overlayTimeoutMs / 1000).toFixed(1)}s</span>
          </div>
        </SettingRow>

        <SettingRow
          icon={Palette}
          label={t("overlays.accentFill")}
          desc={t("overlays.accentFill.desc")}
          settingKey="overlays.accentFill"
          divider={false}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={overlayAccentFill}
              onChange={() => void setOverlayAccentFill(!overlayAccentFill)}
            />
            <span className="slider"></span>
          </label>
        </SettingRow>
      </SettingSection>
    </>
  );
}
