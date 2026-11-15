import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark";
const STORAGE_KEY = "sentinel.ui.theme";
const listeners = new Set<() => void>();

function readThemeMode(): ThemeMode {
	try {
		return globalThis.localStorage?.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
	} catch {
		return "light";
	}
}

let mode = readThemeMode();

function applyThemeMode(): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.theme = mode;
	document.documentElement.style.colorScheme = mode;
}

applyThemeMode();

export function getThemeMode(): ThemeMode {
	return mode;
}

export function setThemeMode(next: ThemeMode): void {
	mode = next;
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, next);
	} catch {
		// The current page can still switch when browser storage is unavailable.
	}
	applyThemeMode();
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

if (typeof window !== "undefined") {
	window.addEventListener("storage", (event) => {
		if (event.storageArea !== window.localStorage || (event.key !== STORAGE_KEY && event.key !== null)) return;
		mode = readThemeMode();
		applyThemeMode();
		for (const listener of listeners) listener();
	});
}

export function useThemeMode(): ThemeMode {
	return useSyncExternalStore(subscribe, getThemeMode, getThemeMode);
}
