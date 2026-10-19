/// <reference types="@webgpu/types" />
import type { Scene } from './scene';
import { framing, right, up } from './scene';

const shader = /* wgsl */ `
struct U { right: vec4f, up: vec4f, scale: vec4f, misc: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> paths: array<vec4f>;

struct VOut { @builtin(position) pos: vec4f, @location(0) color: vec4f, @location(1) uv: vec2f };

fn project(p: vec3f) -> vec2f {
	return vec2f(dot(p, u.right.xyz) * u.scale.x + u.scale.z, dot(p, u.up.xyz) * u.scale.y + u.scale.w);
}

@vertex fn vs_geo(@location(0) p: vec3f, @location(1) c: vec4f, @location(2) phase: f32) -> VOut {
	var a = c.a;
	if (phase >= 0.0) { a = a * (0.6 + 0.4 * sin(u.misc.x * 1.7 + phase * 1.3)); }
	a = a * (1.0 - smoothstep(7.0, 12.0, length(p.xz)));
	var o: VOut;
	o.pos = vec4f(project(p), 0.5, 1.0);
	o.color = vec4f(c.rgb * a, a);
	o.uv = vec2f(0.0);
	return o;
}

@fragment fn fs_geo(i: VOut) -> @location(0) vec4f { return i.color; }

@vertex fn vs_particle(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) c: vec4f) -> VOut {
	var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
	let base = u32(a.x) * 4u;
	let total = paths[base + 3u].w;
	let t = fract(a.y + u.misc.x * a.z / total);
	let d = t * total;
	var p = paths[base].xyz;
	for (var k = 1u; k < 4u; k = k + 1u) {
		let prev = paths[base + k - 1u];
		let cur = paths[base + k];
		if (d >= prev.w && d <= cur.w) {
			p = mix(prev.xyz, cur.xyz, (d - prev.w) / max(cur.w - prev.w, 0.0001));
		}
	}
	let fade = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.94, 1.0, t));
	let corner = corners[vi];
	var o: VOut;
	o.pos = vec4f(project(p) + corner * a.w * u.misc.yz, 0.5, 1.0);
	o.color = vec4f(c.rgb, c.a * fade);
	o.uv = corner;
	return o;
}

@fragment fn fs_particle(i: VOut) -> @location(0) vec4f {
	let r = length(i.uv);
	let a = i.color.a * pow(max(0.0, 1.0 - r), 2.2);
	return vec4f(i.color.rgb * a, a);
}
`;

export type Renderer = { resize: (width: number, height: number, ratio: number) => void; draw: (time: number) => void; destroy: () => void };

// Additive blending without depth: every layer stays see-through.
const additive: GPUBlendState = {
	color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
	alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

export async function createRenderer(canvas: HTMLCanvasElement, scene: Scene): Promise<Renderer | undefined> {
	if (!('gpu' in navigator)) return undefined;
	const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' }).catch(() => null);
	if (!adapter) return undefined;
	const device = await adapter.requestDevice().catch(() => null);
	if (!device) return undefined;
	const context = canvas.getContext('webgpu');
	if (!context) { device.destroy(); return undefined; }
	const format = navigator.gpu.getPreferredCanvasFormat();
	context.configure({ device, format, alphaMode: 'premultiplied' });

	const buffer = (data: Float32Array, usage: GPUBufferUsageFlags) => {
		const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(b, 0, data);
		return b;
	};
	const lines = buffer(scene.lines, GPUBufferUsage.VERTEX);
	const faces = buffer(scene.faces, GPUBufferUsage.VERTEX);
	const particles = buffer(scene.particles, GPUBufferUsage.VERTEX);
	const paths = buffer(scene.paths, GPUBufferUsage.STORAGE);
	const uniforms = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

	const module = device.createShaderModule({ code: shader });
	const layout = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
		{ binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
	] });
	const bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: { buffer: paths } }] });
	const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
	const sampleCount = 4;
	const geometry: GPUVertexBufferLayout = { arrayStride: 32, attributes: [
		{ shaderLocation: 0, offset: 0, format: 'float32x3' },
		{ shaderLocation: 1, offset: 12, format: 'float32x4' },
		{ shaderLocation: 2, offset: 28, format: 'float32' },
	] };
	const pipeline = (vertex: string, fragment: string, topology: GPUPrimitiveTopology, buffers: GPUVertexBufferLayout[]) => device.createRenderPipeline({
		layout: pipelineLayout,
		vertex: { module, entryPoint: vertex, buffers },
		fragment: { module, entryPoint: fragment, targets: [{ format, blend: additive }] },
		primitive: { topology },
		multisample: { count: sampleCount },
	});
	const linePipeline = pipeline('vs_geo', 'fs_geo', 'line-list', [geometry]);
	const facePipeline = pipeline('vs_geo', 'fs_geo', 'triangle-list', [geometry]);
	const particlePipeline = pipeline('vs_particle', 'fs_particle', 'triangle-list', [{ arrayStride: 32, stepMode: 'instance', attributes: [
		{ shaderLocation: 0, offset: 0, format: 'float32x4' },
		{ shaderLocation: 1, offset: 16, format: 'float32x4' },
	] }]);

	let msaa: GPUTexture | undefined;
	let cssWidth = 1, cssHeight = 1;
	const values = new Float32Array(16);
	values.set([...right, 0], 0);
	values.set([...up, 0], 4);

	return {
		resize(width, height, ratio) {
			cssWidth = Math.max(1, width); cssHeight = Math.max(1, height);
			canvas.width = Math.round(cssWidth * ratio);
			canvas.height = Math.round(cssHeight * ratio);
			msaa?.destroy();
			msaa = device.createTexture({ size: [canvas.width, canvas.height], format, sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT });
		},
		draw(time) {
			if (!msaa) return;
			const frame = framing(cssWidth, cssHeight);
			values.set([2 * frame.unit / cssWidth, 2 * frame.unit / cssHeight, 2 * frame.x / cssWidth - 1, 1 - 2 * frame.y / cssHeight], 8);
			values.set([time, 2 / cssWidth, 2 / cssHeight, 0], 12);
			device.queue.writeBuffer(uniforms, 0, values);
			const encoder = device.createCommandEncoder();
			const pass = encoder.beginRenderPass({ colorAttachments: [{
				view: msaa.createView(),
				resolveTarget: context.getCurrentTexture().createView(),
				clearValue: { r: 0, g: 0, b: 0, a: 0 },
				loadOp: 'clear',
				storeOp: 'discard',
			}] });
			pass.setBindGroup(0, bindGroup);
			pass.setPipeline(facePipeline); pass.setVertexBuffer(0, faces); pass.draw(scene.faces.length / 8);
			pass.setPipeline(linePipeline); pass.setVertexBuffer(0, lines); pass.draw(scene.lines.length / 8);
			pass.setPipeline(particlePipeline); pass.setVertexBuffer(0, particles); pass.draw(6, scene.particles.length / 8);
			pass.end();
			device.queue.submit([encoder.finish()]);
		},
		destroy() { msaa?.destroy(); device.destroy(); },
	};
}
