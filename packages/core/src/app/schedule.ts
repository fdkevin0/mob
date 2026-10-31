// Schedules let the owner's model run a prompt on its own at a set time, once
// or repeatedly: a morning summary of the projects, a reminder, a check on a
// task. A scheduled prompt runs as a turn of the owner's in the conversation
// that scheduled it, and the owner hears its conclusion in the messaging apps
// they use.
import { cell, interactive, clientTelegram, type Command } from '../chat/commands';
import { CommandError, type ConversationService } from '../chat/conversation';
import type { Running } from '../chat/running';
import { newID } from '../chat/sql';
import type { Schedule, Store } from '../chat/store';
import { z } from 'zod';
import { defineTool, rfc3339, type Tool } from '../chat/tools';
import type { Extension } from './extension';
import type { Plugin } from './server';

/** repeats are how a schedule may repeat; empty runs it once. */
export const repeats = ['hourly', 'daily', 'weekdays', 'weekly'];

/** tick is how often due schedules are looked for. */
const tick = 30_000;
/** promptLimit bounds a scheduled prompt, in bytes; noticeLimit the conclusion a notice repeats, in characters. */
const promptLimit = 4000, noticeLimit = 1200;

const runPrompt = (when: string, prompt: string) => `Scheduled by the owner with the schedule tool, now due (${when}): ${prompt}\nDo it now, then end with a short conclusion for the owner.`;

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** zone is the named time zone, or Mob's own when the name is empty or unknown. */
export function zone(name?: string) {
	if (name) try { new Intl.DateTimeFormat('en-US', { timeZone: name }); return name; } catch { /* Mob's own */ }
	return localZone();
}

type Wall = { y: number; m: number; d: number; h: number; min: number; s: number; weekday: number };

/** wall is the date and time at ms in zone. */
function wall(ms: number, zone: string): Wall {
	const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ms).map(x => [x.type, x.value]));
	const w = { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, min: +p.minute!, s: +p.second! };
	return { ...w, weekday: new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay() };
}

const offset = (ms: number, zone: string) => {
	const w = wall(ms, zone);
	return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(ms / 1000) * 1000;
};

/** at is the instant of a wall time in zone; days and hours past their range carry over, as Go's time.Date does. */
export function at(y: number, m: number, d: number, h: number, min: number, zone: string) {
	const utc = Date.UTC(y, m - 1, d, h, min);
	// The offsets a day either side cover any transition; the earlier instant
	// wins a repeated hour, and a skipped one uses the offset before it, as Go does.
	const before = utc - offset(utc - 86400_000, zone), after = utc - offset(utc + 86400_000, zone);
	const want = wall(utc, 'UTC');
	const fits = (ms: number) => { const w = wall(ms, zone); return w.h === want.h && w.min === want.min && w.d === want.d; };
	const fit = [before, after].filter(fits).sort((a, b) => a - b);
	return fit[0] ?? before;
}

/** readable is ms in zone as "Mon 2006-01-02 15:04 MST". */
export function readable(ms: number, zone: string) {
	const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).formatToParts(ms).map(x => [x.type, x.value]));
	return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

const clockOf = (ms: number, zone: string) => { const w = wall(ms, zone); return `${String(w.h).padStart(2, '0')}:${String(w.min).padStart(2, '0')}`; };

/**
 * next is the first time after now that a schedule last due at last runs
 * again. Calendar repeats count days in zone and run at clock (15:04) there,
 * so a daily schedule keeps its time of day across daylight saving changes.
 */
export function next(last: number, repeat: string, zone: string, clock: string | undefined, now: number) {
	if (repeat === 'hourly') {
		let t = last;
		while (t <= now) t += 3600_000;
		return t;
	}
	const day = wall(last, zone);
	let { h, min } = day;
	const c = /^(\d{2}):(\d{2})$/.exec(clock ?? '');
	if (c && +c[1]! < 24 && +c[2]! < 60) { h = +c[1]!; min = +c[2]!; }
	let d = day.d;
	const weekday = (d: number) => new Date(Date.UTC(day.y, day.m - 1, d)).getUTCDay();
	for (;;) {
		if (repeat === 'weekly') d += 7;
		else if (repeat === 'weekdays') {
			d++;
			while (weekday(d) === 0 || weekday(d) === 6) d++;
		} else d++;
		const t = at(day.y, day.m, d, h, min, zone);
		if (t > now) return t;
	}
}

function firstLine(text: string) {
	const line = text.trim().split('\n')[0]!;
	const chars = [...line];
	return chars.length > 80 ? chars.slice(0, 80).join('') + '…' : line;
}

const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

type Request = { prompt: string; at: string; repeat?: string; timezone?: string };


/** Schedules runs the schedules. */
export class Schedules {
	private wake?: () => void;

	constructor(readonly store: Store, readonly conversations: ConversationService,
		/** now is the clock. */
		readonly now: () => number = Date.now) {}

	/** extension runs due schedules while Mob runs. */
	extension(): Extension {
		return { name: 'schedules', start: () => async (signal, status) => {
			status('Running');
			while (!signal.aborted) {
				await this.runDue();
				await new Promise<void>(resolve => {
					const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); this.wake = undefined; resolve(); };
					const timer = setTimeout(done, tick);
					signal.addEventListener('abort', done, { once: true });
					this.wake = done;
				});
			}
		} };
	}

	private poke() { this.wake?.(); }

	/**
	 * runDue starts a turn for each schedule that is due. A one-off schedule is
	 * then deleted and a repeating one moved to its next time; one whose
	 * conversation is busy waits for the next look. A repeat Mob missed while
	 * it was stopped runs once, not once for each time it missed.
	 */
	async runDue() {
		const now = this.now();
		let due: Schedule[];
		try { due = this.store.schedules(now); } catch { return; }
		for (const sc of due) {
			let run: Running | undefined, err: unknown;
			try {
				run = await this.conversations.start({ id: sc.conversationId, text: runPrompt(readable(sc.next, zone(sc.zone)), sc.prompt), requestId: newID(), owner: true });
			} catch (e) {
				if (e instanceof CommandError && e.status === 409) continue;
				err = e;
			}
			try {
				if (!sc.repeat) this.store.unschedule(sc.id);
				else this.store.reschedule(sc.id, next(sc.next, sc.repeat, zone(sc.zone), sc.clock, now));
			} catch { /* the next look tries again */ }
			if (!run) {
				this.conversations.notify({ conversationId: sc.conversationId, text: `**Scheduled prompt could not run:** ${firstLine(sc.prompt)}\n\n${(err as Error).message}` });
				continue;
			}
			void this.report(sc, run);
		}
	}

	/** report tells the owner what a scheduled turn concluded once it ends. */
	private async report(sc: Schedule, run: Running) {
		await run.whenDone();
		// The reply this turn wrote, not a later turn's.
		let said = '';
		try { said = (this.store.reply(run.messageId) ?? '').trim(); } catch { /* reported as unfinished */ }
		const chars = [...said];
		if (chars.length > noticeLimit) said = chars.slice(0, noticeLimit).join('') + '…';
		if (!said) said = 'It did not finish; open its conversation to see why.';
		this.conversations.notify({ conversationId: sc.conversationId, text: `**Scheduled:** ${firstLine(sc.prompt)}\n\n${said}`, approvals: this.conversations.pending(sc.conversationId) });
	}

	/** any reports whether anything is scheduled; until then only schedule is offered. */
	private any = () => { try { return this.store.schedules(0).length > 0; } catch { return false; } };

	/** tools schedule prompts, list them and cancel them. */
	tools(): Tool[] {
		return [defineTool({
			name: 'schedule',
			description: 'Ask the owner to approve running a prompt on your own later, once or repeatedly, such as a morning summary of the coding tasks or a reminder. It runs as a turn in this conversation and the owner is told its conclusion. Get the current time with datetime first. The turn stops until the owner approves.',
			input: z.object({
				prompt: z.string().describe('What to do when it runs, with everything needed, as an instruction to yourself'),
				at: z.string().describe('When it first runs, RFC 3339 with an offset, such as 2026-10-21T09:00:00+08:00'),
				repeat: z.enum(repeats).optional().describe('Repeat after each run; omit to run once'),
				timezone: z.string().optional().describe("IANA time zone repeats keep their time of day in, such as Asia/Shanghai; default the computer's"),
			}),
			prompt: 'You can act later on your own: schedule runs a prompt at a set time, once or repeatedly; schedules lists them and schedule_cancel cancels one.',
			ownerOnly: true,
			run: call => this.ask(call.input, r => call.requestApproval(r)),
			approved: async call => this.add(call.conversationId, JSON.parse(call.input) as Request),
		}), defineTool({
			name: 'schedules', description: 'List the scheduled prompts: ID, prompt, next run and repeat.', input: z.object({}),
			ownerOnly: true, available: this.any,
			run: async () => ({ schedules: this.store.schedules(0).map(sc => ({ id: sc.id, prompt: sc.prompt, next: rfc3339(new Date(sc.next), zone(sc.zone)), repeat: sc.repeat ?? '', conversation: sc.conversationId })) }),
		}), defineTool({
			name: 'schedule_cancel', description: 'Cancel a scheduled prompt.', input: z.object({ id: z.string().describe("The schedule's ID") }),
			ownerOnly: true, available: this.any,
			run: async call => {
				const id = call.input.id;
				if (!id || id === 'all') throw new Error("give one schedule's ID");
				if (!this.store.unschedule(id)) throw new Error(`no schedule ${id}`);
				return { cancelled: true };
			},
		})];
	}

	/** ask checks a schedule call and asks the owner to approve it. */
	ask(input: Record<string, unknown>, request: (r: Request) => Promise<never>): Promise<never> {
		const str = (v: unknown) => typeof v === 'string' ? v : '';
		const r: Request = { prompt: str(input.prompt).trim(), at: str(input.at) };
		if (input.repeat) r.repeat = str(input.repeat);
		if (input.timezone) r.timezone = str(input.timezone);
		if (!r.prompt || new TextEncoder().encode(r.prompt).length > promptLimit) throw new Error(`prompt must be 1–${promptLimit} bytes`);
		if (!rfc3339Pattern.test(r.at) || Number.isNaN(Date.parse(r.at))) throw new Error('at must be RFC 3339 with an offset, such as 2026-10-21T09:00:00+08:00');
		if (r.repeat && !repeats.includes(r.repeat)) throw new Error(`repeat must be one of ${repeats.join(', ')}`);
		if (r.timezone && zone(r.timezone) !== r.timezone) throw new Error(`unknown time zone ${JSON.stringify(r.timezone)}`);
		if (!r.repeat && Date.parse(r.at) < this.now()) throw new Error(`${r.at} has passed; it is now ${rfc3339(new Date(this.now()), localZone())}`);
		r.at = r.at.replace(/\.\d+/, '');
		return request(r);
	}

	/** add saves an approved schedule in the conversation that asked for it. */
	add(conversationId: string, r: Request) {
		const first = Date.parse(r.at);
		if (Number.isNaN(first)) throw new Error('invalid time ' + r.at);
		const tz = zone(r.timezone);
		const sc = { conversationId, prompt: r.prompt, next: first, repeat: r.repeat, zone: r.timezone, clock: clockOf(first, tz) };
		// A repeat whose first time has passed starts at its next one.
		const now = this.now();
		if (sc.repeat && first < now) sc.next = next(first, sc.repeat, tz, sc.clock, now);
		const saved = this.store.addSchedule(sc);
		this.poke();
		return { schedule: saved.id, next: rfc3339(new Date(saved.next), tz), repeat: saved.repeat ?? '' };
	}

	/** commands list and cancel schedules. */
	commands(): Command[] {
		return [{
			name: 'schedules', usage: '/schedules', summary: 'List scheduled prompts', clients: [...interactive, clientTelegram], ownerOnly: true,
			run: async () => {
				const all = this.store.schedules(0);
				if (!all.length) return { markdown: 'Nothing is scheduled. Ask Mob to do something later, such as "every weekday at 9 summarize my coding tasks".' };
				let b = '| Prompt | Next | Repeat | Cancel |\n| --- | --- | --- | --- |\n';
				for (const sc of all) b += `| ${cell(firstLine(sc.prompt))} | ${readable(sc.next, zone(sc.zone))} | ${sc.repeat || 'once'} | \`/unschedule ${sc.id}\` |\n`;
				return { markdown: b + '\n`/unschedule all` cancels every one.' };
			},
		}, {
			name: 'unschedule', usage: '/unschedule ID|all', summary: 'Cancel a scheduled prompt', clients: [...interactive, clientTelegram], ownerOnly: true,
			run: async call => {
				if (call.fields.length !== 1) return { markdown: 'Use `/unschedule ID` or `/unschedule all`; `/schedules` lists them.' };
				const n = this.store.unschedule(call.fields[0]!);
				return { markdown: n ? `Cancelled ${n} scheduled prompt(s).` : `No schedule has ID \`${cell(call.fields[0]!)}\`.` };
			},
		}];
	}
}

/** schedulePlugin adds schedules to a service. */
export function schedulePlugin(s: Schedules): Plugin {
	return { name: 'schedules', routes: [{ method: 'GET', path: 'list', handle: async () => s.store.schedules(0) }], commands: s.commands(), tools: s.tools(), background: s.extension() };
}
