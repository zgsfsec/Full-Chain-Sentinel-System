import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dockerBashOperations } from "../src/docker.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	kill = vi.fn(() => true);
}

const children: FakeChild[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	spawn.mockReset();
	children.length = 0;
	spawn.mockImplementation(() => {
		const child = new FakeChild();
		children.push(child);
		return child;
	});
});

afterEach(() => {
	for (const child of children) {
		child.stdout.destroy();
		child.stderr.destroy();
	}
	vi.useRealTimers();
});

test("preserves output, cwd and shell arguments, and clears the timer on completion", async () => {
	const onData = vi.fn();
	const command = 'printf "%s" "quoted $value; text"';
	const result = dockerBashOperations("project", { hostWorkDir: "/host/project" }).exec(
		command,
		"/host/project/task",
		{
			onData,
			timeout: 2,
		},
	);
	expect(spawn.mock.calls[0][1]).toEqual([
		"exec",
		"-i",
		"-w",
		"/work/task",
		"-e",
		expect.stringMatching(/^SENTINEL_BASH_EXEC_ID=/),
		"project",
		"sh",
		"-c",
		command,
	]);
	children[0].stdout.write("stdout");
	children[0].stderr.write("stderr");
	children[0].emit("exit", 7);
	// Wait for close so the final buffered output is preserved.
	children[0].stdout.write("last output");
	children[0].emit("close", 7);
	await expect(result).resolves.toEqual({ exitCode: 7 });
	expect(onData.mock.calls.map(([chunk]) => chunk.toString())).toEqual(["stdout", "stderr", "last output"]);
	await vi.advanceTimersByTimeAsync(3000);
	expect(spawn).toHaveBeenCalledTimes(1);
});

test("enforces the requested timeout even when Docker never closes its pipes", async () => {
	const result = dockerBashOperations("project").exec("blocked command | tail -20", "/work", {
		onData: vi.fn(),
		timeout: 0.22,
	});
	const rejection = expect(result).rejects.toThrow("timeout:0.22");
	await vi.advanceTimersByTimeAsync(219);
	expect(children[0].kill).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(children[0].kill).toHaveBeenCalledWith("SIGKILL");
	expect(children[0].stdout.destroyed).toBe(true);
	const marker = spawn.mock.calls[0][1][5];
	expect(spawn.mock.calls[1][1]).toEqual([
		"exec",
		"project",
		"sh",
		"-c",
		expect.stringContaining("/proc/[0-9]*/environ"),
		"zg",
		marker,
	]);
	children[1].emit("exit", 0);
	await rejection;
	expect(vi.getTimerCount()).toBe(0);
});

test("abort cleans container processes even after the Docker client exits", async () => {
	const controller = new AbortController();
	const result = dockerBashOperations("project").exec("sleep 100", "/work", {
		onData: vi.fn(),
		signal: controller.signal,
		timeout: 10,
	});
	const rejection = expect(result).rejects.toThrow("aborted");
	controller.abort();
	children[0].emit("close", null);
	children[1].emit("exit", 0);
	await rejection;
	expect(spawn).toHaveBeenCalledTimes(2);
	expect(vi.getTimerCount()).toBe(0);
});

test("does not launch a command whose signal is already aborted", async () => {
	await expect(
		dockerBashOperations("project").exec("touch unwanted", "/work", {
			onData: vi.fn(),
			signal: AbortSignal.abort(),
		}),
	).rejects.toThrow("aborted");
	expect(spawn).not.toHaveBeenCalled();
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_484])(
	"rejects invalid timeout %s before launching",
	async (timeout) => {
		await expect(
			dockerBashOperations("project").exec("sleep 100", "/work", {
				onData: vi.fn(),
				timeout,
			}),
		).rejects.toThrow("Invalid timeout");
		expect(spawn).not.toHaveBeenCalled();
	},
);

test("does not hang when container cleanup also hangs", async () => {
	const onData = vi.fn();
	const result = dockerBashOperations("project").exec("sleep 100", "/work", { onData, timeout: 1 });
	const rejection = expect(result).rejects.toThrow("timeout:1");
	await vi.advanceTimersByTimeAsync(6000);
	await rejection;
	expect(children[1].kill).toHaveBeenCalledWith("SIGKILL");
	expect(onData.mock.calls[0][0].toString()).toContain("cleanup failed");
	expect(vi.getTimerCount()).toBe(0);
});

test("handles Docker spawn errors and removes abort listeners and timers", async () => {
	const controller = new AbortController();
	const result = dockerBashOperations("project").exec("true", "/work", {
		onData: vi.fn(),
		timeout: 1,
		signal: controller.signal,
	});
	const rejection = expect(result).rejects.toThrow("spawn docker ENOENT");
	children[0].emit("error", new Error("spawn docker ENOENT"));
	await rejection;
	controller.abort();
	await vi.advanceTimersByTimeAsync(2000);
	expect(spawn).toHaveBeenCalledTimes(1);
});

test("uses a different cleanup marker for each concurrent call", async () => {
	const operations = dockerBashOperations("project");
	const first = operations.exec("true", "/work", { onData: vi.fn() });
	const second = operations.exec("true", "/work", { onData: vi.fn() });
	expect(spawn.mock.calls[0][1][5]).not.toBe(spawn.mock.calls[1][1][5]);
	children[0].emit("close", 0);
	children[1].emit("close", 0);
	await Promise.all([first, second]);
});
