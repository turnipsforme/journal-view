/** Which calendar dates may appear without a daily note. */
export type EmptyDayVisibility = "all" | "notes" | "future";

export const EMPTY_DAY_VISIBILITY_OPTIONS: Record<EmptyDayVisibility, string> = {
	all: "Show all days",
	notes: "Only days with notes",
	future: "Hide empty past days",
};

export const EMPTY_DAY_VISIBILITY_DESCRIPTION =
	"Choose which days without daily notes appear. Today is always shown.";

export function isEmptyDayVisibility(value: unknown): value is EmptyDayVisibility {
	return value === "all" || value === "notes" || value === "future";
}

/** Preserve both states of the former hideEmptyDays toggle. */
export function emptyDayVisibilitySetting(value: unknown, legacy: unknown): EmptyDayVisibility {
	return isEmptyDayVisibility(value) ? value : legacy === false ? "all" : "notes";
}

/** Offsets are calendar days relative to today (negative means past). */
export function hidesEmptyDay(mode: EmptyDayVisibility, offset: number): boolean {
	return mode === "notes" || (mode === "future" && offset < 0);
}
