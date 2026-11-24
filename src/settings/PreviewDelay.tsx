import { Timer } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { Dropdown } from "./Dropdown";
import { useT } from "../i18n";
import { useSyncedSetting } from "./useSyncedSetting";

const DELAYS = ["0", "100", "200", "300", "500", "800"];

const parsePreviewDelay = (raw: unknown): string => {
  const s = raw === null || raw === undefined ? "" : String(raw);
  return DELAYS.includes(s) ? s : "300";
};

export function PreviewDelay() {
  const t = useT();
  const [value, change] = useSyncedSetting("nectar-dock-preview-delay", parsePreviewDelay, (v) => v);

  return (
    <SettingRow icon={Timer} label={t("dock.previewDelay")} desc={t("dock.previewDelay.desc")}>
      <Dropdown
        value={value}
        onChange={change}
        options={DELAYS.map((ms) => ({ value: ms, label: ms === "0" ? t("overlays.edgeDelay.instant") : `${Number(ms) / 1000} s` }))}
      />
    </SettingRow>
  );
}
