export interface TrayIconDto {
  key: string;
  title: string;
  exe_name: string;
  exe_path: string;
  pid: number;
  icon?: string | null;
  revision: number;
  promoted: boolean;
  hidden_by_app: boolean;
  order: number;
}
