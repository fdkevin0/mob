// The last signed-in visitor's name and avatar, kept so the header can show
// them while the session check is still answering instead of flashing Log in.
// It is only a hint: the session answer always replaces it. The docs header
// reads the same key from its inline script (apps/docs/src/components/Header.astro).
export const accountHintKey = 'mob-account-hint';

export type AccountHint = { name?: string; email: string; image?: string | null };

export function readAccountHint(): AccountHint | undefined {
	try {
		const hint = JSON.parse(localStorage.getItem(accountHintKey) ?? 'null');
		return hint && typeof hint.email === 'string' ? hint : undefined;
	} catch {
		return undefined;
	}
}

export function writeAccountHint(user: AccountHint | null) {
	try {
		if (user) localStorage.setItem(accountHintKey, JSON.stringify({ name: user.name, email: user.email, image: user.image ?? null }));
		else localStorage.removeItem(accountHintKey);
	} catch { /* storage unavailable: no hint next time */ }
}
