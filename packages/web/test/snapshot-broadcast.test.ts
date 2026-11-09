import { afterEach, expect, test, vi } from "vitest";
import { SnapshotBroadcast } from "../src/snapshot-broadcast.ts";

afterEach(() => {
	vi.useRealTimers();
});

test("dense changes build one snapshot from the latest state", () => {
	vi.useFakeTimers();
	let state = 0;
	const publish = vi.fn(() => state);
	const snapshots = new SnapshotBroadcast(publish);
	for (let i = 0; i < 100; i += 1) {
		state = i;
		snapshots.schedule();
	}
	expect(publish).not.toHaveBeenCalled();
	vi.advanceTimersByTime(100);
	expect(publish).toHaveBeenCalledTimes(1);
	expect(publish).toHaveReturnedWith(99);
	state = 100;
	snapshots.schedule();
	vi.advanceTimersByTime(100);
	expect(publish).toHaveBeenCalledTimes(2);
	expect(publish).toHaveLastReturnedWith(100);
});

test("shutdown cancels pending snapshot construction", () => {
	vi.useFakeTimers();
	const publish = vi.fn();
	const snapshots = new SnapshotBroadcast(publish);
	snapshots.schedule();
	snapshots.cancel();
	vi.advanceTimersByTime(1000);
	expect(publish).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});
