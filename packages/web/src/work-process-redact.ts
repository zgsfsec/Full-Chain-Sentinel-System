import { redact } from "./supervisor-digest.ts";

/** Tool arguments often encode credentials as quoted JSON keys rather than headers. */
export function redactWorkText(text: string): string {
	return redact(
		text.replace(
			/("(?:authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
			'$1"[REDACTED]"',
		),
	);
}
