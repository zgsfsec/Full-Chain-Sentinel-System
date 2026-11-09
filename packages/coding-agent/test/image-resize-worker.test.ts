import { parentPort } from "node:worker_threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setEmbeddedPhotonWasmPath } from "../src/config.ts";
import { resizeImageInProcess } from "../src/utils/image-resize-core.ts";
import { loadPhoton } from "../src/utils/photon.ts";
import "../src/utils/image-resize-worker.ts";

vi.mock("node:worker_threads", () => ({
	parentPort: { once: vi.fn(), postMessage: vi.fn() },
	workerData: { photonWasmPath: "/$bunfs/root/photon_rs_bg.wasm" },
}));
vi.mock("../src/config.ts", () => ({ setEmbeddedPhotonWasmPath: vi.fn() }));
vi.mock("../src/utils/photon.ts", () => ({ loadPhoton: vi.fn().mockResolvedValue({}) }));
vi.mock("../src/utils/image-resize-core.ts", () => ({
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE: "pi:image-resize-response",
	resizeImageInProcess: vi.fn().mockResolvedValue(null),
}));

describe("image resize worker startup", () => {
	const port = parentPort!;
	const onMessage = vi.mocked(port.once).mock.calls[0][1] as (message: unknown) => void;
	const request = { inputBytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };

	beforeEach(() => {
		vi.mocked(loadPhoton).mockClear();
		vi.mocked(port.postMessage).mockClear();
		vi.mocked(resizeImageInProcess).mockClear();
	});

	it("registers embedded WASM before loading the image engine", async () => {
		expect(setEmbeddedPhotonWasmPath).toHaveBeenCalledWith("/$bunfs/root/photon_rs_bg.wasm");
		expect(loadPhoton).not.toHaveBeenCalled();

		onMessage(request);

		await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
		expect(resizeImageInProcess).toHaveBeenCalledWith(request.inputBytes, "image/png", undefined);
		expect(port.postMessage).toHaveBeenCalledWith({ type: "pi:image-resize-response", result: null });
	});

	it("reports engine loading failure as an error to enable the caller's fallback", async () => {
		vi.mocked(loadPhoton).mockResolvedValueOnce(null);

		onMessage(request);

		await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
		expect(port.postMessage).toHaveBeenCalledWith({
			type: "pi:image-resize-response",
			error: "Image processing engine is unavailable in the resize worker",
		});
		expect(resizeImageInProcess).not.toHaveBeenCalled();
	});
});
