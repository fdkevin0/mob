import { toHex } from './hmac';

export const md5 = async (text: string): Promise<string> =>
	toHex(await crypto.subtle.digest('MD5', new TextEncoder().encode(text)));

export function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const size = bytes / Math.pow(1024, i);
	return `${size.toFixed(2)} ${units[i]}`;
}
