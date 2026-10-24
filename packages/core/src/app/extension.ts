// Background extensions: plugins that run while they are enabled, such as a
// channel polling its messaging app. Each starts, reports a status line, and
// stops when it is reloaded or Mob closes.

/** Serve runs an extension until signal aborts, reporting its status. */
export type Serve = (signal: AbortSignal, status: (text: string) => void) => Promise<void>;

/** Extension starts a background plugin: undefined from start means it is off. */
export type Extension = { name: string; start: () => Serve | undefined | Promise<Serve | undefined> };

export const disabled = 'Disabled', connecting = 'Connecting…';

export class ExtensionsClosed extends Error {
	constructor() { super('extensions are stopped'); }
}

type Unit = Extension & { controller?: AbortController; done?: Promise<void>; status: string; generation: number };

export class Extensions {
	private units: Unit[] = [];
	private closed = false;
	private queue: Promise<unknown> = Promise.resolve();
	/** report hears an extension's start failure or crash. */
	report: (name: string, err: unknown) => void = (name, err) => console.error(`extension ${name}:`, err);

	register(...extensions: Extension[]) {
		for (const e of extensions) {
			if (this.units.some(u => u.name === e.name)) throw new Error('extension registered twice: ' + e.name);
			this.units.push({ ...e, status: disabled, generation: 0 });
		}
	}

	/** serialize runs operations one at a time, so a reload never races another. */
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.catch(() => {});
		return next;
	}

	startAll() { return this.serialize(async () => { for (const u of this.units) await this.restart(u); }); }

	/** reload restarts one extension with its saved configuration. */
	reload(name: string) {
		return this.serialize(async () => {
			const u = this.units.find(u => u.name === name);
			if (u) await this.restart(u);
		});
	}

	private async stop(u: Unit) {
		u.generation++;
		u.controller?.abort();
		u.controller = undefined;
		u.status = disabled;
		await u.done;
		u.done = undefined;
	}

	private async restart(u: Unit) {
		if (this.closed) throw new ExtensionsClosed();
		await this.stop(u);
		const serve = await u.start();
		if (!serve) return;
		const controller = new AbortController();
		const generation = u.generation;
		u.controller = controller;
		u.status = connecting;
		u.done = serve(controller.signal, text => { if (u.generation === generation) u.status = text; })
			.catch(e => { if (!controller.signal.aborted) this.report(u.name, e); })
			.finally(() => {
				if (u.generation === generation && !this.closed) { u.controller = undefined; u.status = 'Stopped'; }
			});
	}

	status(name: string) { return this.units.find(u => u.name === name)?.status ?? ''; }
	isClosed() { return this.closed; }

	close() {
		return this.serialize(async () => {
			this.closed = true;
			for (const u of [...this.units].reverse()) await this.stop(u);
		});
	}
}
