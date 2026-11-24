export interface AppInfo {
  name: string;
  path: string;
  icon?: string | null;
  is_running: boolean;
  hwnd?: number | null;
  executable?: string | null;
  all_hwnds?: [number, string][] | null;
  args?: string | null;
}
