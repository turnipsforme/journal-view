import type { GoToNotePosition } from "./settings";

/** Keep Auto unresolved until the destination editor and its template are loaded. */
export type NavigationPlacement = boolean | "auto";
export const AUTO_TOP_LINE_COUNT = 20;

export function navigationPlacement(position: GoToNotePosition): NavigationPlacement {
	return position === "auto" ? "auto" : position === "bottom";
}

/** Counts source lines in the visible note body, stopping at the threshold. */
export function autoNavigatesToEnd(body: string): boolean {
	let lines = 1;
	for (let index = 0; index < body.length; index++) {
		const code = body.charCodeAt(index);
		if (code !== 10 && code !== 13) continue;
		if (++lines >= AUTO_TOP_LINE_COUNT) return false;
		if (code === 13 && body.charCodeAt(index + 1) === 10) index++;
	}
	return true;
}
