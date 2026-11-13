import { describe, expect, it } from "vitest";
import { scheduleConfig } from "../src/config";

describe("scheduleConfig", () => {
  it("parses valid input", () => {
    expect(
      scheduleConfig({
        BATCH_HOURS: " 22, 7,12 ,17,7",
        BATCH_MIN: "4",
        BATCH_MAX: "12",
        DRILL_REMINDER_HOUR: "12",
        QUIET_START_HOUR: "21",
        QUIET_END_HOUR: "6",
      }),
    ).toEqual({ batchHours: [7, 12, 17, 22], batchMin: 4, batchMax: 12, drillReminderHour: 12, quiet: { start: 21, end: 6 } });
  });

  it("uses the defaults from design.md when vars are missing or empty", () => {
    const defaults = { batchHours: [7, 12, 17, 22], batchMin: 5, batchMax: 15, drillReminderHour: 17, quiet: { start: 22, end: 7 } };
    expect(scheduleConfig({})).toEqual(defaults);
    expect(scheduleConfig({ BATCH_HOURS: "", BATCH_MAX: " " })).toEqual(defaults);
  });

  it("rejects an out-of-range hour", () => {
    expect(() => scheduleConfig({ BATCH_HOURS: "7,12,24" })).toThrow(/BATCH_HOURS/);
    expect(() => scheduleConfig({ DRILL_REMINDER_HOUR: "-1" })).toThrow(/DRILL_REMINDER_HOUR/);
    expect(() => scheduleConfig({ QUIET_END_HOUR: "25" })).toThrow(/QUIET_END_HOUR/);
  });

  it("rejects non-integer values", () => {
    expect(() => scheduleConfig({ BATCH_HOURS: "7,,12" })).toThrow(/BATCH_HOURS/);
    expect(() => scheduleConfig({ BATCH_MAX: "ten" })).toThrow(/BATCH_MAX/);
  });

  it("rejects BATCH_MAX < BATCH_MIN", () => {
    expect(() => scheduleConfig({ BATCH_MIN: "5", BATCH_MAX: "4" })).toThrow(/BATCH_MAX \(4\) must be ≥ BATCH_MIN \(5\)/);
  });

  it("rejects a quiet window that does not span midnight", () => {
    expect(() => scheduleConfig({ QUIET_START_HOUR: "7", QUIET_END_HOUR: "8" })).toThrow(/QUIET_END_HOUR/);
  });
});
