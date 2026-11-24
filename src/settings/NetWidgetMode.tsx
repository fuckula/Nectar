import { Wifi } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { Dropdown } from "./Dropdown";
import { useT } from "../i18n";
import { useSyncedSetting } from "./useSyncedSetting";

const MODES = ["speed", "status"];

const parseNetWidgetMode = (raw: unknown): string => {
  const s = raw === null || raw === undefined ? "" : String(raw);
  return MODES.includes(s) ? s : "speed";
};

export function NetWidgetMode() {
  const t = useT();
  const [value, change] = useSyncedSetting("nectar-net-widget-mode", parseNetWidgetMode, (v) => v);

  return (
    <SettingRow icon={Wifi} label={t("notch.netWidget")} desc={t("notch.netWidget.desc")}>
      <Dropdown
        value={value}
        onChange={change}
        options={MODES.map((m) => ({ value: m, label: t(`notch.netWidget.${m}`) }))}
      />
    </SettingRow>
  );
}
