import type { CSSProperties, ReactNode } from 'react';
import { icons, type IconName } from './pixels';
import { Calf } from './Logo';

// Small looping scenes, one per feature, so the page shows rather than tells.

function Pixels({ name, x, y, size = 3, className }: { name: IconName; x: number; y: number; size?: number; className?: string }) {
	return (
		<g className={className} transform={`translate(${x} ${y})`}>
			{icons[name].flatMap((row, iy) => [...row].map((c, ix) => c === '#' ? <rect key={`${ix}.${iy}`} x={ix * size} y={iy * size} width={size - 0.6} height={size - 0.6} /> : null))}
		</g>
	);
}

const vars = (values: Record<string, string | number>) => values as CSSProperties;

function Home() {
	return (
		<svg viewBox="0 0 200 120">
			<rect className="fx-boundary" x="30" y="14" width="140" height="92" />
			<Pixels name="memory" x={89} y={49} className="fx-lime" />
			<g className="fx-orbit">
				{[0, 1, 2, 3].map(i => <rect key={i} className="fx-dot" x={-2} y={-32} width="4" height="4" transform={`rotate(${i * 90})`} />)}
			</g>
			<rect className="fx-escape" x="98" y="58" width="4" height="4" />
		</svg>
	);
}

function Channels() {
	const sources: IconName[] = ['browser', 'terminal', 'send', 'message'];
	return (
		<svg viewBox="0 0 200 120">
			{sources.map((name, i) => {
				const y = 10 + i * 27;
				return (
					<g key={name}>
						<Pixels name={name} x={22} y={y} size={2.6} className="fx-muted" />
						<line className="fx-wire" x1="44" y1={y + 9} x2="142" y2="60" />
						<rect className="fx-packet" x="42" y={y + 7} width="4" height="4" style={vars({ '--dx': '100px', '--dy': `${51 - y}px`, animationDelay: `${i * 0.45}s` })} />
					</g>
				);
			})}
			<g transform="translate(144 44)"><Calf size={36} /></g>
		</svg>
	);
}

function Approval() {
	return (
		<svg viewBox="0 0 200 120">
			<line className="fx-wire" x1="20" y1="60" x2="180" y2="60" />
			<rect className="fx-gate" x="97" y="34" width="6" height="52" />
			<rect className="fx-request" x="20" y="56" width="8" height="8" />
			<Pixels name="shield" x={89} y={8} size={3} className="fx-gate-icon" />
		</svg>
	);
}

function Sandbox() {
	const balls = [[0, 0, 1.7, 2.3], [1, 0.4, 2.1, 1.6], [0.5, 1, 1.4, 2.7], [0.2, 0.7, 2.6, 1.9], [0.8, 0.2, 1.9, 2.2]];
	return (
		<svg viewBox="0 0 200 120">
			<rect className="fx-box" x="50" y="18" width="100" height="84" />
			{balls.map(([dx, dy, tx, ty], i) => (
				<g key={i} className="fx-bounce-x" style={vars({ animationDuration: `${tx}s`, animationDelay: `-${dx * tx}s` })}>
					<rect className={i % 2 ? 'fx-ball amber' : 'fx-ball'} x="54" y="22" width="6" height="6" style={vars({ animationDuration: `${ty}s`, animationDelay: `-${dy * ty}s` })} />
				</g>
			))}
		</svg>
	);
}

function Memory() {
	const rows = [70, 46, 82, 58, 34];
	return (
		<svg viewBox="0 0 200 120">
			{rows.map((width, i) => (
				<rect key={i} className="fx-fact" x="40" y={18 + i * 18} width={width * 1.4} height="9" style={vars({ animationDelay: `${i * 0.5}s` })} />
			))}
		</svg>
	);
}

function Plugins() {
	const slots = [[40, 24], [138, 24], [40, 78], [138, 78]];
	return (
		<svg viewBox="0 0 200 120">
			<rect className="fx-hub" x="82" y="42" width="36" height="36" />
			{slots.map(([x, y], i) => (
				<g key={i}>
					<line className="fx-wire" x1={x + 11} y1={y + 9} x2="100" y2="60" />
					<rect className="fx-socket" x={x} y={y} width="22" height="18" />
					<rect className="fx-module" x={x + 3} y={y + 3} width="16" height="12" style={vars({ animationDelay: `${i * 0.6}s`, '--from': `${(x < 100 ? -1 : 1) * 24}px` })} />
				</g>
			))}
		</svg>
	);
}

const features: { title: string; hint: string; scene: ReactNode }[] = [
	{ title: 'Runs at home', hint: 'Your machine, your keys.', scene: <Home /> },
	{ title: 'Every channel', hint: 'Web, terminal, Telegram, email.', scene: <Channels /> },
	{ title: 'Asks first', hint: 'Effects wait for you.', scene: <Approval /> },
	{ title: 'Sandboxed', hint: 'Tools run in a container.', scene: <Sandbox /> },
	{ title: 'Remembers', hint: 'Keeps what matters.', scene: <Memory /> },
	{ title: 'Plugs in', hint: 'MCP servers and skills.', scene: <Plugins /> },
];

export function Features() {
	return (
		<div className="feature-grid">
			{features.map(feature => (
				<article key={feature.title} className="feature">
					<div className="feature-scene" aria-hidden="true">{feature.scene}</div>
					<h3>{feature.title}</h3>
					<p>{feature.hint}</p>
				</article>
			))}
		</div>
	);
}
