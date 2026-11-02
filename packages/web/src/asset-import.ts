import { isIP } from "node:net";
import { ASSET_IMPORT_MAX_CHARACTERS, ASSET_IMPORT_MAX_ITEMS, type AssetImportPreview } from "./asset-import-types.ts";
import {
	type AssetIdentityInput,
	AssetInputError,
	type AssetLibraryStore,
	resolveAssetIdentity,
} from "./asset-library.ts";

/** Parse whole tokens: never turn part of a wildcard, email or CIDR into an asset. */
export function parseAssetImport(text: string): {
	identities: AssetIdentityInput[];
	preview: AssetImportPreview;
} {
	if (text.length > ASSET_IMPORT_MAX_CHARACTERS) throw new AssetInputError("每次最多粘贴 200000 个字符，请分批导入。");
	const tokens = text
		.trim()
		.split(/[\s，]+/u)
		.filter(Boolean)
		.flatMap((part) => {
			// Commas in a URL query or fragment belong to the URL. A newline always
			// separates assets; a comma before another URL also separates them.
			return part.split(/,(?=(?:https?|wss?):\/\/)/i).flatMap((value) => {
				if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && /[?#]/.test(value)) return [value];
				return value.split(",").filter(Boolean);
			});
		});
	if (tokens.length > ASSET_IMPORT_MAX_ITEMS) throw new AssetInputError("每次最多识别 1000 条内容，请分批导入。");
	const preview: AssetImportPreview = { items: [], invalid: [], duplicates: 0, created: 0, merged: 0 };
	const identities: AssetIdentityInput[] = [];
	const seen = new Set<string>();
	for (const input of tokens) {
		try {
			let identity: AssetIdentityInput;
			if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
				identity = { url: input };
			} else {
				const service = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(input);
				const host = (service?.[1] ?? input).replace(/^\[([^\]]+)\]$/, "$1");
				const address = isIP(host) !== 0;
				if (!address && (!host.includes(".") || /^[\d.]+$/.test(host))) {
					throw new AssetInputError("无法识别为域名、IP、主机:端口或 URL。");
				}
				identity = {
					...(address ? { ip: host } : { domain: host }),
					...(service ? { port: Number(service[2]) } : {}),
				};
			}
			const resolved = resolveAssetIdentity(identity);
			if (seen.has(resolved.dedupeKey)) {
				preview.duplicates += 1;
				continue;
			}
			seen.add(resolved.dedupeKey);
			identities.push(identity);
			preview.items.push({
				input,
				kind: resolved.kind,
				name: resolved.name,
				existing: false,
				warnings: resolved.warnings,
			});
		} catch (error) {
			if (!(error instanceof AssetInputError)) throw error;
			preview.invalid.push({ input, reason: error.message });
		}
	}
	return { identities, preview };
}

export function previewAssetImport(store: AssetLibraryStore, projectId: string, text: string): AssetImportPreview {
	const { identities, preview } = parseAssetImport(text);
	preview.items.forEach((item, index) => {
		item.existing = store.hasIdentity(projectId, identities[index]);
		if (item.existing) preview.merged += 1;
		else preview.created += 1;
	});
	return preview;
}
