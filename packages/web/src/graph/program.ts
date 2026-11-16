import { NodeProgram, type ProgramInfo } from 'sigma/rendering';
import type { NodeDisplayData, RenderParams } from 'sigma/types';
import { floatColor } from 'sigma/utils';

/**
 * One node program for every kind: the fragment shader draws a signed-distance shape (circle,
 * square, rounded square, diamond, hexagon) with an optional inner ring, soft shading and a halo.
 * Kind is always doubled with shape, so this is the only node program Spider needs.
 *
 * Geometry: one triangle per node whose incircle has twice the node radius, so every shape fits.
 * Extra display-data attributes read here: `shape` (number), `ringColor` (hex), `ringWidth` (px).
 */

const VERTEX = /* glsl */ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec4 a_ringColor;
attribute vec2 a_position;
attribute float a_size;
attribute float a_shape;
attribute float a_ring;
attribute float a_angle;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;

varying vec4 v_color;
varying vec4 v_ringColor;
varying vec2 v_diff;
varying float v_radius;
varying float v_shape;
varying float v_ring;

const float bias = 255.0 / 254.0;

void main() {
  float size = a_size * u_correctionRatio / u_sizeRatio * 4.0;
  vec2 diff = 2.0 * size * vec2(cos(a_angle), sin(a_angle));
  gl_Position = vec4((u_matrix * vec3(a_position + diff, 1)).xy, 0, 1);
  v_diff = diff;
  v_radius = size / 2.0;
  v_shape = a_shape;
  v_ring = a_ring;
  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  #endif
  v_color.a *= bias;
  v_ringColor = a_ringColor;
  v_ringColor.a *= bias;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

varying vec4 v_color;
varying vec4 v_ringColor;
varying vec2 v_diff;
varying float v_radius;
varying float v_shape;
varying float v_ring;

uniform float u_correctionRatio;
uniform float u_glow;

float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float sdHexagon(vec2 p, float r) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p.yx);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

void main(void) {
  vec2 p = v_diff / v_radius;
  float d;
  if (v_shape < 0.5) d = length(p) - 1.0;
  else if (v_shape < 1.5) d = sdBox(p, vec2(0.86), 0.1);
  else if (v_shape < 2.5) d = sdBox(p, vec2(0.86), 0.32);
  else if (v_shape < 3.5) d = (abs(p.x) + abs(p.y) - 1.22) * 0.70710678;
  else d = sdHexagon(p, 0.92);

  // one screen pixel in normalised shape units
  float px = u_correctionRatio * 2.0 / v_radius;

  #ifdef PICKING_MODE
  gl_FragColor = d > 0.0 ? vec4(0.0) : v_color;
  #else
  float alpha = 1.0 - smoothstep(-px * 0.5, px * 0.5, d);
  vec4 c = v_color;
  // soft light from the top-left and a slightly darker rim: depth without gradients on the palette
  float light = clamp(0.5 + 0.35 * (p.y - p.x), 0.0, 1.0);
  c.rgb = mix(c.rgb, vec3(1.0), 0.14 * light * u_glow);
  c.rgb *= 1.0 - 0.16 * smoothstep(-0.22, 0.0, d) * u_glow;
  if (v_ring > 0.0) {
    float inner = smoothstep(-v_ring * px - px * 0.5, -v_ring * px + px * 0.5, d);
    c = mix(c, v_ringColor, inner);
  }
  // halo outside the shape (premultiplied), fading over ~half a radius
  float halo = u_glow * 0.22 * (1.0 - smoothstep(0.0, 0.6, d)) * step(0.0, d);
  vec3 glowColor = v_ring > 1.5 ? v_ringColor.rgb : v_color.rgb;
  gl_FragColor = vec4(c.rgb * alpha + glowColor * halo * (1.0 - alpha), alpha + halo * (1.0 - alpha));
  #endif
}
`;

const { UNSIGNED_BYTE, FLOAT } = WebGLRenderingContext;
const UNIFORMS = ['u_sizeRatio', 'u_correctionRatio', 'u_matrix', 'u_glow'] as const;

/** Node effects (halo, shading); GraphCanvas turns them off on big maps, where they cost fill rate. */
export const nodeFx = { glow: 1 };

export class NodeShapeProgram extends NodeProgram<(typeof UNIFORMS)[number]> {
  getDefinition() {
    return {
      VERTICES: 3,
      VERTEX_SHADER_SOURCE: VERTEX,
      FRAGMENT_SHADER_SOURCE: FRAGMENT,
      METHOD: WebGLRenderingContext.TRIANGLES,
      UNIFORMS,
      ATTRIBUTES: [
        { name: 'a_position', size: 2, type: FLOAT },
        { name: 'a_size', size: 1, type: FLOAT },
        { name: 'a_color', size: 4, type: UNSIGNED_BYTE, normalized: true },
        { name: 'a_ringColor', size: 4, type: UNSIGNED_BYTE, normalized: true },
        { name: 'a_shape', size: 1, type: FLOAT },
        { name: 'a_ring', size: 1, type: FLOAT },
        { name: 'a_id', size: 4, type: UNSIGNED_BYTE, normalized: true },
      ],
      CONSTANT_ATTRIBUTES: [{ name: 'a_angle', size: 1, type: FLOAT }],
      CONSTANT_DATA: [[0], [(2 * Math.PI) / 3], [(4 * Math.PI) / 3]],
    };
  }

  processVisibleItem(nodeIndex: number, startIndex: number, data: NodeDisplayData) {
    const a = this.array;
    const d = data as NodeDisplayData & { shape?: number; ringColor?: string; ringWidth?: number };
    let i = startIndex;
    a[i++] = d.x;
    a[i++] = d.y;
    a[i++] = d.size;
    a[i++] = floatColor(d.color);
    a[i++] = floatColor(d.ringColor ?? d.color);
    a[i++] = d.shape ?? 0;
    a[i++] = d.ringColor ? (d.ringWidth ?? 1) : 0;
    a[i++] = nodeIndex;
  }

  setUniforms(params: RenderParams, { gl, uniformLocations }: ProgramInfo) {
    gl.uniform1f(uniformLocations.u_correctionRatio, params.correctionRatio);
    gl.uniform1f(uniformLocations.u_sizeRatio, params.sizeRatio);
    gl.uniformMatrix3fv(uniformLocations.u_matrix, false, params.matrix);
    gl.uniform1f(uniformLocations.u_glow, nodeFx.glow);
  }
}
