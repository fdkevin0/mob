import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'greet';
export const inject = ['tools'];

export function apply(ctx: Context, config: { greeting?: string } = {}) {
	ctx.tools.register(
		defineTool({
			name: 'greet',
			description: 'Greet someone by name.',
			parameters: { name: { type: 'string', required: true } },
			output: {
				schema: { type: 'string' },
				render: (_args, value) => [{ type: 'text', text: value }],
			},
			async execute(args) {
				return `${config.greeting ?? 'Hello'}, ${args.name}!`;
			},
		}),
	);
}
