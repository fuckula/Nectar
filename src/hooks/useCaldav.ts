import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface CalEvent {
  uid: string;
  calendar: string;
  color: string | null;
  title: string;
  location: string | null;
  allDay: boolean;
  start: number;
  end: number;
}

export interface AccountView {
  calendars: number;
  events: number;
  syncedAt: number | null;
  error: string | null;
}

export interface LinkView {
  id: string;
  name: string;
  provider: string;
  events: number;
  syncedAt: number | null;
  error: string | null;
}

export interface CaldavState {
  connected: boolean;
  syncedAt: number | null;
  account: AccountView | null;
  links: LinkView[];
  calendars: { name: string; color: string | null }[];
  events: CalEvent[];
}

const EMPTY: CaldavState = { connected: false, syncedAt: null, account: null, links: [], calendars: [], events: [] };

export function useCaldav(): CaldavState {
  const [state, setState] = useState<CaldavState>(EMPTY);

  useEffect(() => {
    let alive = true;
    let unlistenFn: (() => void) | undefined;

    invoke<CaldavState>("caldav_get_cache")
      .then((s) => {
        if (alive && s) setState(s);
      })
      .catch(() => {});

    listen<CaldavState>("caldav-updated", (e) => {
      if (alive && e.payload) setState(e.payload);
    })
      .then((fn) => {
        if (!alive) fn();
        else unlistenFn = fn;
      })
      .catch(() => {});

    return () => {
      alive = false;
      unlistenFn?.();
    };
  }, []);

  return state;
}
