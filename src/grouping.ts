import { LibraryItem } from "./types";

export interface DayGroup {
  label: string;
  items: LibraryItem[];
}

/** Normalize an aarlo created_at to epoch milliseconds. */
export function toMs(createdAt: number): number {
  return createdAt > 1e12 ? createdAt : createdAt * 1000;
}

/**
 * How times should be displayed. `timeZone` / `locale` left undefined mean
 * "use the browser's own setting".
 */
export interface TimeSettings {
  timeZone?: string;
  locale?: string;
  hour12?: boolean;
}

/** The subset of `hass` we read; kept loose because older HA versions lack fields. */
interface HassTimeSource {
  config?: { time_zone?: string };
  locale?: { language?: string; time_format?: string; time_zone?: string };
}

/**
 * Derive display settings from the user's Home Assistant profile:
 * - time zone: profile "Use server time zone" -> HA's configured zone,
 *   "Use your local time zone" -> browser zone; HA's zone if no profile setting.
 * - locale: the profile language.
 * - 12/24h: the profile "Time format" (12 / 24 / language / system).
 */
export function timeSettingsFromHass(hass?: HassTimeSource): TimeSettings {
  const loc = hass?.locale;
  const serverTz = hass?.config?.time_zone || undefined;
  const timeZone = loc?.time_zone === "local" ? undefined : serverTz;

  let locale = loc?.language || undefined;
  let hour12: boolean | undefined;
  switch (loc?.time_format) {
    case "12":
      hour12 = true;
      break;
    case "24":
      hour12 = false;
      break;
    case "system":
      locale = undefined; // let the browser/OS decide
      break;
    default:
      break; // "language" or unset: the locale decides
  }
  return { timeZone, locale, hour12 };
}

/** y-m-d string for an instant in a given IANA timezone (undefined = browser). */
function dayKey(ms: number, tz?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

function prettyLabel(ms: number, tz?: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(ms));
}

export function groupByDay(
  items: LibraryItem[],
  tz: string | undefined,
  now: number,
  locale?: string
): DayGroup[] {
  if (items.length === 0) return [];

  const todayKey = dayKey(now, tz);
  const yesterdayKey = dayKey(now - 24 * 60 * 60 * 1000, tz);

  // Newest first overall.
  const sorted = [...items].sort(
    (a, b) => toMs(b.created_at) - toMs(a.created_at)
  );

  const buckets = new Map<string, LibraryItem[]>();
  const order: string[] = [];
  for (const it of sorted) {
    const key = dayKey(toMs(it.created_at), tz);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(it);
  }

  return order.map((key) => {
    const items = buckets.get(key)!;
    let label: string;
    if (key === todayKey) label = "Today";
    else if (key === yesterdayKey) label = "Yesterday";
    else label = prettyLabel(toMs(items[0].created_at), tz, locale);
    return { label, items };
  });
}
