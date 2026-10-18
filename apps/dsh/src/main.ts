import { Console } from 'node:console';

// Plugin console output must not become MCP messages on stdout.
globalThis.console = new Console(process.stderr, process.stderr);

async function main() {
	if (process.argv.length !== 3) throw new Error('Usage: bun apps/dsh/src/main.ts /absolute/path/plugins.json');
	const { loadPlugins } = await import('./config');
	const { createBridge } = await import('./bridge');
	const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
	const bridge = await createBridge(await loadPlugins(process.argv[2]));
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		const deadline = setTimeout(() => {
			console.error('DSH plugin shutdown did not finish within 5 seconds');
			process.exit(1);
		}, 5000);
		void bridge.close().then(
			() => {
				clearTimeout(deadline);
				process.exit(0);
			},
			(error) => {
				console.error(error);
				process.exit(1);
			},
		);
	};
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
	process.stdin.once('end', stop);
	try {
		await bridge.server.connect(new StdioServerTransport());
		if (process.stdin.readableEnded) stop();
	} catch (error) {
		await bridge.close();
		throw error;
	}
}

try {
	await main();
} catch (error) {
	console.error(error);
	process.exit(1);
}
