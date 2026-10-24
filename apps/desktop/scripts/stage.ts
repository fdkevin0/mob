// Puts the mob binary in bin/ and the app icon in build/ for electron-builder.
// MOB_BINARY names a binary already built, such as a release archive's.
import { $ } from 'bun';
import { copyFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { calfBitmap } from '../src/icon';

const root = `${import.meta.dir}/..`;
const name = process.platform === 'win32' ? 'mob.exe' : 'mob';
mkdirSync(`${root}/bin`, { recursive: true });
if (process.env.MOB_BINARY) copyFileSync(process.env.MOB_BINARY, `${root}/bin/${name}`);
else await $`bun run build && bun apps/mob/scripts/build.ts --outfile ${root}/bin/${name}`.cwd(`${root}/../..`);

mkdirSync(`${root}/build`, { recursive: true });
await Bun.write(`${root}/build/icon.png`, png(calfBitmap(32)));

// png encodes a BGRA bitmap as an RGBA PNG.
function png({ width, height, data }: { width: number; height: number; data: Buffer }) {
	const rows = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const from = (y * width + x) * 4, to = y * (width * 4 + 1) + 1 + x * 4;
		rows[to] = data[from + 2]; rows[to + 1] = data[from + 1]; rows[to + 2] = data[from]; rows[to + 3] = data[from + 3];
	}
	const chunk = (type: string, body: Buffer) => {
		const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4, 'ascii');
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
		return Buffer.concat([head, body, crc]);
	};
	const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header.set([8, 6, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(bytes: Buffer) {
	let crc = ~0;
	for (const byte of bytes) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
	return ~crc >>> 0;
}
