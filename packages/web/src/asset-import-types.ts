import type { SentinelAssetKind } from "./protocol.ts";

export const ASSET_IMPORT_MAX_CHARACTERS = 200_000;
export const ASSET_IMPORT_MAX_ITEMS = 1000;

export interface AssetImportPreview {
	items: { input: string; kind: SentinelAssetKind; name: string; existing: boolean; warnings: string[] }[];
	invalid: { input: string; reason: string }[];
	duplicates: number;
	created: number;
	merged: number;
}

export interface AssetImportResult {
	created: number;
	merged: number;
	duplicates: number;
	invalid: number;
}
