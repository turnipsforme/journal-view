/**
 * Serialises writes for a single note, newest value wins.
 *
 * The point is that a value handed to `submit` is captured immediately and is
 * no longer tied to whatever produced it. A day's editor can be torn down the
 * instant after submitting, mid-write, and the queued text still reaches disk.
 *
 * `write` reports success; failed writes keep their newest value and retry with
 * bounded backoff even after the editor is removed.
 */
export class SaveQueue {
	private pending: string | null = null;
	private inFlight: Promise<void> | null = null;
	private retryTimer = 0;
	private retryDelay = 2000;

	constructor(private write: (value: string) => Promise<boolean>) {}

	get hasPending(): boolean {
		return this.pending !== null || this.inFlight !== null;
	}

	/** Queues `value`; waits for this attempt. Failures stay pending for retry. */
	submit(value: string): Promise<void> {
		this.pending = value;
		window.clearTimeout(this.retryTimer);
		this.retryTimer = 0;
		if (!this.inFlight) {
			this.inFlight = Promise.resolve().then(() => this.run()).finally(() => {
				this.inFlight = null;
				if (this.pending !== null) {
					// The timer owns the pending text even after its editor disappears.
					// Back off during disk/sync failures without abandoning the edit.
					this.retryTimer = window.setTimeout(() => {
						this.retryTimer = 0;
						if (this.pending !== null) void this.submit(this.pending);
					}, this.retryDelay);
					this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
				} else this.retryDelay = 2000;
			});
		}
		return this.inFlight;
	}

	/** Waits for active writes; hasPending remains true during a failed-write retry. */
	async settled(): Promise<void> {
		while (this.inFlight) await this.inFlight;
	}

	private async run(): Promise<void> {
		while (this.pending !== null) {
			const value = this.pending;
			this.pending = null;

			let ok = false;
			try {
				ok = await this.write(value);
			} catch (error) {
				console.error("Journal View: queued write failed", error);
			}
			if (!ok) {
				// Hold the newest text for a later attempt, but stop looping so a
				// permanent failure cannot spin.
				if (this.pending === null) this.pending = value;
				return;
			}
		}
	}
}
