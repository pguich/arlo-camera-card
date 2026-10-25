import { describe, it, expect } from "vitest";
import { toMs, groupByDay, timeSettingsFromHass } from "../src/grouping";
import { LibraryItem } from "../src/types";

const TZ = "Pacific/Auckland";
// Reference "now": 2026-06-08 12:00 NZ  (NZST = UTC+12) => 2026-06-08T00:00:00Z
const NOW = Date.UTC(2026, 5, 8, 0, 0, 0);

function item(entity_id: string, createdMs: number): LibraryItem {
  return { entity_id, created_at: createdMs, url: "u", thumbnail: "t" };
}

describe("toMs", () => {
  it("passes through millisecond timestamps", () => {
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
  it("upscales second timestamps to ms", () => {
    expect(toMs(1_700_000_000)).toBe(1_700_000_000_000);
  });
});

describe("groupByDay", () => {
  it("buckets into Today / Yesterday / dated, newest first", () => {
    const todayNoon = Date.UTC(2026, 5, 8, 0, 0, 0); // 8 Jun 12:00 NZ
    const todayMorning = Date.UTC(2026, 5, 7, 20, 0, 0); // 8 Jun 08:00 NZ
    const yesterday = Date.UTC(2026, 5, 6, 22, 0, 0); // 7 Jun 10:00 NZ
    const older = Date.UTC(2026, 5, 4, 22, 0, 0); // 5 Jun 10:00 NZ

    const groups = groupByDay(
      [
        item("camera.a", older),
        item("camera.a", yesterday),
        item("camera.a", todayMorning),
        item("camera.a", todayNoon),
      ],
      TZ,
      NOW,
      "en-NZ"
    );

    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "Fri, 5 Jun",
    ]);
    // Today group has 2 items, newest (noon) first
    expect(groups[0].items.map((i) => i.created_at)).toEqual([
      todayNoon,
      todayMorning,
    ]);
  });

  it("returns [] for no items", () => {
    expect(groupByDay([], TZ, NOW)).toEqual([]);
  });
});

describe("timeSettingsFromHass", () => {
  const hass = (locale: object) => ({
    config: { time_zone: "Europe/Zurich" },
    locale: { language: "en-GB", ...locale },
  });

  it("uses HA's configured zone for 'server' and when unset", () => {
    expect(timeSettingsFromHass(hass({ time_zone: "server" })).timeZone).toBe(
      "Europe/Zurich"
    );
    expect(timeSettingsFromHass(hass({})).timeZone).toBe("Europe/Zurich");
  });

  it("uses the browser zone for 'local'", () => {
    expect(
      timeSettingsFromHass(hass({ time_zone: "local" })).timeZone
    ).toBeUndefined();
  });

  it("maps the profile time format to hour12", () => {
    expect(timeSettingsFromHass(hass({ time_format: "24" })).hour12).toBe(false);
    expect(timeSettingsFromHass(hass({ time_format: "12" })).hour12).toBe(true);
    expect(
      timeSettingsFromHass(hass({ time_format: "language" })).hour12
    ).toBeUndefined();
  });

  it("uses the profile language as locale", () => {
    expect(timeSettingsFromHass(hass({})).locale).toBe("en-GB");
  });

  it("formats a Zurich 17:01 recording as 17:01, not NZ time", () => {
    // 2026-10-25 17:01 Europe/Zurich (UTC+1) = 16:01Z
    const t = timeSettingsFromHass(hass({ time_format: "24" }));
    const label = new Intl.DateTimeFormat(t.locale, {
      timeZone: t.timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: t.hour12,
    }).format(new Date(Date.UTC(2026, 9, 25, 16, 1)));
    expect(label).toBe("17:01");
  });
});
