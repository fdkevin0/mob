// Which addresses are this computer, and which URLs may carry a credential:
// HTTPS anywhere, plain HTTP only to loopback. Every check in Mob uses these.

/** isLoopbackHost reports whether hostname, as URL.hostname gives it (IPv6 in brackets or not), names this computer. */
export function isLoopbackHost(hostname: string) {
	const h = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
	return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** secureURL reports whether u is HTTPS, or HTTP to loopback. */
export const secureURL = (u: URL) => u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname));
