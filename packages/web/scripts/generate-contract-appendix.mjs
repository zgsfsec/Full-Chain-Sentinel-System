#!/usr/bin/env node
/**
 * Generate the contract appendix: the server-side message table and the
 * constants the browser and the server have to agree on.
 *
 * A backend written in another language cannot import the TypeScript constants,
 * so they are written out as JSON next to the contract documents. The appendix
 * is generated from the source so it cannot drift; `--check` fails when it has.
 *
 * Usage: node scripts/generate-contract-appendix.mjs [--check]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSET_IMPORT_MAX_CHARACTERS } from "../src/asset-import-types.ts";
import { CODE_VULN_TAGS } from "../src/code-vuln-tags.ts";
import { MAX_CODE_HISTORY_COMMITS } from "../src/code-monitor-limits.ts";
import { CREDENTIAL_GROUPS, CREDENTIAL_TYPES } from "../src/credential-types.ts";
import { DEFAULT_CRON_EXPRESSION } from "../src/cron.ts";
import { DEFAULT_UI_LANGUAGE, EN_MESSAGES } from "../src/i18n-messages.ts";
import { REMOTE_MODEL_APIS } from "../src/remote-model-types.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const outDir = join(packageRoot, "docs", "contract", "appendix");
const check = process.argv.includes("--check");

// The languages are a type, so there is no list to import; read them from the
// declaration instead of writing them here a second time.
const languageDeclaration = /^export type UiLanguage = (.+);$/m.exec(
	readFileSync(join(packageRoot, "src", "i18n-messages.ts"), "utf8"),
)?.[1];
const languages = languageDeclaration === undefined ? [] : [...languageDeclaration.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
if (languages.length === 0) {
	console.error("src/i18n-messages.ts 里找不到 UiLanguage 的取值");
	process.exit(1);
}

// Sorted keys, so two runs over the same source write the same bytes.
function stable(value) {
	return `${JSON.stringify(
		value,
		// Object keys are sorted at every depth; arrays keep their order.
		(_, item) => (item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item),
		"\t",
	)}\n`;
}

const messages = stable({
	description: "服务端文案表：键是中文原文，值是英文。界面语言为 en 时，服务端按这个表把文案换成英文；表里没有的键原样返回。花括号占位符由调用方替换。",
	defaultLanguage: DEFAULT_UI_LANGUAGE,
	messages: EN_MESSAGES,
});

const constants = stable({
	description: "浏览器和服务端必须取值一致的常量，从服务端源码生成。",
	ui: { languages, default: DEFAULT_UI_LANGUAGE },
	credentials: { groups: CREDENTIAL_GROUPS, types: CREDENTIAL_TYPES },
	codeIntel: {
		vulnTags: CODE_VULN_TAGS,
		maxHistoryCommits: MAX_CODE_HISTORY_COMMITS,
		defaultCronExpression: DEFAULT_CRON_EXPRESSION,
	},
	models: { remoteModelApis: REMOTE_MODEL_APIS },
	assets: { importMaxCharacters: ASSET_IMPORT_MAX_CHARACTERS },
});

const files = [
	["messages.json", messages, "文案表"],
	["constants.json", constants, "常量表"],
];

let outdated = 0;
for (const [name, contents, label] of files) {
	const path = join(outDir, name);
	if (check) {
		let current = "";
		try {
			current = readFileSync(path, "utf8");
		} catch {
			// Reported below as outdated: the file is missing.
		}
		if (current !== contents) {
			outdated += 1;
			console.error(`契约附录 ${name}（${label}）与源码不一致，请运行 npm --prefix packages/web run generate:contract`);
		}
		continue;
	}
	mkdirSync(outDir, { recursive: true });
	writeFileSync(path, contents);
	console.log(`已生成 docs/contract/appendix/${name}（${label}）`);
}
if (outdated > 0) process.exit(1);
if (check) console.log("契约附录与源码一致");
