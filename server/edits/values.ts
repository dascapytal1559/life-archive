// An edit's value as the page sends it (viewer/editWire.ts), read to its field's kind before its owner sees it, and an
// edit's value in words for the record (log.ts). A time is the archive's wall clock ("2026-10-04T19:30"), read in the
// archive's time zone (src/time.ts), never the browser's; an owner turns it into an instant with instantOf.

import { InvalidInputError } from "../errors.ts";
import { dayKey, isClockTime, isDay, timeOfDay, wallClock } from "../../src/time.ts";
import { editValueText, TEXT_MOST, type EditField, type EditValue } from "../../viewer/editWire.ts";

/** The longest note a field takes. */
export const NOTE_MOST = 2000;

/** The archive's wall clock of `ms`, as an edit's time is written: "2026-10-04T19:30". */
export const wallText = (ms: number): string => `${dayKey(ms)}T${timeOfDay(ms)}`;

/** A time as an edit writes it ("2026-10-04T19:30"), split: its date, and its time of day or null for a date alone. */
export function wallParts(text: string): { day: string; time: string | null } {
  const [day, time] = text.split("T");
  return { day: day!, time: time ?? null };
}

/** The instant of a time as an edit writes it, in the archive's time zone; a date alone is its midnight. */
export const instantOf = (text: string): number => {
  const { day, time } = wallParts(text);
  return wallClock(day, time ?? "00:00");
};

/** `value` read as `field` takes it; InvalidInputError, saying what it takes, for anything else. */
export function readValue(field: EditField, value: unknown): EditValue {
  const what = field.label.toLowerCase();
  if (value === null || value === "") {
    if (field.input === "tags") return [];
    if (field.clearable || field.input === "note") return null;
    throw new InvalidInputError(`${field.label} cannot be left empty`);
  }
  switch (field.input) {
    case "datetime": {
      const text = typeof value === "string" ? value.trim() : "";
      const [day, time, ...rest] = text.split("T");
      if (rest.length > 0 || !isDay(day ?? "") || (time === undefined ? !field.dateOnly : !isClockTime(time))) {
        throw new InvalidInputError(`${field.label} is a date and time, 2026-10-04T19:30${field.dateOnly ? ", or a date alone" : ""}`);
      }
      return text;
    }
    case "minutes": {
      if (!Number.isInteger(value) || (value as number) < (field.min ?? 1) || (value as number) > (field.max ?? 24 * 60)) {
        throw new InvalidInputError(`${field.label} is a whole number of minutes, from ${field.min ?? 1} to ${field.max ?? 24 * 60}`);
      }
      return value as number;
    }
    case "hours":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new InvalidInputError(`${field.label} is a number`);
      if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
        throw new InvalidInputError(`${field.label} is from ${field.min ?? "any"} to ${field.max ?? "any"}${field.unit ? ` ${field.unit}` : ""}`);
      }
      return Math.round(value * 100) / 100;
    }
    case "choice": {
      if (typeof value !== "string" || !field.choices?.some((choice) => choice.value === value)) {
        throw new InvalidInputError(`${field.label} is one of ${field.choices?.map((c) => c.label).join(", ") ?? "nothing"}`);
      }
      return value;
    }
    case "people": {
      if (!Array.isArray(value) || value.length === 0 || !value.every((id) => Number.isSafeInteger(id) && id > 0)) throw new InvalidInputError(`${field.label} is one person or more, by number`);
      return [...new Set(value as number[])];
    }
    case "note": {
      if (typeof value !== "string") throw new InvalidInputError(`a ${what} is text`);
      const clean = value.replace(/\r\n?/g, "\n").trim();
      if (clean.length > NOTE_MOST) throw new InvalidInputError(`a ${what} is at most ${NOTE_MOST} characters`);
      return clean === "" ? null : clean;
    }
    case "text": {
      if (typeof value !== "string") throw new InvalidInputError(`${field.label} is text`);
      // One line but for a long one; its owner reads the rest (a name's own rules, a location's spelling).
      const clean = field.long ? value.replace(/\r\n?/g, "\n").trim() : value.replace(/\s+/g, " ").trim();
      if (clean.length > TEXT_MOST) throw new InvalidInputError(`${field.label} is at most ${TEXT_MOST} characters`);
      if (clean === "") {
        if (field.clearable) return null;
        throw new InvalidInputError(`${field.label} cannot be left empty`);
      }
      return clean;
    }
    case "tags": {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new InvalidInputError(`${field.label} is a list of words`);
      const clean = [...new Set((value as string[]).map((item) => item.replace(/\s+/g, " ").trim()).filter((item) => item !== ""))];
      if (clean.some((item) => item.length > TEXT_MOST)) throw new InvalidInputError(`each of ${field.label} is at most ${TEXT_MOST} characters`);
      return clean;
    }
  }
}

/** An edit's value in words, for the record: never a note's words (null), else as the page says it (editWire.ts's editValueText). */
export const valueText = (field: EditField, value: EditValue, names: Record<number, string> = {}): string | null =>
  field.input === "note" ? null : editValueText(field, value, names);
