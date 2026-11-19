import { useCallback, useEffect, useRef, useState } from "react";
import { getLanguage } from "./i18n.ts";

interface ProjectMonitoringState {
	projectId: string;
	enabled: boolean | null;
	saving: boolean;
	error: string | null;
}

async function requestProjectMonitoring(projectId: string, signal: AbortSignal, enabled?: boolean): Promise<boolean> {
	const response = await fetch(`/api/code-monitors/project?projectId=${encodeURIComponent(projectId)}`, {
		signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
		cache: "no-store",
		...(enabled === undefined ? {} : {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled }),
		}),
	});
	const body: unknown = await response.json();
	if (typeof body === "object" && body !== null) {
		if (!response.ok && "error" in body && typeof body.error === "string") throw new Error(body.error);
		if (response.ok && "projectId" in body && body.projectId === projectId && "enabled" in body && typeof body.enabled === "boolean") {
			return body.enabled;
		}
	}
	throw new Error(getLanguage() === "en" ? "Unable to read monitoring status." : "无法读取监听状态。");
}

/** Scope and sequence checks keep late reads or saves from changing the next project's switch. */
export function useCodeMonitorProject(projectId: string | undefined, connected: boolean) {
	const [state, setState] = useState<ProjectMonitoringState | null>(null);
	const [revision, setRevision] = useState(0);
	const sequence = useRef(0);
	const lifetime = useRef<AbortController | null>(null);
	const saving = useRef(false);
	useEffect(() => {
		const controller = new AbortController();
		lifetime.current = controller;
		saving.current = false;
		setState(projectId ? { projectId, enabled: null, saving: false, error: null } : null);
		let loading = false;
		const load = async () => {
			if (!projectId || !connected || loading || saving.current) return;
			loading = true;
			const request = ++sequence.current;
			try {
				const enabled = await requestProjectMonitoring(projectId, controller.signal);
				if (!controller.signal.aborted && request === sequence.current) {
					setState({ projectId, enabled, saving: false, error: null });
				}
			} catch (error) {
				if (!controller.signal.aborted && request === sequence.current) {
					setState((prev) => ({ projectId, enabled: prev?.enabled ?? null, saving: false, error: String(error) }));
				}
			} finally {
				loading = false;
			}
		};
		void load();
		const timer = setInterval(() => void load(), 5_000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [projectId, connected, revision]);
	const ready = Boolean(projectId && connected && state?.projectId === projectId && state?.enabled !== null && !state?.error);
	const setEnabled = async (enabled: boolean) => {
		const controller = lifetime.current;
		if (!ready || !projectId || saving.current || !controller || controller.signal.aborted) return;
		saving.current = true;
		const request = ++sequence.current;
		setState((prev) => prev ? { ...prev, saving: true, error: null } : prev);
		try {
			const stored = await requestProjectMonitoring(projectId, controller.signal, enabled);
			if (!controller.signal.aborted && request === sequence.current) {
				setState({ projectId, enabled: stored, saving: false, error: null });
			}
		} catch (error) {
			if (!controller.signal.aborted && request === sequence.current) {
				setState((prev) => prev ? { ...prev, saving: false, error: String(error) } : prev);
			}
		} finally {
			if (!controller.signal.aborted && request === sequence.current) saving.current = false;
		}
	};
	const refresh = useCallback(() => setRevision((value) => value + 1), []);
	const current = state?.projectId === projectId ? state : null;
	return { enabled: current?.enabled ?? null, saving: current?.saving ?? false, error: current?.error, ready, setEnabled, refresh };
}
