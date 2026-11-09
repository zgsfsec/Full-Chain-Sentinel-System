/** Coalesce state changes before constructing and serializing a full transcript. */
export class SnapshotBroadcast {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly publish: () => void;

	constructor(publish: () => void) {
		this.publish = publish;
	}

	schedule(): void {
		if (this.timer !== undefined) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.publish();
		}, 100);
	}

	cancel(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}
