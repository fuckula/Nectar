export interface StartPinItem {
  name: string;
  path: string;
  args?: string | null;
  executable?: string | null;
  icon?: string | null;
}

export interface RecommendedItem {
  id: string;
  kind: "app" | "file";
  title: string;
  subtitle: string;
  path: string;
  args?: string | null;
  icon?: string | null;
  timestamp_ms: number;
}

export interface UserFolderLink {
  id: string;
  label: string;
  path: string;
}

export interface StartUserProfile {
  display_name: string;
  avatar?: string | null;
  folders: UserFolderLink[];
}
