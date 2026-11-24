import { Image } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { useT } from "../i18n";
import { useSyncedSetting } from "./useSyncedSetting";

const parseGlassWallpaper = (raw: unknown): boolean => raw === true || raw === "true";

export function GlassWallpaper() {
  const t = useT();
  const [on, saveOn] = useSyncedSetting("nectar-glass-wallpaper", parseGlassWallpaper, String);

  const toggle = () => {
    saveOn(!on);
  };

  return (
    <SettingRow icon={Image} label={t("appearance.glassWallpaper")} desc={t("appearance.glassWallpaper.desc")}>
      <label className="toggle-switch">
        <input type="checkbox" checked={on} onChange={toggle} />
        <span className="slider"></span>
      </label>
    </SettingRow>
  );
}
