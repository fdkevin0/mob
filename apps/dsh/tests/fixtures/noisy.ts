import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { writeFileSync } from 'node:fs';

export default {
	inject: ['tools'],
	apply(ctx: Context, config: { called: string; disposed: string }) {
		console.log('plugin loaded');
		ctx.effect(() => () => {
			console.log('plugin disposed');
			writeFileSync(config.disposed, 'disposed');
		});
		ctx.tools.register(
			defineTool({
				name: 'noisy',
				description: '',
				parameters: {},
				output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
				async execute() {
					console.log('plugin called');
					writeFileSync(config.called, 'called');
					return 'ok';
				},
			}),
		);
	},
};
