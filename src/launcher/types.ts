export interface LauncherAction {
  id: string;
  label: string;
  shortcut?: string | null;
  destructive: boolean;
}

export interface CalcCard {
  expression: string;
  formatted: string;
  raw: string;
  note: string;
}

export interface LauncherItem {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  badge: string;
  icon?: string | null;
  target: string;
  args?: string | null;
  hwnd?: number | null;
  score: number;
  match_indices: number[];
  requires_confirm: boolean;
  actions: LauncherAction[];
}

export interface LauncherSearchResponse {
  mode: string;
  clean_query: string;
  items: LauncherItem[];
  calc_card?: CalcCard | null;
  everything_available: boolean;
}

export interface HistoryEntry {
  query: string;
  item_title: string;
  item_id: string;
  kind: string;
  target: string;
  timestamp_ms: number;
}
