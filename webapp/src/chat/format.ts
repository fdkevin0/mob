/** tokens writes a token count short: 1234 is 1.2k, 45678 is 46k. */
export function tokens(n: number) {
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(n);
}

/** seconds writes a duration short: 420 ms is 0.4s, 12 300 is 12s, 65 000 is 1m 05s. */
export function seconds(ms: number) {
	const s = ms / 1000;
	if (s < 10) return `${s.toFixed(1)}s`;
	if (s < 60) return `${Math.round(s)}s`;
	const whole = Math.round(s);
	return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}
