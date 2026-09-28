/**
 * Cryptographic primitives shared by webhook routing and Telegram Mini App
 * `initData` verification.
 */

/** Convert a digest (e.g. from `crypto.subtle.sign`) to lowercase hex. */
export function toHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 digest of a UTF-8 string, as lowercase hex.
 */
export async function sha256Hex(data: string): Promise<string> {
	return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)));
}
