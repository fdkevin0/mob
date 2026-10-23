import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { cacheScope, forget, keptConversations, readList, readSnapshot, setKeepsMessages, writeList, writeSnapshot } from './localCache';

const local = cacheScope({ url: 'http://127.0.0.1:8787', token: 't' });
const runner = cacheScope({ url: 'https://mob.example/api/runners/r1', token: '', runner: { id: 'r1', key: 'k' } });
const snapshot = (text: string) => ({
	messages: [{ id: text, role: 'assistant' as const, parts: [{ type: 'text' as const, text }] }],
	active: false,
	model: 'demo/echo',
});

afterEach(async () => {
	await setKeepsMessages(false);
	await forget(local);
	await forget(runner);
});

it('keeps only titles unless this device keeps messages', async () => {
	await writeList(local, [{ id: 'one', title: 'First', updatedAt: 1, extra: 'not kept' } as never]);
	expect(await readList(local)).toEqual([{ id: 'one', title: 'First', updatedAt: 1 }]);
	await writeSnapshot(local, 'one', snapshot('hello'));
	expect(await readSnapshot(local, 'one')).toBeUndefined();
	await setKeepsMessages(true);
	await writeSnapshot(local, 'one', snapshot('hello'));
	expect(await readSnapshot(local, 'one')).toEqual(snapshot('hello'));
	// Turning it off forgets the messages, not the titles.
	await setKeepsMessages(false);
	await setKeepsMessages(true);
	expect(await readSnapshot(local, 'one')).toBeUndefined();
	expect(await readList(local)).toHaveLength(1);
});

it('keeps each Mob apart, forgets one alone, and keeps only the most recent conversations', async () => {
	await setKeepsMessages(true);
	await writeList(local, [{ id: 'one', title: 'Local', updatedAt: 1 }]);
	await writeList(runner, [{ id: 'one', title: 'Runner', updatedAt: 1 }]);
	for (let i = 0; i <= keptConversations; i++) await writeSnapshot(runner, `c${i}`, snapshot(`m${i}`));
	expect(await readSnapshot(runner, 'c0')).toBeUndefined();
	expect(await readSnapshot(runner, `c${keptConversations}`)).toBeDefined();
	await forget(runner);
	expect(await readList(runner)).toBeUndefined();
	expect((await readList(local))?.[0].title).toBe('Local');
});
