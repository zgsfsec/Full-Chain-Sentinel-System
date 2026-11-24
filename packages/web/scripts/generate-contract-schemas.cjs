#!/usr/bin/env node
/**
 * Generate JSON Schema for every message of the WebSocket protocol and for the
 * values the HTTP routes exchange, straight from the TypeScript types, with the
 * comments of the type definitions as the description of each field.
 *
 * The repository compiles with TypeScript 7, which has no JavaScript API to
 * read types with, so this runs on a TypeScript 5 install given by
 * CONTRACT_TYPESCRIPT:
 *
 *   CONTRACT_TYPESCRIPT=/path/to/node_modules/typescript \
 *     node scripts/generate-contract-schemas.cjs [--check]
 *
 * The output records a hash of the type sources it read. `--check` fails when
 * they have changed since. `--check-source` reads that record and the sources
 * alone, so it needs no TypeScript: it is what `npm run check` runs.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");


const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const outFile = path.join(packageRoot, "docs", "contract", "frontend", "schemas.generated.json");

/**
 * What decides whether the output is stale: the content of every source the
 * program read, and of the tsconfig it was compiled with. A file joins the
 * program only through an import in one of those, so that is covered too.
 */
function recordSources(files) {
	const content = crypto.createHash("sha256");
	for (const file of files) content.update(file).update(fs.readFileSync(path.join(repoRoot, file)));
	return { hash: content.digest("hex"), files };
}

// Before TypeScript is asked for: this mode reads the record and the sources only.
if (process.argv.includes("--check-source")) {
	const recorded = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")).typesSource : undefined;
	if (!Array.isArray(recorded?.files)) {
		console.error(`契约结构定义 ${path.relative(repoRoot, outFile)} 没有记录类型来源，请重新生成。`);
		process.exit(1);
	}
	const now = recordSources(recorded.files);
	if (now.hash !== recorded.hash) {
		console.error(
			`契约结构定义 ${path.relative(repoRoot, outFile)} 与类型源码不一致，请重新生成（见 docs/contract/frontend/README.md）。`,
		);
		process.exit(1);
	}
	console.log("契约结构定义与类型源码一致");
	process.exit(0);
}

let ts;
try {
	ts = require(process.env.CONTRACT_TYPESCRIPT ?? "typescript");
} catch (error) {
	console.error(`找不到 TypeScript：${error.message}`);
	console.error("请用 CONTRACT_TYPESCRIPT 指向一个带 JavaScript API 的 TypeScript 5 安装目录。");
	process.exit(1);
}
if (typeof ts.createProgram !== "function") {
	console.error("这个 TypeScript 没有 JavaScript API（7.x 不带），请用 CONTRACT_TYPESCRIPT 指向 TypeScript 5 的安装目录。");
	process.exit(1);
}

const src = (...parts) => path.join(packageRoot, "src", ...parts);

/** The values the HTTP routes exchange, by the name the documents use for them. */
const HTTP_ROOTS = [
	["Http.ReportPage", 'ReturnType<ReportStore["list"]>'],
	["Http.ReportDetail", 'NonNullable<ReturnType<ReportStore["get"]>>'],
	["Http.ReportUpdated", 'NonNullable<ReturnType<ReportStore["updateText"]>>'],
	["Http.ReportTemplateList", "{ items: ReportTemplateSummary[]; defaultTemplateId: string | null }"],
	["Http.ReportTemplate", "ReportTemplate"],
	["Http.WorkProcessList", "{ items: WorkProcessItem[] }"],
	["Http.WorkProcessDetail", "{ process: WorkProcess }"],
	["Http.WorkProcessRevisions", '{ revisions: ReturnType<WorkProcesses["revisions"]> }'],
	["Http.WorkProcessEvidence", 'Awaited<ReturnType<WorkProcesses["original"]>>'],
	["Http.MitmStatus", 'Awaited<ReturnType<MitmCenter["status"]>>'],
	["Http.MitmStorage", 'Awaited<ReturnType<MitmCenter["storage"]>>'],
	["Http.MitmFlows", 'Awaited<ReturnType<MitmCenter["listFlows"]>>'],
	["Http.MitmFlow", "Awaited<ReturnType<typeof getMitmFlow>>"],
	["Http.WebFuzzState", 'ReturnType<MitmCenter["webFuzzState"]>'],
	["Http.WebFuzzRequest", 'Awaited<ReturnType<MitmCenter["importWebFuzz"]>>'],
	["Http.WebFuzzReplayResult", 'Awaited<ReturnType<MitmCenter["replay"]>>'],
	["Http.IntelligenceSources", 'ReturnType<IntelligenceStore["sources"]>'],
	["Http.IntelligenceSourceCreate", 'ReturnType<IntelligenceStore["createSource"]>'],
	["Http.IntelligenceSourceUpdate", 'ReturnType<IntelligenceStore["updateSource"]>'],
	["Http.IntelligencePolicy", "IntelligencePolicy"],
	["Http.IntelligenceDoctrines", 'ReturnType<IntelligenceStore["doctrines"]>'],
	["Http.IntelligenceIndicators", 'ReturnType<IntelligenceStore["indicators"]>'],
	["Http.IntelligenceAlerts", 'ReturnType<IntelligenceStore["alerts"]>'],
	["Http.IntelligenceBatches", 'ReturnType<IntelligenceStore["batches"]>'],
	["Http.IntelligenceBatch", 'NonNullable<ReturnType<IntelligenceStore["batch"]>>'],
	["Http.IntelligencePush", "IntelligencePush"],
	["Http.IntelligenceReceipt", 'ReturnType<IntelligenceStore["ingest"]>'],
	["Http.IntelligenceCleanupResult", 'ReturnType<IntelligenceStore["cleanup"]>'],
	["Http.SecurityCheckRules", '{ rules: Array<Omit<SecurityCheckRule, "text">>; sources: SecurityCheckSource[] }'],
	["Http.SecurityCheckRule", "SecurityCheckRule"],
	["Http.SecurityCheckSource", "SecurityCheckSource"],
	["Http.SecurityCheckSubmitResult", 'Awaited<ReturnType<SecurityChecks["submit"]>>'],
	["Http.CredentialList", "{ items: CredentialView[] }"],
	[
		"Http.CredentialImportPreview",
		'{ items: Array<CredentialView & { operation: ReturnType<CredentialStore["prepare"]>[number]["action"] }>; version: string }',
	],
	// What `parseCredential` reads: only the type and the host have to be there,
	// and the port may come as text from a form.
	[
		"Http.CredentialInput",
		'Omit<Partial<CredentialInput>, "type" | "host" | "port"> & { type: string; host: string; port?: number | string | null }',
	],
	["Http.RemoteModelList", "RemoteModelList"],
	["Http.EgressIpResult", "{ result: ProjectEgressIp | null }"],
	["Http.PocImportJob", "PocImportJobView"],
	["Http.AssetImportPreview", "AssetImportPreview"],
	// What the routes read out of a request body, where a parser in the source
	// defines it and no named type does.
	["Http.AssetImportResult", 'ReturnType<AssetLibraryStore["upsertMany"]> & { duplicates: number; invalid: number }'],
	// The MITM routes take the project in the body, next to everything else.
	["Http.MitmConfigInput", "{ projectId: string } & Partial<MitmConfig> & { password?: string }"],
	["Http.MitmFlowsQuery", '{ page?: number; pageSize?: number; q?: string; host?: string; path?: string; since?: number; until?: number; method?: string; status?: string; refreshCount?: "1"; cursor?: string }'],
	["Http.WebFuzzSendInput", "{ projectId: string; request: WebFuzzRequest; password?: string }"],
	["Http.WebFuzzWorkspaceInput", "{ projectId: string; tabs: WebFuzzTab[]; activeId: string | null }"],
	["Http.ConsentStatement", "{ required: boolean; acceptedAt: string | null; version: number; text: ConsentText }"],
	[
		"Http.IntelligencePolicyInput",
		'Omit<IntelligencePolicy, "template"> & { template: Omit<IntelligenceTemplate, "name" | "prompt" | "limits"> & { limits: Omit<SentinelEngineLimits, "maxRetries"> } }',
	],
	["Http.IntelligenceCleanupInput", "IntelligenceCleanup"],
	["Http.SecurityCheckSourceInput", '{ id?: string } & Pick<SecurityCheckSource, "name" | "repository" | "branch" | "directory" | "enabled" | "intervalHours">'],
	[
		"Http.SecurityCheckSubmitInput",
		'{ projectId: string; requestId: string; input: Omit<SentinelEngineCreateInput, "doctrines" | "targets"> & { targets?: string }; rules: Array<Pick<SecurityCheckRule, "id" | "version">>; credentials?: CredentialRef[]; requirements?: string }',
	],
	["Http.SecurityCheckHistoryList", "{ items: SecurityCheckSyncRecord[] }"],
	["Http.CredentialSaveInput", "{ input: CredentialInput; id?: string; revision?: string }"],
	["Http.CredentialConfirmInput", "{ refs: CredentialRef[] }"],
	["Http.CredentialRef", "CredentialRef"],
	["Http.GateAuditFilter", "SentinelGateFilter"],
	["Http.ConsentStatus", "ConsentStatus"],
];

/** The import lines of the generated file, relative to where it is written. */
function importsFor(fromDir) {
	return [
		["ClientExample, ServerExample", path.join(packageRoot, "test", "contract", "examples", "types.ts")],
		["AssetImportPreview", src("asset-import-types.ts")],
		["AssetLibraryStore", src("asset-library.ts")],
		["ConsentStatus, ConsentText", src("consent.ts")],
		["CredentialInput, CredentialView", src("credential-types.ts")],
		["CredentialRef", src("credentials.ts")],
		["CredentialStore", src("credential-store.ts")],
		["getMitmFlow", src("mitm-store.ts")],
		["IntelligenceCleanup, IntelligencePolicy, IntelligencePush, IntelligenceTemplate", src("intelligence-types.ts")],
		["IntelligenceStore", src("intelligence-store.ts")],
		["MitmCenter", src("mitm.ts")],
		["MitmConfig", src("mitm-types.ts")],
		["PocImportJobView", src("poc-import.ts")],
		["ProjectEgressIp", src("project-egress-types.ts")],
		["SentinelEngineCreateInput, SentinelEngineLimits, SentinelGateFilter", src("protocol.ts")],
		["RemoteModelList", src("remote-model-types.ts")],
		["ReportStore", src("reports.ts")],
		["ReportTemplate, ReportTemplateSummary", src("report-types.ts")],
		["SecurityChecks", src("security-checks.ts")],
		["SecurityCheckRule, SecurityCheckSource, SecurityCheckSyncRecord", src("security-check-types.ts")],
		["WebFuzzRequest, WebFuzzTab", src("webfuzz-types.ts")],
		["WorkProcess, WorkProcessItem", src("work-process-types.ts")],
		["WorkProcesses", src("work-process.ts")],
	]
		.map(([names, file]) => {
			const relative = path.relative(fromDir, file).replaceAll("\\", "/");
			return `import type { ${names} } from "${relative.startsWith(".") ? "" : "./"}${relative}";`;
		})
		.join("\n");
}

/** The names of the members of a message union, read from the protocol source. */
function unionMembers(source, unionName) {
	const lines = source.split("\n");
	const start = lines.findIndex((line) => line === `export type ${unionName} =`);
	if (start < 0) throw new Error(`export type ${unionName} = not found`);
	const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
	const names = [];
	for (const line of lines.slice(start + 1, end)) {
		const match = /^\t\| \{ type: "([a-z_]+)"|\t\t\ttype: "([a-z_]+)"/.exec(line);
		if (match) names.push(match[1] ?? match[2]);
	}
	return [...new Set(names)];
}

const protocol = fs.readFileSync(src("protocol.ts"), "utf8");
const roots = [
	...unionMembers(protocol, "SentinelClientMessage").map((name) => ({ key: `Ws.client.${name}`, expression: `ClientExample<"${name}">` })),
	...unionMembers(protocol, "SentinelServerMessage").map((name) => ({ key: `Ws.server.${name}`, expression: `ServerExample<"${name}">` })),
	...HTTP_ROOTS.map(([key, expression]) => ({ key, expression })),
];

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-contract-schemas-"));
try {
	const declarations = path.join(tempDir, "roots.ts");
	fs.writeFileSync(
		declarations,
		`${importsFor(tempDir)}\n${roots.map((root, index) => `declare const root${index}: ${root.expression};`).join("\n")}\nexport {};\n`,
	);

	const config = ts.readConfigFile(path.join(repoRoot, "tsconfig.json"), ts.sys.readFile);
	if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
	const program = ts.createProgram({ rootNames: [declarations], options: { ...parsed.options, noEmit: true } });
	const checker = program.getTypeChecker();
	const sourceFile = program.getSourceFile(declarations);
	const problems = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName === declarations);
	for (const diagnostic of problems) {
		const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
		console.error(`roots.ts:${position.line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
	}
	if (problems.length > 0) process.exit(1);

	/** What a declaration's comments say about it. */
	function documentation(node) {
		if (!node) return {};
		// What the standard library says about `ReturnType` is not a description
		// of a value the console sends.
		const file = node.getSourceFile()?.fileName ?? "";
		if (file.includes("node_modules") || /\/lib\.[^.]+\.d\.ts$/.test(file)) return {};
		const comments = ts.getJSDocCommentsAndTags(node);
		const blocks = comments.filter((comment) => comment.kind === ts.SyntaxKind.JSDoc);
		const description = blocks
			.map((block) => (typeof block.comment === "string" ? block.comment : ""))
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		// The tags of a block, and the tags the call hands back on their own.
		const tags = [...blocks.flatMap((block) => [...(block.tags ?? [])]), ...comments.filter((comment) => comment.kind === ts.SyntaxKind.JSDocTag)];
		return {
			...(description ? { description } : {}),
			...(tags.some((tag) => tag.tagName.text === "deprecated") ? { deprecated: true } : {}),
		};
	}

	const isLiteral = (part) =>
		part.isStringLiteral() || part.flags & (ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.BigIntLiteral);
	const defs = new Map(); // name → schema, or null while it is being written
	const defDocs = new Map(); // name → the documentation of its declaration
	const names = new Map(); // declaration → name

	/**
	 * A short label for a type argument, so that two uses of the same generic
	 * type with different arguments read apart: `Omit__SentinelX_sessions`.
	 */
	function labelOf(type, seeing = new Set()) {
		if (type.aliasSymbol) return definitionName(type, seeing);
		if (isLiteral(type)) return String(type.isStringLiteral() ? type.value : type.flags & ts.TypeFlags.BooleanLiteral ? type.intrinsicName : type.value);
		if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never))
			return type.intrinsicName;
		if (type.isUnion())
			return type.types.map((part) => labelOf(part, seeing)).join(type.types.every(isLiteral) ? "_" : "_or_");
		// `A & { added: boolean }` reads as the two parts joined.
		if (type.isIntersection()) return type.types.map((part) => labelOf(part, seeing)).join("_and_");
		const symbol = type.symbol;
		if (symbol && symbol.getName() !== "__type") {
			const arguments_ = type.target ? checker.getTypeArguments(type) : [];
			return [symbol.getName(), ...arguments_.map((argument) => labelOf(argument, seeing))].join("__");
		}
		// An inline object names itself after the literal values it fixes, or
		// else after its properties.
		if (type.flags & ts.TypeFlags.Object) {
			const members = type.getProperties().map((property) => [property.getName(), checker.getTypeOfSymbolAtLocation(property, sourceFile)]);
			const fixed = members.filter(([, propertyType]) => isLiteral(propertyType)).map(([name, propertyType]) => `${name}_${labelOf(propertyType, seeing)}`);
			if (fixed.length > 0) return fixed.join("_");
			const names = members.map(([name]) => name);
			if (names.length > 0) return names.join("_");
		}
		if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) return type.intrinsicName;
		return `T${type.id}`;
	}

	/**
	 * A stable name for what a declaration declares with these type arguments.
	 * Two uses of a generic type are two definitions; a name taken twice gets a
	 * number.
	 */
	function definitionName(type, seeing = new Set()) {
		const symbol = type.aliasSymbol ?? type.symbol;
		const declaration = symbol?.declarations?.[0];
		if (!symbol || !declaration) return undefined;
		// An alias instantiation carries its arguments with it; a reference to a
		// generic class or interface has them on its target.
		const arguments_ = type.aliasSymbol ? (type.aliasTypeArguments ?? []) : type.target ? checker.getTypeArguments(type) : [];
		const identity = `${declaration.getSourceFile()?.fileName}:${declaration.pos}:${symbol.getName()}:${arguments_.map((argument) => argument.id).join(",")}`;
		if (names.has(identity)) return names.get(identity);
		if (seeing.has(type.id)) return `T${type.id}`;
		seeing.add(type.id);
		const base = [symbol.getName(), ...arguments_.map((argument) => labelOf(argument, seeing))].join("__");
		const taken = new Set(names.values());
		let name = base;
		for (let suffix = 2; taken.has(name); suffix++) name = `${base}_${suffix}`;
		names.set(identity, name);
		return name;
	}

	/** A reference to the definition of a named type, writing the definition once. */
	function referenceTo(type) {
		const symbol = type.aliasSymbol ?? type.symbol;
		if (!symbol) return undefined;
		const name = symbol.getName();
		if (name === "__type" || name === "Object" || name === "Function") return undefined;
		if (!(symbol.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.Enum))) {
			return undefined;
		}
		const defName = definitionName(type);
		if (!defName) return undefined;
		const ref = { $ref: `#/$defs/${defName}` };
		if (defs.has(defName)) return ref;
		// Registered before it is written: a type that refers to itself gets the reference.
		defs.set(defName, null);
		defDocs.set(defName, documentation(symbol.declarations?.[0]));
		// Written from the type's own shape: the reference above is what a type
		// that refers to itself gets.
		defs.set(defName, convert(type, new Set(), true));
		return ref;
	}

	/** `null` added to a schema that already says what the other values are. */
	function nullable(schema) {
		if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
		if (Array.isArray(schema.enum)) return { ...schema, enum: [...schema.enum, null] };
		return { anyOf: [schema, { type: "null" }] };
	}

	// `resolving` holds the types being looked through, so a constraint that
	// leads back to the type it constrains stops instead of recursing forever.
	function convert(type, resolving = new Set(), shapeOnly = false) {
		const flags = type.flags;
		const list = flags & ts.TypeFlags.Object && (checker.isArrayType(type) || checker.isTupleType(type));
		if (!shapeOnly && !list) {
			const reference = referenceTo(type);
			if (reference) return reference;
		}
		if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return {};
		if (flags & ts.TypeFlags.Never) return { not: {} };
		if (flags & ts.TypeFlags.Null) return { type: "null" };
		if (type.isStringLiteral()) return { const: type.value, ...(type.symbol ? documentation(type.symbol.declarations?.[0]) : {}) };
		if (flags & ts.TypeFlags.NumberLiteral) return { const: type.value };
		if (flags & ts.TypeFlags.BooleanLiteral) return { const: type.intrinsicName === "true" };
		if (flags & ts.TypeFlags.BigIntLiteral) return { const: String(type.value) };
		if (flags & ts.TypeFlags.EnumLike) return type.isUnion() ? union(type.types) : {};
		if (flags & ts.TypeFlags.StringLike) return { type: "string" };
		if (flags & ts.TypeFlags.NumberLike) return { type: "number" };
		if (flags & ts.TypeFlags.BooleanLike) return { type: "boolean" };
		if (flags & ts.TypeFlags.BigIntLike) return { type: "integer" };
		if (type.isUnion()) return union(type.types.filter((part) => !(part.flags & ts.TypeFlags.Undefined)), resolving);
		if (type.isIntersection()) {
			const parts = type.types.map((part) => convert(part, resolving));
			return parts.length === 1 ? parts[0] : { allOf: parts };
		}
		if (flags & ts.TypeFlags.Object) return object(type, resolving, shapeOnly);
		// An indexed access, a conditional or a mapped type: what TypeScript
		// already knows about it, or nothing.
		const resolved = checker.getBaseConstraintOfType(type) ?? checker.getApparentType(type);
		if (!resolved || resolved.id === type.id || resolving.has(resolved.id)) return {};
		resolving.add(type.id);
		return convert(resolved, resolving);
	}

	function union(parts, resolving) {
		const withNull = parts.some((part) => part.flags & ts.TypeFlags.Null);
		const rest = parts.filter((part) => !(part.flags & ts.TypeFlags.Null));
		let schema;
		if (rest.length === 0) schema = { type: "null" };
		else if (rest.length === 1) schema = convert(rest[0], resolving);
		else if (rest.every(isLiteral)) {
			const booleans = rest.filter((part) => part.flags & ts.TypeFlags.BooleanLiteral);
			schema =
				booleans.length === 2
					? { type: "boolean" }
					: { enum: rest.map((part) => (part.isStringLiteral() ? part.value : part.flags & ts.TypeFlags.BooleanLiteral ? part.intrinsicName === "true" : part.value)) };
		} else {
			const options = rest.map((part) => convert(part, resolving));
			schema = options.some((option) => Object.keys(option).length === 0) ? {} : { anyOf: options.flatMap((option) => option.anyOf ?? [option]) };
		}
		if (Object.keys(schema).length === 0) return {};
		return withNull && rest.length > 0 ? nullable(schema) : schema;
	}

	const NOT_JSON = new Set(["Date", "URL", "Buffer", "Uint8Array", "ArrayBuffer", "RegExp", "Error"]);

	function object(type, resolving, shapeOnly) {
		const name = type.symbol?.getName();
		if (name === "Date") return { type: "string", format: "date-time" };
		if (NOT_JSON.has(name)) return { type: "string" };
		// A list, mutable or readonly, has an element type for the number index.
		// A fixed tuple has none; `readonly T[]` is a one-element tuple whose
		// element is `T | undefined`.
		const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
		if (element && !checker.isTupleType(type)) return { type: "array", items: convert(element) };
		if (checker.isTupleType(type)) {
			const elements = checker.getTypeArguments(type);
			if (element && elements.length === 1 && elements[0].isUnion() && elements[0].types.some((part) => part.flags & ts.TypeFlags.Undefined)) {
				return { type: "array", items: convert(elements[0]) };
			}
			return {
				type: "array",
				...(elements.length > 0 ? { minItems: elements.filter((item) => !(item.flags & ts.TypeFlags.Undefined)).length, maxItems: elements.length } : {}),
				prefixItems: elements.map((item) => convert(item)),
				items: false,
			};
		}
		if (name === "Map") return { type: "object", additionalProperties: convert(checker.getTypeArguments(type)[1] ?? type) };
		if (name === "Set") return { type: "array", items: convert(checker.getTypeArguments(type)[0] ?? type) };
		if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return {};
		// While the type's own definition is being written there is nothing to
		// refer to yet: the shape is what is asked for.
		if (!shapeOnly) {
			const reference = referenceTo(type);
			if (reference) return reference;
		}
		const schema = { type: "object" };
		for (const info of checker.getIndexInfosOfType(type)) {
			const key = info.keyType;
			if (key.isUnion() && key.types.every((part) => part.isStringLiteral())) {
				schema.properties = Object.fromEntries(key.types.map((part) => [part.value, convert(info.type)]));
				schema.required = key.types.map((part) => part.value);
			} else if (info.keyType.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike)) {
				schema.additionalProperties = convert(info.type);
			}
		}
		const properties = {};
		const required = [];
		for (const property of type.getProperties()) {
			const declaration = property.declarations?.[0];
			const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 || Boolean(declaration?.questionToken);
			const documented = documentation(declaration);
			const converted = convert(checker.getTypeOfSymbolAtLocation(property, sourceFile));
			properties[property.getName()] = Object.keys(documented).length > 0 ? { ...documented, ...converted } : converted;
			if (!optional) required.push(property.getName());
		}
		return {
			...schema,
			properties: { ...(schema.properties ?? {}), ...properties },
			...(required.length > 0 || schema.required ? { required: [...(schema.required ?? []), ...required] } : {}),
		};
	}

	/** Keys in a fixed order, so two runs write the same bytes. */
	function ordered(value) {
		if (Array.isArray(value)) return value.map(ordered);
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.keys(value)
					.sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
					.map((key) => [key, ordered(value[key])]),
			);
		}
		return value;
	}
	const KEY_ORDER = ["$ref", "type", "description", "deprecated", "enum", "const", "format", "properties", "required", "items", "prefixItems", "additionalProperties", "anyOf", "allOf", "oneOf", "not"];
	const rank = (key) => (KEY_ORDER.includes(key) ? KEY_ORDER.indexOf(key) : KEY_ORDER.length);

	const rootDeclarations = sourceFile.statements.filter(ts.isVariableStatement).flatMap((statement) => statement.declarationList.declarations);
	const rootSchemas = {};
	rootDeclarations.forEach((declaration, index) => {
		const schema = convert(checker.getTypeAtLocation(declaration.name));
		const key = roots[index].key;
		if (schema.$ref) {
			rootSchemas[key] = schema;
			return;
		}
		defs.set(key, schema);
		rootSchemas[key] = { $ref: `#/$defs/${key}` };
	});

	// Only the sources the program actually read decide whether this is stale.
	const sources = [
		"tsconfig.json",
		...program
			.getSourceFiles()
			.map((file) => file.fileName)
			.filter((file) => file.startsWith(repoRoot) && !file.includes("node_modules") && file !== declarations)
			.map((file) => path.relative(repoRoot, file)),
	].sort();
	const sourceRecord = recordSources(sources);
	// A name with a type's number in it says nothing about the type.
	const anonymous = [...defs.keys()].filter((name) => /(^|__)T\d+$|__T\d+__/.test(name));
	if (anonymous.length > 0) throw new Error(`这些定义的名字里还有类型的编号，读不懂：${anonymous.join("、")}`);
	const output = {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$comment: "由 scripts/generate-contract-schemas.cjs 从 TypeScript 类型生成，不要手改。",
		$defs: Object.fromEntries(
			[...defs]
				.filter(([, schema]) => schema !== null)
				.map(([name, schema]) => [name, ordered({ ...(defDocs.get(name) ?? {}), ...schema })])
				.sort(([left], [right]) => left.localeCompare(right)),
		),
		roots: Object.fromEntries(Object.entries(rootSchemas).sort(([left], [right]) => left.localeCompare(right))),
		typesSource: sourceRecord,
	};
	const contents = `${JSON.stringify(output, null, "\t")}\n`;

	if (process.argv.includes("--check")) {
		const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
		if (current !== contents) {
			console.error(`契约结构定义 ${path.relative(repoRoot, outFile)} 与类型源码不一致，请重新生成（见 docs/contract/frontend/README.md）`);
			process.exit(1);
		}
		console.log("契约结构定义与类型源码一致");
		return;
	}
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(outFile, contents);
	console.log(
		`已生成 ${path.relative(repoRoot, outFile)}（${Object.keys(output.roots).length} 个根，${Object.keys(output.$defs).length} 个定义，读取了 ${sources.length} 个源文件）`,
	);
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}
