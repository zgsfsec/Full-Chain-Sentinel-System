/** Apply a textarea edit without normalizing unchanged CRLF bytes in the HTTP body. */
export function editWebFuzzRaw(previous: string, value: string): string {
	const normalized = previous.replace(/\r\n?/g, "\n");
	let prefix = 0;
	while (prefix < normalized.length && prefix < value.length && normalized[prefix] === value[prefix]) prefix++;
	let suffix = 0;
	while (suffix < normalized.length - prefix && suffix < value.length - prefix && normalized[normalized.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++;
	const offsets = [0];
	for (let index = 0; index < previous.length; index++) {
		if (previous[index] === "\r" && previous[index + 1] === "\n") index++;
		offsets.push(index + 1);
	}
	const newline = previous.includes("\r\n") ? "\r\n" : "\n";
	return previous.slice(0, offsets[prefix]) + value.slice(prefix, value.length - suffix).replace(/\n/g, newline) + previous.slice(offsets[normalized.length - suffix]);
}
