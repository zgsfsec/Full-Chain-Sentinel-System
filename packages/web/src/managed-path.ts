/**
 * Whether a file lies inside a directory, whichever way this platform writes
 * the separator.
 *
 * The comparison goes through `relative`, not through a prefix that ends in a
 * slash. Windows writes a backslash between folders, so a prefix ending in `/`
 * never matched there: every session file looked as if it came from outside the
 * console's session directory, and none could be renamed or deleted. A user on
 * Windows reported exactly that.
 *
 * The path functions are a parameter so that another platform's paths can be
 * tried on any machine.
 */
import path from "node:path";

type PathFunctions = Pick<typeof path, "relative" | "isAbsolute" | "sep">;

/** Both paths absolute, as `resolve` leaves them. The directory itself is not inside itself. */
export function isInsideDirectory(directory: string, file: string, paths: PathFunctions = path): boolean {
	const within = paths.relative(directory, file);
	return within !== "" && within !== ".." && !within.startsWith(`..${paths.sep}`) && !paths.isAbsolute(within);
}
