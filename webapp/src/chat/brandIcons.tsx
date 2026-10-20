// Runtime and model logos from LobeHub's icon set (MIT), inlined so the
// page's content security policy needs no image sources.
import amp from '@lobehub/icons-static-svg/icons/amp-color.svg?raw';
import anthropic from '@lobehub/icons-static-svg/icons/anthropic.svg?raw';
import claude from '@lobehub/icons-static-svg/icons/claude-color.svg?raw';
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg?raw';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw';
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg?raw';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?raw';
import kimi from '@lobehub/icons-static-svg/icons/kimi-color.svg?raw';
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg?raw';
import openai from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg?raw';
import zhipu from '@lobehub/icons-static-svg/icons/zhipu-color.svg?raw';

type Brand = { name: string; svg: string };

// Runtimes are the coding agents Mob starts, by preset name.
const runtimes: Record<string, Brand> = {
	codex: { name: 'Codex', svg: codex },
	claude: { name: 'Claude Agent', svg: anthropic },
	amp: { name: 'Amp', svg: amp },
	dsh: { name: 'DeepSeek', svg: deepseek },
};

// Model families, matched against the model's name or ID.
const families: [RegExp, Brand][] = [
	[/claude|opus|sonnet|haiku|anthropic/, { name: 'Claude', svg: claude }],
	[/gpt|codex|openai|\bo[134]\b|o[134]-/, { name: 'OpenAI', svg: openai }],
	[/deepseek/, { name: 'DeepSeek', svg: deepseek }],
	[/gemini|gemma/, { name: 'Gemini', svg: gemini }],
	[/qwen|qwq/, { name: 'Qwen', svg: qwen }],
	[/kimi|moonshot/, { name: 'Kimi', svg: kimi }],
	[/glm|zhipu/, { name: 'Zhipu', svg: zhipu }],
	[/grok|xai/, { name: 'Grok', svg: grok }],
	[/mistral|codestral|devstral/, { name: 'Mistral', svg: mistral }],
];

// What a runtime's model is when it does not say.
const defaults: Record<string, string> = { codex: 'gpt', claude: 'claude', dsh: 'deepseek' };

export function runtimeBrand(agent: string): Brand | undefined {
	return runtimes[agent];
}

export function modelBrand(model: string | undefined, agent: string): Brand | undefined {
	const name = (model || defaults[agent] || '').toLowerCase();
	return families.find(([pattern]) => pattern.test(name))?.[1];
}

export function BrandIcon({ brand, size = 16 }: { brand: Brand; size?: number }) {
	return (
		<span
			className="brand-icon"
			role="img"
			aria-label={brand.name}
			title={brand.name}
			style={{ fontSize: size }}
			dangerouslySetInnerHTML={{ __html: brand.svg }}
		/>
	);
}
