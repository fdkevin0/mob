/// <reference types="@webgpu/types" />
import type { Voxel } from './model';
import { shade, type Frame } from './project';

// Instanced voxels with depth, drawn small and scaled up with nearest
// neighbour so the result reads as pixel art. Only the three faces the
// camera can see (+x, +y, +z) are generated.

const shader = /* wgsl */ `
struct U { frame: vec4f, size: vec4f, backdrop: vec4f };
@group(0) @binding(0) var<uniform> u: U;

struct VOut { @builtin(position) pos: vec4f, @location(0) color: vec4f, @location(1) uv: vec2f };

fn project(p: vec3f) -> vec4f {
	let sx = u.frame.y + (p.x - p.z) * 0.70710678 * u.frame.x;
	let sy = u.frame.z - (2.0 * p.y - p.x - p.z) * 0.40824829 * u.frame.x;
	let depth = 0.5 - (p.x + p.y + p.z) / 1200.0;
	return vec4f(sx / u.size.x * 2.0 - 1.0, 1.0 - sy / u.size.y * 2.0, depth, 1.0);
}

@vertex fn vs_voxel(@builtin(vertex_index) vi: u32, @location(0) at: vec3f, @location(1) rgb: vec3f, @location(2) extra: vec2f, @location(3) fade: f32) -> VOut {
	var quads = array<vec3f, 12>(
		vec3f(0.0, 1.0, 0.0), vec3f(1.0, 1.0, 0.0), vec3f(1.0, 1.0, 1.0), vec3f(0.0, 1.0, 1.0),
		vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 1.0), vec3f(1.0, 1.0, 1.0), vec3f(0.0, 1.0, 1.0),
		vec3f(1.0, 0.0, 0.0), vec3f(1.0, 0.0, 1.0), vec3f(1.0, 1.0, 1.0), vec3f(1.0, 1.0, 0.0));
	var order = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
	let face = vi / 6u;
	let corner = quads[face * 4u + order[vi % 6u]];
	let size = extra.y;
	let p = at + vec3f(0.5) + (corner - vec3f(0.5)) * size;
	var k = ${shade.top.toFixed(2)};
	if (face == 1u) { k = ${shade.left.toFixed(2)}; }
	if (face == 2u) { k = ${shade.right.toFixed(2)}; }
	let g = extra.x;
	var o: VOut;
	o.pos = project(p);
	// Faded after lighting, as project.ts does, so a fully faded voxel is the backdrop.
	o.color = vec4f(mix(u.backdrop.rgb, min(rgb * (k + (1.0 - k) * g * 0.7) + vec3f(g * 0.12), vec3f(1.0)), fade), 1.0);
	o.uv = vec2f(0.0);
	return o;
}

@fragment fn fs_voxel(i: VOut) -> @location(0) vec4f { return i.color; }

@vertex fn vs_glow(@builtin(vertex_index) vi: u32, @location(0) at: vec3f, @location(1) rgb: vec3f, @location(2) extra: vec2f) -> VOut {
	var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
	let c = corners[vi];
	let center = project(at + vec3f(0.5));
	let radius = extra.y * u.frame.x * 1.6;
	var o: VOut;
	o.pos = vec4f(center.xy + c * radius / u.size.xy * 2.0, center.z + 0.002, 1.0);
	// Blocks that do not glow collapse to nothing.
	if (extra.x < 0.6) { o.pos = vec4f(0.0, 0.0, 2.0, 1.0); }
	o.color = vec4f(rgb, extra.x * 0.45);
	o.uv = c;
	return o;
}

@fragment fn fs_glow(i: VOut) -> @location(0) vec4f {
	let r = length(i.uv);
	// Stepped falloff keeps the halo blocky, like the voxels.
	let a = i.color.a * floor(max(0.0, 1.0 - r) * 4.0) / 4.0;
	return vec4f(i.color.rgb * a, a);
}
`;

export type VoxelRenderer = { resize: (width: number, height: number) => void; draw: (voxels: Voxel[], frame: Frame) => void; destroy: () => void };

export async function createVoxelRenderer(canvas: HTMLCanvasElement): Promise<VoxelRenderer | undefined> {
	if (!('gpu' in navigator)) return undefined;
	const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' }).catch(() => null);
	const device = await adapter?.requestDevice().catch(() => null);
	if (!device) return undefined;
	const context = canvas.getContext('webgpu');
	if (!context) { device.destroy(); return undefined; }
	const format = navigator.gpu.getPreferredCanvasFormat();
	context.configure({ device, format, alphaMode: 'premultiplied' });

	const module = device.createShaderModule({ code: shader });
	const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
	const uniforms = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniforms } }] });
	const instance: GPUVertexBufferLayout = { arrayStride: 36, stepMode: 'instance', attributes: [
		{ shaderLocation: 0, offset: 0, format: 'float32x3' },
		{ shaderLocation: 1, offset: 12, format: 'float32x3' },
		{ shaderLocation: 2, offset: 24, format: 'float32x2' },
		{ shaderLocation: 3, offset: 32, format: 'float32' },
	] };
	const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
	const voxelPipeline = device.createRenderPipeline({
		layout: pipelineLayout,
		vertex: { module, entryPoint: 'vs_voxel', buffers: [instance] },
		fragment: { module, entryPoint: 'fs_voxel', targets: [{ format }] },
		primitive: { topology: 'triangle-list' },
		depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
	});
	const glowPipeline = device.createRenderPipeline({
		layout: pipelineLayout,
		vertex: { module, entryPoint: 'vs_glow', buffers: [instance] },
		fragment: { module, entryPoint: 'fs_glow', targets: [{ format, blend: {
			color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
			alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
		} }] },
		primitive: { topology: 'triangle-list' },
		depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
	});

	let capacity = 0;
	let buffer: GPUBuffer | undefined;
	let depth: GPUTexture | undefined;
	let data = new Float32Array(0);

	return {
		resize(width, height) {
			canvas.width = Math.max(1, width);
			canvas.height = Math.max(1, height);
			depth?.destroy();
			depth = device.createTexture({ size: [canvas.width, canvas.height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
		},
		draw(voxels, frame) {
			if (!depth) return;
			if (voxels.length > capacity) {
				buffer?.destroy();
				capacity = Math.ceil(voxels.length * 1.5);
				buffer = device.createBuffer({ size: capacity * 36, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
				data = new Float32Array(capacity * 9);
			}
			voxels.forEach((v, i) => { for (let j = 0; j < 8; j++) data[i * 9 + j] = v[j]!; data[i * 9 + 8] = v[8] ?? 1; });
			device.queue.writeBuffer(buffer!, 0, data, 0, voxels.length * 9);
			const [r, g, b] = frame.backdrop ?? [0, 0, 0];
			device.queue.writeBuffer(uniforms, 0, new Float32Array([frame.unit, frame.x, frame.y, 0, canvas.width, canvas.height, 0, 0, r, g, b, 0]));
			const encoder = device.createCommandEncoder();
			const pass = encoder.beginRenderPass({
				colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
				depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
			});
			pass.setBindGroup(0, bindGroup);
			pass.setVertexBuffer(0, buffer!);
			pass.setPipeline(voxelPipeline); pass.draw(18, voxels.length);
			pass.setPipeline(glowPipeline); pass.draw(6, voxels.length);
			pass.end();
			device.queue.submit([encoder.finish()]);
		},
		destroy() { buffer?.destroy(); depth?.destroy(); device.destroy(); },
	};
}
