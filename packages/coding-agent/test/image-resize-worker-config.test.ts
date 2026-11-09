import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPhotonWasmPath } from "../src/config.ts";
import { resizeImage } from "../src/utils/image-resize.ts";
import { resizeImageInProcess } from "../src/utils/image-resize-core.ts";

const mocks = vi.hoisted(() => ({
	construct: vi.fn(),
	postMessage: vi.fn(),
	terminate: vi.fn().mockResolvedValue(0),
	replyError: undefined as string | undefined,
}));

vi.mock("node:worker_threads", () => ({
	Worker: class extends EventEmitter {
		terminate = mocks.terminate;

		constructor(specifier: string | URL, options: unknown) {
			super();
			mocks.construct(specifier, options);
		}

		postMessage(...args: unknown[]): void {
			mocks.postMessage(...args);
			queueMicrotask(() => {
				this.emit("message", {
					type: "pi:image-resize-response",
					...(mocks.replyError ? { error: mocks.replyError } : { result: null }),
				});
			});
		}
	},
}));

vi.mock("../src/config.ts", () => ({ getEmbeddedPhotonWasmPath: vi.fn() }));
vi.mock("../src/utils/image-resize-core.ts", () => ({
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE: "pi:image-resize-response",
	resizeImageInProcess: vi.fn(),
}));

describe("image resize worker configuration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.replyError = undefined;
		vi.mocked(getEmbeddedPhotonWasmPath).mockReturnValue("/$bunfs/root/photon_rs_bg.wasm");
	});

	it("passes embedded WASM to workers without transferring the caller's buffer", async () => {
		const input = new Uint8Array([1, 2, 3]);
		const options = { maxWidth: 100 };

		expect(await resizeImage(input, "image/png", options)).toBeNull();

		expect(mocks.construct).toHaveBeenCalledWith(expect.anything(), {
			workerData: { photonWasmPath: "/$bunfs/root/photon_rs_bg.wasm" },
		});
		const [request, transfers] = mocks.postMessage.mock.calls[0];
		expect(request).toEqual({ inputBytes: input, mimeType: "image/png", options });
		expect(request.inputBytes.buffer).not.toBe(input.buffer);
		expect(transfers).toEqual([request.inputBytes.buffer]);
		expect(mocks.terminate).toHaveBeenCalledOnce();
		// A genuine size/decode failure should not repeat expensive processing.
		expect(resizeImageInProcess).not.toHaveBeenCalled();
	});

	it("retries in process when the worker reports an unavailable image engine", async () => {
		mocks.replyError = "Image processing engine is unavailable in the resize worker";
		const input = new Uint8Array([1, 2, 3]);
		const result = {
			data: "AQID",
			mimeType: "image/png",
			originalWidth: 1,
			originalHeight: 1,
			width: 1,
			height: 1,
			wasResized: false,
		};
		vi.mocked(resizeImageInProcess).mockResolvedValue(result);

		expect(await resizeImage(input, "image/png")).toEqual(result);

		expect(resizeImageInProcess).toHaveBeenCalledWith(input, "image/png", undefined);
		expect(mocks.terminate).toHaveBeenCalled();
	});
});
