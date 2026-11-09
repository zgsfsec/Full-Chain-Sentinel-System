import { DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import {
	Alert,
	Button,
	Checkbox,
	Col,
	Drawer,
	Form,
	Input,
	InputNumber,
	Popconfirm,
	Row,
	Select,
	Segmented,
	Space,
	Tabs,
	Tag,
	Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.ts";
import { SettingsEmpty, SettingsNote, SettingsSection } from "../ui/Settings.tsx";

const { Text } = Typography;
import type {
	SentinelBuiltinChannel,
	SentinelBuiltinModelDefaults,
	SentinelBuiltinModelPreset,
	SentinelGatekeeperConfig,
	SentinelModelCapabilities,
	SentinelModelCostRates,
	SentinelModelEntryView,
	SentinelModelLibraryView,
	SentinelModelRoleName,
	SentinelResolvedModelView,
	SentinelTestResult,
} from "../types.ts";
import { ModelRolePicker } from "./ModelRolePicker.tsx";
import { GatekeeperPanel } from "./GatekeeperPanel.tsx";
import { RemoteModelPicker } from "./RemoteModelPicker.tsx";
import {
	capabilityChips,
	hostOf,
	MODEL_API_OPTIONS,
	ModelStatusTag,
	ROLE_HINTS,
	ROLE_LABELS,
	ROLE_ORDER,
	ROLE_SHORT,
	testDetail,
	testState,
	UsageTags,
} from "./model-ui.tsx";

interface Draft {
	/** Set when editing an existing entry. */
	id?: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	modelId: string;
	/** The operator asked to drop the stored key, turning the endpoint unauthenticated. */
	clearKey: boolean;
	/** Numeric fields stay strings so an empty box can mean "not declared". */
	api: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	imageInput: boolean;
	costInput: string;
	costOutput: string;
	costCacheRead: string;
	costCacheWrite: string;
	cacheShort: string;
	cacheLong: string;
}

const EMPTY_DRAFT: Draft = {
	name: "",
	baseUrl: "",
	apiKey: "",
	modelId: "",
	clearKey: false,
	api: "openai-completions",
	contextWindow: "",
	maxTokens: "",
	reasoning: false,
	imageInput: true,
	costInput: "",
	costOutput: "",
	costCacheRead: "",
	costCacheWrite: "",
	cacheShort: "",
	cacheLong: "",
};

function draftOf(entry: SentinelModelEntryView): Draft {
	return {
		id: entry.id,
		name: entry.name,
		baseUrl: entry.baseUrl,
		apiKey: "",
		modelId: entry.modelId,
		clearKey: false,
		api: entry.api,
		contextWindow: entry.contextWindow === null ? "" : String(entry.contextWindow),
		maxTokens: entry.maxTokens === null ? "" : String(entry.maxTokens),
		reasoning: entry.reasoning,
		imageInput: entry.input.includes("image"),
		costInput: entry.cost === null ? "" : rateText(entry.cost.input),
		costOutput: entry.cost === null ? "" : rateText(entry.cost.output),
		costCacheRead: entry.cost === null ? "" : rateText(entry.cost.cacheRead),
		costCacheWrite: entry.cost === null ? "" : rateText(entry.cost.cacheWrite),
		cacheShort: entry.promptCache?.short === undefined ? "" : String(entry.promptCache.short),
		cacheLong: entry.promptCache?.long === undefined ? "" : String(entry.promptCache.long),
	};
}

function applyDefaults(draft: Draft, defaults: SentinelBuiltinModelDefaults): Draft {
	return {
		...draft,
		api: defaults.api,
		contextWindow: String(defaults.contextWindow),
		maxTokens: String(defaults.maxTokens),
		reasoning: defaults.reasoning,
		imageInput: defaults.input.includes("image"),
		costInput: rateText(defaults.cost.input),
		costOutput: rateText(defaults.cost.output),
		costCacheRead: rateText(defaults.cost.cacheRead),
		costCacheWrite: rateText(defaults.cost.cacheWrite),
		cacheShort: defaults.promptCache?.short === undefined ? "" : String(defaults.promptCache.short),
		cacheLong: defaults.promptCache?.long === undefined ? "" : String(defaults.promptCache.long),
	};
}

function parsePositive(raw: string, label: string): { value?: number; error?: string } {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	const value = Number(trimmed);
	if (!Number.isInteger(value) || value <= 0) return { error: t("{label}必须是正整数", { label }) };
	return { value };
}

/** Catalog rates come from per-token decimals, so 0.32 arrives as 0.3199999928474426. */
function rateText(value: number): string {
	return String(Number(value.toFixed(6)));
}

function contextText(tokens: number): string {
	return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}k`;
}

/** Trailing slashes are packaging, not identity, when matching an entry to a channel. */
function normalizeEndpoint(url: string): string {
	return url.trim().replace(/\/+$/u, "").toLowerCase();
}

/** Key reuse is scoped to a host, so a path change is not enough to invalidate it. */
function urlHost(url: string): string {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return "";
	}
}

function clearCapabilities(draft: Draft): Draft {
	return {
		...draft,
		contextWindow: "",
		maxTokens: "",
		reasoning: false,
		imageInput: true,
		costInput: "",
		costOutput: "",
		costCacheRead: "",
		costCacheWrite: "",
		cacheShort: "",
		cacheLong: "",
	};
}

function parseRate(raw: string, label: string): { value?: number; error?: string } {
	const trimmed = raw.trim();
	if (!trimmed) return { value: 0 };
	const value = Number(trimmed);
	if (!Number.isFinite(value) || value < 0) return { error: t("{label}必须是不小于 0 的数字", { label }) };
	return { value };
}

/**
 * The form's capability declaration. Unlike the stored view, an empty numeric
 * box means "not declared" and clears the field; the error blocks saving instead
 * of silently dropping bad input.
 */
function capabilitiesOf(draft: Draft): { capabilities: SentinelModelCapabilities; error: string | null } {
	const context = parsePositive(draft.contextWindow, t("上下文窗口"));
	const output = parsePositive(draft.maxTokens, t("最大输出"));
	const sizeError =
		context.error ??
		output.error ??
		(context.value !== undefined && output.value !== undefined && output.value > context.value
			? t("最大输出不能大于上下文窗口")
			: null);
	const hasCost = [draft.costInput, draft.costOutput, draft.costCacheRead, draft.costCacheWrite].some(
		(value) => value.trim().length > 0,
	);
	let cost: SentinelModelCostRates | undefined;
	let costError: string | null = null;
	if (hasCost) {
		const input = parseRate(draft.costInput, t("输入价格"));
		const outputRate = parseRate(draft.costOutput, t("输出价格"));
		const cacheRead = parseRate(draft.costCacheRead, t("缓存读价格"));
		const cacheWrite = parseRate(draft.costCacheWrite, t("缓存写价格"));
		costError = input.error ?? outputRate.error ?? cacheRead.error ?? cacheWrite.error ?? null;
		cost = {
			input: input.value ?? 0,
			output: outputRate.value ?? 0,
			cacheRead: cacheRead.value ?? 0,
			cacheWrite: cacheWrite.value ?? 0,
		};
	}
	const short = parsePositive(draft.cacheShort, t("短期缓存时长"));
	const long = parsePositive(draft.cacheLong, t("长期缓存时长"));
	const promptCache =
		short.value !== undefined || long.value !== undefined
			? {
					...(short.value !== undefined ? { short: short.value } : {}),
					...(long.value !== undefined ? { long: long.value } : {}),
				}
			: undefined;
	return {
		capabilities: {
			api: draft.api,
			...(context.value !== undefined ? { contextWindow: context.value } : {}),
			...(output.value !== undefined ? { maxTokens: output.value } : {}),
			reasoning: draft.reasoning,
			input: draft.imageInput ? ["text", "image"] : ["text"],
			...(cost ? { cost } : {}),
			...(promptCache ? { promptCache } : {}),
		},
		error: sizeError ?? costError ?? short.error ?? long.error ?? null,
	};
}

/** 设置 → 模型. Library, role mapping, and AI approval have separate work areas. */
export function SettingsPanel({
	library,
	onSaveEntry,
	onRemoveEntry,
	onDuplicateEntry,
	onSetRole,
	onSetReviewerAuto,
	onTestEntry,
	onLookupDefaults,
	onListChannels,
	onListChannelModels,
	gatekeeperConfig,
	judgeResolved,
	onSaveGatekeeperConfig,
	onTestJudge,
}: {
	library: SentinelModelLibraryView | null;
	onSaveEntry: (entry: {
		id?: string;
		name: string;
		baseUrl: string;
		apiKey: string | null;
		modelId: string;
		capabilities: SentinelModelCapabilities;
	}) => void;
	onRemoveEntry: (id: string) => void;
	onDuplicateEntry: (id: string) => void;
	onSetRole: (role: SentinelModelRoleName, target: string | null) => void;
	onSetReviewerAuto: (enabled: boolean) => void;
	onTestEntry: (id: string) => Promise<SentinelTestResult | null>;
	onLookupDefaults: (modelId: string, baseUrl: string) => Promise<SentinelBuiltinModelDefaults[] | null>;
	onListChannels: (query: string) => Promise<SentinelBuiltinChannel[] | null>;
	onListChannelModels: (provider: string) => Promise<SentinelBuiltinModelPreset[] | null>;
	gatekeeperConfig: SentinelGatekeeperConfig;
	judgeResolved: SentinelResolvedModelView | null;
	onSaveGatekeeperConfig: (settings: SentinelGatekeeperConfig) => void;
	onTestJudge: () => Promise<{ result: SentinelTestResult; raw?: string } | null>;
}) {
	const [draft, setDraft] = useState<Draft | null>(null);
	const [activeSection, setActiveSection] = useState<"models" | "roles" | "gatekeeper">("models");
	const [activeDraftTab, setActiveDraftTab] = useState<"connection" | "capabilities" | "pricing">("connection");
	const [deleteWarn, setDeleteWarn] = useState(false);
	const [pickerRole, setPickerRole] = useState<SentinelModelRoleName | null>(null);
	const [search, setSearch] = useState("");
	const [testing, setTesting] = useState<string | null>(null);
	const [testingAll, setTestingAll] = useState(false);
	/** Test results live in this component only: a stored "usable" goes stale. */
	const [results, setResults] = useState<Record<string, SentinelTestResult | null>>({});
	/** Built-in catalog suggestions for the open draft; applying is always explicit or new-entry-only. */
	const [defaultsLoading, setDefaultsLoading] = useState(false);
	const [defaultsMatches, setDefaultsMatches] = useState<SentinelBuiltinModelDefaults[] | null>(null);
	const [defaultsNote, setDefaultsNote] = useState("");
	/** `${modelId}|${baseUrl}` already looked up, so blur does not refill after manual edits. */
	const [autoLookupKey, setAutoLookupKey] = useState("");
	/** Channel list for the first picker; the query is matched on the server. */
	const [channelOptions, setChannelOptions] = useState<SentinelBuiltinChannel[] | null>(null);
	const [channelsLoading, setChannelsLoading] = useState(false);
	const [channelsError, setChannelsError] = useState("");
	const [channel, setChannel] = useState<SentinelBuiltinChannel | null>(null);
	const [customChannel, setCustomChannel] = useState(false);
	/** Models of the chosen channel, filtered in the browser by the second picker. */
	const [models, setModels] = useState<SentinelBuiltinModelPreset[] | null>(null);
	const [modelsLoading, setModelsLoading] = useState(false);
	const [modelsError, setModelsError] = useState("");
	const [customModel, setCustomModel] = useState(false);
	const [capsSource, setCapsSource] = useState<"catalog" | "current" | "manual" | "">("");
	/** Stale replies lose to the newer keystroke, not the other way around. */
	const channelSeqRef = useRef(0);
	const modelsSeqRef = useRef(0);
	/** The channel a pending model reply belongs to; a switch must discard it. */
	const channelRef = useRef<SentinelBuiltinChannel | null>(null);
	/** Once the operator picks a channel, loading must not override that choice. */
	const channelTouchedRef = useRef(false);
	/** An edit infers its channel from the endpoint exactly once. */
	const inferenceRef = useRef(false);
	const modelCacheRef = useRef(new Map<string, SentinelBuiltinModelPreset[]>());
	/** Name that came from a model, so switching models replaces it but a typed name survives. */
	const autoNameRef = useRef<string | null>(null);
	const drawerOpen = draft !== null;

	const loadChannels = async (query: string): Promise<void> => {
		const seq = ++channelSeqRef.current;
		setChannelsLoading(true);
		setChannelsError("");
		const channels = await onListChannels(query);
		if (channelSeqRef.current !== seq) return;
		setChannelsLoading(false);
		if (channels === null) {
			setChannelsError(t("内置渠道读取超时，请重试。"));
			return;
		}
		setChannelOptions(channels);
	};

	const loadModels = async (next: SentinelBuiltinChannel): Promise<SentinelBuiltinModelPreset[] | null> => {
		const cached = modelCacheRef.current.get(next.provider);
		if (cached) {
			setModels(cached);
			setModelsLoading(false);
			setModelsError("");
			return cached;
		}
		const seq = ++modelsSeqRef.current;
		setModels(null);
		setModelsLoading(true);
		setModelsError("");
		const presets = await onListChannelModels(next.provider);
		if (modelsSeqRef.current !== seq) return null;
		setModelsLoading(false);
		if (presets === null) {
			setModelsError(t("模型目录读取超时，请重试。"));
			return null;
		}
		modelCacheRef.current.set(next.provider, presets);
		setModels(presets);
		return presets;
	};

	useEffect(() => {
		if (!drawerOpen) return;
		const timer = window.setTimeout(() => void loadChannels(""), 220);
		return () => window.clearTimeout(timer);
	}, [drawerOpen]);

	/** An existing entry opens on its own channel when the endpoint matches one. */
	useEffect(() => {
		if (!drawerOpen || inferenceRef.current || channelTouchedRef.current) return;
		if (!draft?.id || !library || channelOptions === null) return;
		inferenceRef.current = true;
		const entry = library.entries.find((candidate) => candidate.id === draft.id);
		if (!entry) return;
		const wanted = normalizeEndpoint(entry.baseUrl);
		const found = wanted
			? channelOptions.find((candidate) => candidate.baseUrls.some((url) => normalizeEndpoint(url) === wanted))
			: undefined;
		// A catalog-derived name is replaced when the model changes; a typed one survives.
		if (entry.name === entry.modelId.trim()) autoNameRef.current = entry.name;
		if (!found) {
			setCustomChannel(true);
			setCapsSource("current");
			return;
		}
		channelRef.current = found;
		setChannel(found);
		setCustomChannel(false);
		setCapsSource("current");
		void loadModels(found).then((presets) => {
			if (channelRef.current?.provider !== found.provider) return;
			const preset = presets?.find((candidate) => candidate.modelId === entry.modelId.trim());
			setCustomModel(!preset);
			if (preset && entry.name === preset.name) autoNameRef.current = entry.name;
		});
	}, [channelOptions, drawerOpen]);

	/** A failed catalog must not strand the form: custom always works. */
	useEffect(() => {
		if (!drawerOpen || channelOptions !== null || !channelsError || channelTouchedRef.current) return;
		inferenceRef.current = true;
		setCustomChannel(true);
		setCapsSource(draft?.id ? "current" : "manual");
	}, [channelsError, channelOptions, drawerOpen]);

	useEffect(() => {
		if (!drawerOpen) return;
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") closeDraft();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [drawerOpen]);

	if (!library) {
		return <SettingsNote>{t("正在读取模型配置…")}</SettingsNote>;
	}

	const runTest = async (id: string) => {
		setTesting(id);
		try {
			const result = await onTestEntry(id);
			setResults((current) => ({ ...current, [id]: result }));
		} finally {
			setTesting(null);
		}
	};

	const runAllTests = async () => {
		if (testingAll) return;
		setTestingAll(true);
		try {
			for (const entry of library.entries) {
				await runTest(entry.id);
			}
		} finally {
			setTestingAll(false);
		}
	};

	const resetChannelState = (): void => {
		// Invalidate every in-flight reply before the next draft can show it.
		channelSeqRef.current += 1;
		modelsSeqRef.current += 1;
		channelRef.current = null;
		channelTouchedRef.current = false;
		inferenceRef.current = false;
		autoNameRef.current = null;
		// A filtered list from the last search cannot infer this entry's channel.
		setChannelOptions(null);
		setChannel(null);
		setCustomChannel(false);
		setChannelsError("");
		setChannelsLoading(false);
		setModels(null);
		setModelsLoading(false);
		setModelsError("");
		setCustomModel(false);
		setCapsSource("");
	};

	const openDraft = (next: Draft): void => {
		setDraft(next);
		setActiveDraftTab("connection");
		setDeleteWarn(false);
		setDefaultsMatches(null);
		setDefaultsNote("");
		setAutoLookupKey("");
		resetChannelState();
	};

	const closeDraft = (): void => {
		setDraft(null);
		setDeleteWarn(false);
		setDefaultsMatches(null);
		setDefaultsNote("");
		setAutoLookupKey("");
		resetChannelState();
	};

	const lookupDefaults = async (auto: boolean, key?: string): Promise<void> => {
		if (!draft?.modelId.trim()) {
			setDefaultsNote(t("先填写模型 ID，再查内置库。"));
			return;
		}
		const lookupKey = key ?? `${draft.modelId.trim()}|${draft.baseUrl.trim()}`;
		setDefaultsLoading(true);
		const matches = await onLookupDefaults(draft.modelId.trim(), draft.baseUrl.trim());
		setDefaultsLoading(false);
		setAutoLookupKey(lookupKey);
		const found = matches ?? [];
		if (found.length === 0) {
			setDefaultsMatches(null);
			setDefaultsNote(t("内置库没有同 ID 的模型，请手工填写能力。"));
			return;
		}
		// A near miss is a different model. Offer it as a choice; never apply it
		// behind the operator's back, even when it is the only candidate.
		if (found.every((match) => match.approximate === true)) {
			setDefaultsMatches(found);
			setDefaultsNote(t("内置库没有同 ID 的模型，以下是相近条目，选择后请核对。"));
			return;
		}
		setDefaultsMatches(found.length > 1 ? found : null);
		if (auto || found.length === 1) {
			const defaults = found[0];
			setDraft((current) => {
				// The operator may have typed a different model while the lookup was
				// in flight; those numbers belong to the old one.
				if (!current || `${current.modelId.trim()}|${current.baseUrl.trim()}` !== lookupKey) return current;
				return applyDefaults(current, defaults);
			});
			setDefaultsNote(t("已按内置库「{provider}」填充，可继续修改。", { provider: defaults.providerName }));
			setCapsSource("catalog");
			return;
		}
		setDefaultsNote(t("找到 {count} 个同 ID 模型，选一个填充。", { count: found.length }));
	};

	/** New entries prefill once per model-id/host pair; existing entries only on request. */
	const autoFillNewEntry = (): void => {
		if (!draft || draft.id) return;
		if (!draft.modelId.trim() || !draft.baseUrl.trim()) return;
		const key = `${draft.modelId.trim()}|${draft.baseUrl.trim()}`;
		if (key === autoLookupKey) return;
		void lookupDefaults(true, key);
	};

	const applyDefaultsToDraft = (defaults: SentinelBuiltinModelDefaults): void => {
		setDraft((current) => (current ? applyDefaults(current, defaults) : current));
		setDefaultsNote(t("已按内置库「{provider}」填充，可继续修改。", { provider: defaults.providerName }));
		setCapsSource("catalog");
		setActiveDraftTab("capabilities");
	};

	/** A typed name survives a selection; one that came from a model is replaced. */
	const nameAfterSelection = (current: Draft, next: string): string => {
		const auto = current.name.trim() === "" || (autoNameRef.current !== null && current.name === autoNameRef.current);
		// A custom id has no display name to offer, so an auto name clears instead.
		autoNameRef.current = auto && next ? next : null;
		return auto ? next : current.name;
	};

	const pickBuiltinChannel = (next: SentinelBuiltinChannel): void => {
		if (!customChannel && channel?.provider === next.provider) {
			return;
		}
		channelTouchedRef.current = true;
		channelRef.current = next;
		setChannel(next);
		setCustomChannel(false);
		setModels(null);
		setModelsError("");
		setCustomModel(false);
		setCapsSource("");
		setDefaultsMatches(null);
		setDefaultsNote("");
		setAutoLookupKey("");
		if (draft) {
			// The model and every capability belonged to the previous channel.
			setDraft({
				...clearCapabilities(draft),
				modelId: "",
				apiKey: "",
				api: next.api,
				baseUrl: next.baseUrl,
				name: nameAfterSelection(draft, ""),
			});
		}
		void loadModels(next).then((presets) => {
			if (channelRef.current?.provider !== next.provider) return;
			if (presets === null) return;
			if (presets.length === 0) {
				setCustomModel(true);
				return;
			}
		});
	};

	const pickCustomChannel = (): void => {
		channelTouchedRef.current = true;
		if (customChannel) {
			return;
		}
		const previous = channelRef.current;
		channelRef.current = null;
		setChannel(null);
		setCustomChannel(true);
		setModels(null);
		setModelsError("");
		setCustomModel(false);
		setCapsSource("manual");
		setDefaultsMatches(null);
		setDefaultsNote("");
		setAutoLookupKey("");
		if (draft) {
			// Carry the current endpoint over: a relay usually overrides one vendor.
			setDraft({
				...draft,
				baseUrl: draft.baseUrl.trim() ? draft.baseUrl : (previous?.baseUrl ?? ""),
				api: previous?.api ?? draft.api,
			});
		}
	};

	const pickModel = (preset: SentinelBuiltinModelPreset): void => {
		if (!draft) return;
		setDraft({
			...applyDefaults(draft, preset),
			modelId: preset.modelId,
			baseUrl: preset.baseUrl,
			name: nameAfterSelection(draft, preset.name),
		});
		setCustomModel(false);
		setCapsSource("catalog");
		setDefaultsMatches(null);
		setDefaultsNote("");
		setAutoLookupKey(`${preset.modelId}|${preset.baseUrl.trim()}`);
	};

	const pickCustomModel = (): void => {
		if (customModel) {
			return;
		}
		setCustomModel(true);
		setCapsSource("manual");
		setDefaultsMatches(null);
		setDefaultsNote("");
		setAutoLookupKey("");
		if (draft) {
			setDraft({ ...clearCapabilities(draft), modelId: "", name: nameAfterSelection(draft, "") });
		}
	};

	const retryModels = (): void => {
		if (channel) void loadModels(channel);
	};

	const draftId = draft?.id ?? null;
	const editingEntry = draftId ? (library.entries.find((entry) => entry.id === draftId) ?? null) : null;
	const entryHost = editingEntry ? urlHost(editingEntry.baseUrl) : "";
	const draftHost = draft ? urlHost(draft.baseUrl) : "";
	const keyHostChanged = Boolean(draft?.id) && entryHost !== "" && draftHost !== "" && entryHost !== draftHost;

	const submit = (): void => {
		if (!draft) return;
		const parsed = capabilitiesOf(draft);
		if (parsed.error) return;
		// Editing: an untouched key field means "keep what is stored". A changed
		// host must not receive the old key, so an empty field clears it instead.
		// Adding: an empty key means the endpoint needs no authentication.
		const apiKey = draft.clearKey
			? ""
			: draft.apiKey.trim()
				? draft.apiKey.trim()
				: draft.id
					? keyHostChanged
						? ""
						: null
					: "";
		onSaveEntry({
			...(draft.id ? { id: draft.id } : {}),
			name: draft.name,
			baseUrl: draft.baseUrl,
			modelId: draft.modelId,
			apiKey,
			capabilities: parsed.capabilities,
		});
		closeDraft();
	};

	const removeDraftEntry = (entry: SentinelModelEntryView): void => {
		if (entry.roles.length > 0) {
			setDeleteWarn(true);
			return;
		}
		onRemoveEntry(entry.id);
		closeDraft();
	};

	const keyword = search.trim().toLowerCase();
	const shown = library.entries.filter((entry) =>
		`${entry.name} ${entry.modelId} ${entry.baseUrl}`.toLowerCase().includes(keyword),
	);
	const unused = library.entries.filter((entry) => entry.roles.length === 0).length;
	const assigned = ROLE_ORDER.filter((role) => library.resolved[role] !== null).length;
	const capabilityError = draft ? capabilitiesOf(draft).error : null;
	const valid =
		draft !== null &&
		draft.baseUrl.trim().length > 0 &&
		draft.modelId.trim().length > 0 &&
		capabilityError === null;

	const modelOptions = models ?? [];
	const selectedModel =
		!customChannel && !customModel && draft?.modelId.trim()
			? (modelOptions.find((preset) => preset.modelId === draft.modelId.trim()) ?? null)
			: null;
	const channelItems = channelOptions ?? [];
	const featuredChannels = channelItems.filter((option) => option.featured);
	const moreChannels = channelItems.filter((option) => !option.featured);
	const capsSourceLabel =
		capsSource === "catalog"
			? t("来源：pi 内置目录")
			: capsSource === "current"
				? t("当前配置")
				: capsSource === "manual"
					? t("需手动填写")
					: t("选择模型后自动填入");
	/** null means the probe produced no result at all; undefined means "not tested yet". */
	const drawerTest = editingEntry ? results[editingEntry.id] : undefined;

	const drawerWarn =
		deleteWarn && editingEntry && editingEntry.roles.length > 0 ? (
			<div className="cockpit-warn">
				{t("该模型仍被 {roles} 使用，先解除引用才能删除。", {
					roles: editingEntry.roles.map((role) => ROLE_LABELS[role]).join("、"),
				})}
				<div className="cockpit-warn__actions">
					<Button
						size="small"
						onClick={() => {
							const role = editingEntry.roles[0];
							closeDraft();
							setPickerRole(role);
						}}
					>
						{t("去更换「{role}」", { role: ROLE_LABELS[editingEntry.roles[0]] })}
					</Button>
					<Button size="small" onClick={() => setDeleteWarn(false)}>
						{t("取消")}
					</Button>
				</div>
			</div>
		) : null;

	const keyField = () => (
		<Form.Item
			label={customChannel ? "API Key" : `${channel?.name ?? ""} API Key`}
			extra={
				<>
					{draft?.id && editingEntry?.hasKey ? (
						<Checkbox
							checked={draft.clearKey}
							onChange={(event) =>
								setDraft((current) =>
									current ? { ...current, clearKey: event.target.checked, apiKey: "" } : current,
								)
							}
						>
							{t("清除已保存的密钥（改成无鉴权端点）")}
						</Checkbox>
					) : null}
					{keyHostChanged && !draft?.apiKey.trim() && !draft?.clearKey ? (
						<div>{t("端点主机已变化；不填新 Key 时，保存会清除旧密钥。")}</div>
					) : null}
				</>
			}
		>
			<Input.Password
				value={draft?.apiKey ?? ""}
				onChange={(event) =>
					setDraft((current) =>
						current ? { ...current, apiKey: event.target.value, clearKey: false } : current,
					)
				}
				placeholder={draft?.id ? t("已保存，留空表示不修改") : t("无鉴权端点留空")}
				spellCheck={false}
			/>
		</Form.Item>
	);

	const lookupPanel = () => (
		<div className="modelhub-lookup">
			<Space size={8} wrap>
				<Text type="secondary">{t("按模型 ID 查内置库")}</Text>
				<Button
					size="small"
					type="link"
					disabled={defaultsLoading || !draft?.modelId.trim()}
					loading={defaultsLoading}
					onClick={() => void lookupDefaults(false)}
				>
					{t("填充能力")}
				</Button>
			</Space>
			<Text type="secondary" className="modelhub-lookup__note">
				{defaultsNote || t("ID 匹配时自动补上下文、价格等能力，不改端点。")}
			</Text>
			{defaultsMatches ? (
				<Space size={6} wrap>
					{defaultsMatches.map((defaults) => (
						<Button key={defaults.provider} size="small" onClick={() => applyDefaultsToDraft(defaults)}>
							{defaults.providerName} · {defaults.modelId} · {defaults.api}
						</Button>
					))}
				</Space>
			) : null}
		</div>
	);

	const numField = (value: string, onChange: (next: string) => void, placeholder: string, min = 1, step = 1) => (
		<InputNumber
			min={min}
			step={step}
			style={{ width: "100%" }}
			value={value.trim() === "" ? null : Number(value)}
			onChange={(next) => onChange(next === null || next === undefined ? "" : String(next))}
			placeholder={placeholder}
		/>
	);

	const columns: ProColumns<SentinelModelEntryView>[] = [
		{
			title: t("模型"),
			key: "name",
			render: (_, entry) => (
				<div className="modelhub-name">
					<Space size={6} wrap>
						<Text strong ellipsis title={entry.name}>
							{entry.name}
						</Text>
						<Text type="secondary" ellipsis title={entry.modelId}>
							{entry.modelId}
						</Text>
					</Space>
					<Text type="secondary" ellipsis title={entry.baseUrl}>
						{hostOf(entry.baseUrl)}
					</Text>
				</div>
			),
		},
		{
			title: t("状态"),
			key: "state",
			width: 110,
			render: (_, entry) => (
				<ModelStatusTag
					state={testState(testing === entry.id, results[entry.id])}
					detail={testDetail(results[entry.id])}
				/>
			),
		},
		{
			title: t("能力"),
			key: "caps",
			width: 230,
			render: (_, entry) => (
				<Space size={4} wrap>
					{capabilityChips(entry).map((chip) => (
						<Tag key={chip} variant="filled">
							{chip}
						</Tag>
					))}
				</Space>
			),
		},
		{
			title: t("角色"),
			key: "roles",
			width: 180,
			render: (_, entry) => (
				<Space size={4} wrap>
					<UsageTags roles={entry.roles} />
				</Space>
			),
		},
		{
			title: t("操作"),
			key: "actions",
			width: 150,
			render: (_, entry) => (
				<Space size={4}>
					<Button
						size="small"
						type="link"
						loading={testing === entry.id}
						onClick={(event) => {
							event.stopPropagation();
							void runTest(entry.id);
						}}
					>
						{t("测试")}
					</Button>
					<Button
						size="small"
						type="link"
						onClick={(event) => {
							event.stopPropagation();
							openDraft(draftOf(entry));
						}}
					>
						{t("编辑")}
					</Button>
				</Space>
			),
		},
	];

	return (
		<>
			<div className="modelhub-section-nav" role="tablist" aria-label={t("模型设置分区")}>
				<Segmented
					block
					value={activeSection}
					onChange={(value) => setActiveSection(value as typeof activeSection)}
					options={[
						{ value: "models", label: <span>{t("模型库")} <small>{library.entries.length}</small></span> },
						{ value: "roles", label: t("角色分配") },
						{ value: "gatekeeper", label: t("守门设置（AI 审批）") },
					]}
				/>
			</div>
			{activeSection === "models" ? <SettingsSection
				className="settings-panel"
				title={t("模型库")}
				description={
					<>
						{t("{count} 个模型", { count: library.entries.length })} · {unused === 0 ? t("全部已使用") : t("{count} 个未使用", { count: unused })} · {t("{assigned} / {total} 个角色已分配", { assigned, total: ROLE_ORDER.length })}
						{keyword ? ` · ${t("匹配 {count} 个", { count: shown.length })}` : ""}
					</>
				}
				extra={
					<Space size={8} wrap>
						<Input
							allowClear
							style={{ width: 220 }}
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder={t("搜索名称、模型 ID、端点")}
							spellCheck={false}
						/>
						<Button
							icon={<ReloadOutlined />}
							loading={testingAll}
							disabled={testingAll || library.entries.length === 0}
							onClick={() => void runAllTests()}
						>
							{t("全部测试")}
						</Button>
						<Button type="primary" icon={<PlusOutlined />} onClick={() => openDraft({ ...EMPTY_DRAFT })}>
							{t("添加模型")}
						</Button>
					</Space>
				}
			>
				<ProTable<SentinelModelEntryView>
					rowKey="id"
					size="small"
					columns={columns}
					dataSource={shown}
					search={false}
					options={false}
					pagination={false}
					tableLayout="fixed"
					scroll={{ x: 900 }}
					onRow={(entry) => ({
						onClick: () => openDraft(draftOf(entry)),
						style: { cursor: "pointer" },
					})}
					locale={{
						emptyText:
							library.entries.length === 0 ? (
								<SettingsEmpty
									title={t("还没有模型")}
									hint={t("添加一条后，角色里就能分配它。")}
								/>
							) : (
								<SettingsEmpty title={t("没有匹配的模型")} hint={t("换个关键词试试。")} />
							),
					}}
				/>
			</SettingsSection> : null}

			{activeSection === "roles" ? <SettingsSection
				className="settings-panel modelhub-role-section"
				title={t("角色分配")}
				description={t("为每个工作角色选择模型，修改后立即生效")}
			>
				<Alert
					type="warning"
					showIcon
					className="ui-page__alert"
					title={t("模型计划与限流提示")}
					description={
						<Space orientation="vertical" size={6}>
							<div>
								{t("Token Plan / Coding Plan 通常有 RPM（每分钟请求数）限制和排队等待机制。多个角色共用计划额度时，可能出现限流、长时间等待或请求超时，拖慢任务执行。")}
							</div>
							<div>
								<strong>{t("守门模型必须使用按量付费 API。")}</strong>{" "}
								{t("AI 审批需要在命令执行前等待守门判定，请为守门模型配置独立的按量付费端点，避免与主模型共用计划额度。")}
							</div>
							<div>{t("指挥端点、监督模型、漏洞评审建议使用按量付费 API，减少计划额度竞争和排队对任务推进的影响。")}</div>
						</Space>
					}
				/>
				<div className="modelhub-role-list">
					{ROLE_ORDER.map((role) => {
						const resolved = library.resolved[role];
						const roleRef = role === "main" ? library.roles.main : library.roles[role];
						const entry =
							library.entries.find((candidate) => candidate.id === (resolved?.entryId ?? roleRef)) ?? null;
						const state = testState(testing === entry?.id, entry ? results[entry.id] : undefined);
						return (
							<div className="modelhub-role-row" key={role}>
								<div className="modelhub-role-row__name">
									<Tag color={role === "main" ? "blue" : undefined} variant="filled">
										{ROLE_LABELS[role]}
									</Tag>
									<Text type="secondary">{ROLE_SHORT[role]}</Text>
									{role === "judge" ? (
										<Tag color="orange" variant="filled">{t("必须按量 API")}</Tag>
									) : role === "commander" || role === "supervisor" || role === "reviewer" ? (
										<Tag variant="filled">{t("建议按量 API")}</Tag>
									) : null}
								</div>
								<div className="modelhub-role-row__model">
									<Text strong ellipsis title={entry?.name ?? t("未选择模型")}>
										{entry?.name ?? t("未选择模型")}
									</Text>
									<Text type="secondary" ellipsis title={entry?.baseUrl ?? ROLE_HINTS[role]}>
										{entry ? `${entry.modelId} · ${hostOf(entry.baseUrl)}` : ROLE_HINTS[role]}
									</Text>
								</div>
								<div className="modelhub-role-row__caps">
									{entry ? (
										capabilityChips(entry).map((chip) => (
											<Tag key={chip} variant="filled">
												{chip}
											</Tag>
										))
									) : (
										<Tag variant="filled">{t("未绑定")}</Tag>
									)}
								</div>
								<div className="modelhub-role-row__status">
									<ModelStatusTag state={state} detail={testDetail(entry ? results[entry.id] : undefined)} />
									{role === "reviewer" ? (
										<Tag
											color={library.reviewerAuto ? "green" : "default"}
											variant="filled"
											role="button"
											onClick={() => onSetReviewerAuto(!library.reviewerAuto)}
											title={t("关闭后新记录不再排队，已排队的也会停止")}
										>
											{t("自动评审")}
										</Tag>
									) : null}
								</div>
								<div className="modelhub-role-row__actions">
									<Button size="small" type="link" onClick={() => setPickerRole(role)}>
										{t("更换")}
									</Button>
									{entry ? (
										<Button
											size="small"
											type="link"
											loading={testing === entry.id}
											onClick={() => void runTest(entry.id)}
										>
											{t("测试")}
										</Button>
									) : null}
								</div>
							</div>
						);
					})}
				</div>
			</SettingsSection> : null}

			{activeSection === "gatekeeper" ? (
				<GatekeeperPanel
					gatekeeperConfig={gatekeeperConfig}
					judgeResolved={judgeResolved}
					onSave={onSaveGatekeeperConfig}
					onTestJudge={onTestJudge}
				/>
			) : null}

			{pickerRole ? (
				<ModelRolePicker
					key={pickerRole}
					library={library}
					role={pickerRole}
					results={results}
					onApply={(target) => {
						onSetRole(pickerRole, target);
						setPickerRole(null);
					}}
					onClose={() => setPickerRole(null)}
				/>
			) : null}

			{draft ? (
				<Drawer
					open
					size="min(760px, 100vw)"
					onClose={closeDraft}
					destroyOnHidden
					className="modelhub-drawer"
					title={
						<Space size={8} wrap>
							<Text strong>
								{draft.id ? draft.name || draft.modelId || t("编辑模型") : t("添加模型")}
							</Text>
							{editingEntry ? (
								<ModelStatusTag
									state={testState(testing === editingEntry.id, results[editingEntry.id])}
									detail={testDetail(results[editingEntry.id])}
								/>
							) : (
								<Tag variant="filled">{t("未保存")}</Tag>
							)}
						</Space>
					}
					extra={
						<Text type="secondary">
							{draft.id
								? t("{model} · {endpoint}", {
										model: draft.modelId || t("未填写模型 ID"),
										endpoint: hostOf(draft.baseUrl) || t("未填写端点"),
									})
								: t("填写连接信息后保存")}
						</Text>
					}
					footer={
						<Space size={8} className="modelhub-foot">
							{editingEntry ? (
								<Popconfirm
									title={t("删除模型")}
									description={
										editingEntry.roles.length > 0
											? t("被 {count} 个角色使用，先解除引用才能删除", { count: editingEntry.roles.length })
											: t("删除这个模型？")
									}
									okText={t("删除")}
									okButtonProps={{ danger: true }}
									cancelText={t("取消")}
									disabled={editingEntry.roles.length > 0}
									onConfirm={() => removeDraftEntry(editingEntry)}
								>
									<Button danger icon={<DeleteOutlined />} disabled={editingEntry.roles.length > 0}>
										{t("删除")}
									</Button>
								</Popconfirm>
							) : null}
							<Button
								disabled={!editingEntry}
								loading={testing === editingEntry?.id}
								onClick={() => {
									if (editingEntry) void runTest(editingEntry.id);
								}}
							>
								{t("测试连接")}
							</Button>
							{editingEntry ? (
								<Button onClick={() => onDuplicateEntry(editingEntry.id)}>{t("复制")}</Button>
							) : null}
							<Button type="primary" disabled={!valid} onClick={submit}>
								{t("保存")}
							</Button>
						</Space>
					}
				>
					{drawerTest === null ? (
						<Alert
							type="error"
							showIcon
							className="ui-page__alert"
							title={t("无响应")}
							description={t("没有收到测试结果，请重试。")}
						/>
					) : drawerTest ? (
						<Alert
							type={drawerTest.ok ? "success" : "error"}
							showIcon
							className="ui-page__alert"
							title={drawerTest.ok ? t("连接可用") : t("连接失败")}
							description={
								<>
									{drawerTest.message}
									{drawerTest.detail ? <pre className="modelhub-pre">{drawerTest.detail}</pre> : null}
								</>
							}
						/>
					) : null}
					{drawerWarn}

					<Tabs
						activeKey={activeDraftTab}
						onChange={(key) => setActiveDraftTab(key as typeof activeDraftTab)}
						items={[
							{
								key: "connection",
								label: t("连接配置"),
								children: (
									<Form layout="vertical" requiredMark={false} className="modelhub-form">
										{capabilityError ? <Alert type="warning" showIcon title={capabilityError} /> : null}
										<Form.Item
											label={t("渠道")}
											extra={
												customChannel
													? t("Key 只作用于这个端点；模型能力在「能力与价格」里填写。")
													: channel
														? t("{api} · {endpoint}", {
																api: channel.api,
																endpoint: channel.baseUrl || t("端点由模型决定"),
															})
														: t("渠道决定端点、协议与 Key 的作用域。")
											}
										>
											<Select
												showSearch
												loading={channelsLoading}
												style={{ width: "100%" }}
												value={customChannel ? "__custom__" : (channel?.provider ?? undefined)}
												placeholder={
													channelsLoading ? t("读取渠道…") : t("选择渠道")
												}
												onChange={(value) => {
													if (value === "__custom__") {
														pickCustomChannel();
														return;
													}
													const option = channelItems.find((candidate) => candidate.provider === value);
													if (option) pickBuiltinChannel(option);
												}}
												filterOption={(input, option) =>
													String(option?.label ?? "")
														.toLowerCase()
														.includes(input.toLowerCase())
												}
												options={[
													...featuredChannels.map((option) => ({
														value: option.provider,
														label: `${option.name} · ${
															hostOf(option.baseUrl) || t("端点由模型决定")
														} · ${t("{count} 个模型", { count: option.modelCount })}`,
													})),
													...moreChannels.map((option) => ({
														value: option.provider,
														label: `${option.name} · ${
															hostOf(option.baseUrl) || t("端点由模型决定")
														} · ${t("{count} 个模型", { count: option.modelCount })}`,
													})),
													{ value: "__custom__", label: t("自定义渠道（自己填 Base URL 与协议）") },
												]}
											/>
										</Form.Item>
										{channelsError ? (
											<Alert
												type="error"
												showIcon
												className="ui-page__alert"
												title={channelsError}
												action={
													<Button size="small" onClick={() => void loadChannels("")}>
														{t("重试")}
													</Button>
												}
											/>
										) : null}

										{customChannel ? (
											<>
												<Form.Item label="Base URL">
													<Input
														value={draft.baseUrl}
														onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
														onBlur={autoFillNewEntry}
														placeholder="https://relay.example.com/v1"
														spellCheck={false}
													/>
												</Form.Item>
												<Form.Item label={t("协议")}>
													<Select
														value={draft.api}
														onChange={(value) => setDraft({ ...draft, api: value })}
														options={[
															...MODEL_API_OPTIONS.map((option) => ({
																value: option.id,
																label: option.label,
															})),
															...(MODEL_API_OPTIONS.some((option) => option.id === draft.api)
																? []
																: [{ value: draft.api, label: t("{api}（当前值）", { api: draft.api }) }]),
														]}
													/>
												</Form.Item>
												<Form.Item label={t("模型 ID")}>
													<Input
														aria-label={t("模型 ID")}
														value={draft.modelId}
														onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
														onBlur={autoFillNewEntry}
														placeholder="deepseek-chat / glm-4.7 / qwen3-coder…"
														spellCheck={false}
													/>
												</Form.Item>
												{lookupPanel()}
												{keyField()}
												<Form.Item label={t("显示名称")}>
													<Input
														value={draft.name}
														onChange={(event) => setDraft({ ...draft, name: event.target.value })}
														placeholder={t("默认使用模型 ID")}
														spellCheck={false}
													/>
												</Form.Item>
											</>
										) : channel ? (
											<>
												{keyField()}
												<Form.Item label={t("模型")}>
													<Select
														showSearch
														loading={modelsLoading}
														style={{ width: "100%" }}
														value={customModel ? "__custom__" : (selectedModel?.modelId ?? undefined)}
														placeholder={
															modelsLoading ? t("读取模型…") : t("选择模型")
														}
														onChange={(value) => {
															if (value === "__custom__") {
																pickCustomModel();
																return;
															}
															const preset = modelOptions.find(
																(candidate) => candidate.modelId === value,
															);
															if (preset) pickModel(preset);
														}}
														filterOption={(input, option) =>
															String(option?.label ?? "")
																.toLowerCase()
																.includes(input.toLowerCase())
														}
														options={[
															...modelOptions.map((preset) => ({
																value: preset.modelId,
																label: `${preset.name} · ${preset.modelId} · ${contextText(preset.contextWindow)}`,
															})),
															{ value: "__custom__", label: t("自定义模型 ID") },
														]}
													/>
												</Form.Item>
												{modelsError ? (
													<Alert
														type="error"
														showIcon
														className="ui-page__alert"
														title={modelsError}
														action={
															<Button size="small" onClick={retryModels}>
																{t("重试")}
															</Button>
														}
													/>
												) : null}
												{customModel ? (
													<>
														<Form.Item
															label={t("模型 ID")}
															extra={t("内置目录没有这个模型，能力与价格需要手动填。")}
														>
															<Input
																value={draft.modelId}
																onChange={(event) =>
																	setDraft({ ...draft, modelId: event.target.value })
																}
																onBlur={autoFillNewEntry}
																placeholder={t("例如 my-finetune-001")}
																spellCheck={false}
															/>
														</Form.Item>
														{lookupPanel()}
													</>
												) : null}
												<Form.Item label={t("显示名称")}>
													<Input
														value={draft.name}
														onChange={(event) => setDraft({ ...draft, name: event.target.value })}
														placeholder={t("默认使用模型 ID")}
														spellCheck={false}
													/>
												</Form.Item>
											</>
										) : (
											<Text type="secondary">
												{channelsLoading
													? t("正在读取内置渠道…")
													: t("先在上方选择渠道；目录之外的中转用「自定义渠道」。")}
											</Text>
										)}
										{customChannel || channel ? <RemoteModelPicker
											input={{
												entryId: draft.id,
												baseUrl: draft.baseUrl,
												api: draft.api,
												apiKey: draft.clearKey ? "" : draft.apiKey.trim() || (draft.id ? null : ""),
											}}
											modelId={draft.modelId}
											onSelect={(modelId) => {
												setDraft({ ...draft, modelId, name: nameAfterSelection(draft, modelId) });
												setCustomModel(true);
												setDefaultsMatches(null);
												setDefaultsNote("");
												setAutoLookupKey(`${modelId}|${draft.baseUrl.trim()}`);
											}}
										/> : null}
										<Text type="secondary">
											{t("保存后立即生效；正在运行的会话会在下一次请求时使用新配置。")}
										</Text>
									</Form>
								),
							},
							{
								key: "capabilities",
								label: t("模型能力"),
								children: (
									<Form layout="vertical" requiredMark={false} className="modelhub-form">
										<Text type="secondary">{capsSourceLabel}</Text>
										<Row gutter={12}>
											<Col span={12}>
												<Form.Item label={t("上下文窗口（tokens）")}>
													{numField(draft.contextWindow, (next) => setDraft({ ...draft, contextWindow: next }), t("例如 128000"))}
												</Form.Item>
											</Col>
											<Col span={12}>
												<Form.Item label={t("最大输出（tokens）")}>
													{numField(draft.maxTokens, (next) => setDraft({ ...draft, maxTokens: next }), t("例如 16384"))}
												</Form.Item>
											</Col>
										</Row>
										<Form.Item>
											<Checkbox
												checked={draft.reasoning}
												onChange={(event) => setDraft({ ...draft, reasoning: event.target.checked })}
											>
												{t("支持思考 / 推理")}
											</Checkbox>
											<div>
												<Text type="secondary">{t("开启后默认 medium 强度，会话里仍可调整")}</Text>
											</div>
											<Checkbox
												checked={draft.imageInput}
												onChange={(event) => setDraft({ ...draft, imageInput: event.target.checked })}
											>
												{t("支持图片输入")}
											</Checkbox>
											<div>
												<Text type="secondary">{t("关闭后截图不会发给该模型")}</Text>
											</div>
										</Form.Item>
										{capabilityError ? <Alert type="warning" showIcon title={capabilityError} /> : null}
									</Form>
								),
							},
							{
								key: "pricing",
								label: t("价格与缓存"),
								children: (
									<Form layout="vertical" requiredMark={false} className="modelhub-form">
										<Text type="secondary">{t("价格单位：美元 / 百万 token。留空表示未声明。")}</Text>
										<Row gutter={12}>
											<Col span={12}>
												<Form.Item label={t("输入")}>
													{numField(draft.costInput, (next) => setDraft({ ...draft, costInput: next }), "0", 0, 0.01)}
												</Form.Item>
											</Col>
											<Col span={12}>
												<Form.Item label={t("输出")}>
													{numField(draft.costOutput, (next) => setDraft({ ...draft, costOutput: next }), "0", 0, 0.01)}
												</Form.Item>
											</Col>
											<Col span={12}>
												<Form.Item label={t("缓存读")}>
													{numField(draft.costCacheRead, (next) => setDraft({ ...draft, costCacheRead: next }), "0", 0, 0.01)}
												</Form.Item>
											</Col>
											<Col span={12}>
												<Form.Item label={t("缓存写")}>
													{numField(draft.costCacheWrite, (next) => setDraft({ ...draft, costCacheWrite: next }), "0", 0, 0.01)}
												</Form.Item>
											</Col>
										</Row>
										<Text strong>{t("提示缓存（秒）")}</Text>
										<Row gutter={12}>
											<Col span={12}>
												<Form.Item label={t("短期")}>
													{numField(draft.cacheShort, (next) => setDraft({ ...draft, cacheShort: next }), t("例如 300"))}
												</Form.Item>
											</Col>
											<Col span={12}>
												<Form.Item label={t("长期")}>
													{numField(draft.cacheLong, (next) => setDraft({ ...draft, cacheLong: next }), t("例如 3600"))}
												</Form.Item>
											</Col>
										</Row>
										<Text type="secondary">
											{t(
												"价格决定成本统计与缓存预热收益；缓存时长只在该端点确实支持 prompt caching 时填写。四项价格任意一项填写即整组保存，空项按 0 计。",
											)}
										</Text>
										{capabilityError ? <Alert type="warning" showIcon title={capabilityError} /> : null}
									</Form>
								),
							},
						]}
					/>
				</Drawer>
			) : null}
		</>
	);
}
