import { parentPort, workerData } from "node:worker_threads";
import { setEmbeddedPhotonWasmPath } from "../config.ts";
import {
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
	type ImageResizeOptions,
	type ResizeImageWorkerResponse,
	resizeImageInProcess,
} from "./image-resize-core.ts";
import { loadPhoton } from "./photon.ts";

interface ResizeImageWorkerRequest {
	inputBytes: Uint8Array;
	mimeType: string;
	options?: ImageResizeOptions;
}

function isResizeImageWorkerRequest(value: unknown): value is ResizeImageWorkerRequest {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.inputBytes instanceof Uint8Array && typeof record.mimeType === "string";
}

const port = parentPort;
if (!port) {
	throw new Error("image resize worker requires parentPort");
}

// Module state is isolated per worker. Register the executable's embedded WASM
// path before Photon is first loaded in this thread.
const runtimeData: unknown = workerData;
if (
	runtimeData &&
	typeof runtimeData === "object" &&
	"photonWasmPath" in runtimeData &&
	typeof runtimeData.photonWasmPath === "string"
) {
	setEmbeddedPhotonWasmPath(runtimeData.photonWasmPath);
}

port.once("message", (message: unknown) => {
	void (async () => {
		try {
			if (!isResizeImageWorkerRequest(message)) {
				throw new Error("Invalid image resize worker request");
			}
			// A worker-only loading failure must trigger the caller's in-process
			// fallback instead of looking like an image that cannot fit the limits.
			if (!(await loadPhoton())) {
				throw new Error("Image processing engine is unavailable in the resize worker");
			}
			const result = await resizeImageInProcess(message.inputBytes, message.mimeType, message.options);
			const response: ResizeImageWorkerResponse = { type: IMAGE_RESIZE_WORKER_RESPONSE_TYPE, result };
			port.postMessage(response);
		} catch (error) {
			const response: ResizeImageWorkerResponse = {
				type: IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
				error: error instanceof Error ? error.message : String(error),
			};
			port.postMessage(response);
		}
	})();
});
