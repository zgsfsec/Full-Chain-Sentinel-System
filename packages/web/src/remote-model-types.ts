/** Read-only discovery uses the unsaved endpoint and never returns credentials. */
export const REMOTE_MODEL_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

export interface RemoteModelInput {
	entryId?: string;
	baseUrl: string;
	api: string;
	/** null reuses the saved key on the same origin; empty means no authentication. */
	apiKey: string | null;
}

export interface RemoteModel {
	id: string;
	name: string;
}

export interface RemoteModelList {
	models: RemoteModel[];
	truncated: boolean;
}
