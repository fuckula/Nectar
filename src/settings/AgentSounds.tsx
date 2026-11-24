import { useCallback, useEffect, useState } from "react";
import { Bell, CircleCheck, CircleAlert, Volume2, Play, FolderOpen, RotateCcw } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { playAgentSound, soundKey, type SoundState } from "../agentSounds";
import { useT } from "../i18n";
import { bridgeInvoke, bridgeListen } from "../utils/tauriBridge";
import { useSyncedSetting } from "./useSyncedSetting";

const ROWS: { state: SoundState; icon: typeof Bell }[] = [
  { state: "needs_input", icon: Bell },
  { state: "done", icon: CircleCheck },
  { state: "error", icon: CircleAlert },
];

const parseEnabled = (raw: unknown): boolean => raw !== false && raw !== "false";
const parseDefaultOn = (raw: unknown): boolean =>
  raw === null || raw === undefined ? true : raw === true || raw === "true";
const parseDefaultOff = (raw: unknown): boolean => raw === true || raw === "true";

export function AgentSounds() {
  const t = useT();
  const [enabled, saveEnabled] = useSyncedSetting("nectar-agent-sounds", parseEnabled, String);
  const [needsInputOn, saveNeedsInput] = useSyncedSetting(soundKey("needs_input"), parseDefaultOn, String);
  const [doneOn, saveDone] = useSyncedSetting(soundKey("done"), parseDefaultOff, String);
  const [errorOn, saveError] = useSyncedSetting(soundKey("error"), parseDefaultOn, String);
  const [custom, setCustom] = useState<string[]>([]);

  const stateOn: Record<SoundState, boolean> = {
    needs_input: needsInputOn,
    done: doneOn,
    error: errorOn,
  };

  const toggleState = (state: SoundState) => {
    if (state === "needs_input") saveNeedsInput(!needsInputOn);
    else if (state === "done") saveDone(!doneOn);
    else saveError(!errorOn);
  };

  const refresh = useCallback(() => {
    bridgeInvoke<string[] | null>("agent_sound_custom")
      .then((res) => {
        if (Array.isArray(res)) setCustom(res);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    refresh();
    bridgeListen("agent-sound-changed", () => {
      if (!cancelled) refresh();
    }).then((fn) => {
      if (cancelled) fn();
      else stop = fn;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [refresh]);

  const toggle = () => {
    saveEnabled(!enabled);
  };

  return (
    <>
      <SettingRow icon={Volume2} label={t("notch.agentSounds")} desc={t("notch.agentSounds.desc")}>
        <label className="toggle-switch">
          <input type="checkbox" checked={enabled} onChange={toggle} />
          <span className="slider"></span>
        </label>
      </SettingRow>
      {enabled && ROWS.map(({ state, icon }, i) => (
        <SettingRow key={state} icon={icon} label={t(`agent.${state}`)} desc={custom.includes(state) ? t("notch.agentSound.custom") : t("notch.agentSound.default")} divider={i < ROWS.length - 1}>
          <div className="agent-sound-actions">
            <label className="toggle-switch">
              <input type="checkbox" checked={stateOn[state]} onChange={() => toggleState(state)} />
              <span className="slider"></span>
            </label>
            <button className="agent-sound-btn" onClick={() => playAgentSound(state, true)}><Play size={12} />{t("notch.agentSound.play")}</button>
            <button className="agent-sound-btn" onClick={() => bridgeInvoke("pick_agent_sound", { state }).catch(() => {})}><FolderOpen size={12} />{t("notch.agentSound.choose")}</button>
            {custom.includes(state) && <button className="agent-sound-btn" onClick={() => bridgeInvoke("reset_agent_sound", { state }).catch(() => {})} title={t("notch.agentSound.reset")}><RotateCcw size={12} /></button>}
          </div>
        </SettingRow>
      ))}
    </>
  );
}
