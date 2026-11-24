import type { ComponentType, SVGProps } from "react";

export interface WidgetConfig {
  left: string[];
  right: string[];
}

export interface MonitorInfo {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary: boolean;
}

export type MonitorMode = "primary" | "all" | "specific";

export type TrayHostStatus = "active" | "blocked_by_zbid" | "stopped";

export interface HotkeyStatus {
  notch_ok: boolean;
  notch_shortcut: string;
  launcher_ok: boolean;
  launcher_shortcut: string;
  traybar_ok: boolean;
  traybar_shortcut: string;
}

export type SettingsTab = "general" | "appearance" | "notch" | "dock" | "launcher" | "start" | "overlays" | "about" | "diagnostics" | "calendar-sync";

export interface SettingRowProps {
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;
  label: string;
  desc?: string;
  settingKey?: string;
  action?: boolean;
  danger?: boolean;
  divider?: boolean;
  stacked?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
}
