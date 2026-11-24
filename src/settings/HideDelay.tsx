import { Timer } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { Dropdown } from "./Dropdown";
import { useT } from "../i18n";
import { useSyncedSetting } from "./useSyncedSetting";

const DELAYS = [
  { value: "400", label: "0.4 s" },
  { value: "800", label: "0.8 s" },
  { value: "2000", label: "2 s" },
  { value: "5000", label: "5 s" },
  { value: "15000", label: "15 s" },
  { value: "60000", label: "1 min" },
  { value: "300000", label: "5 min" },
  { value: "900000", label: "15 min" },
  { value: "3600000", label: "1 h" },
  { value: "10800000", label: "3 h" },
];

const parseHideDelay = (raw: unknown): string => {
  const s = raw === null || raw === undefined ? "" : String(raw);
  return DELAYS.some((d) => d.value === s) ? s : "800";
};

export function HideDelay() {
  const t = useT();
  const [value, change] = useSyncedSetting("nectar-dock-hide-delay", parseHideDelay, (v) => v);

  return (
    <SettingRow icon={Timer} label={t("dock.hideDelay")} desc={t("dock.hideDelay.desc")} settingKey="dock.hideDelay">
      <Dropdown value={value} onChange={change} options={DELAYS} />
    </SettingRow>
  );
}
