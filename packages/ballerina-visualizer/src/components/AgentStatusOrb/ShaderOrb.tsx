/**
 * Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import React, { useEffect, useRef } from "react";

/**
 * Siri-style orb rendered with a WebGL fragment shader: domain-warped fbm
 * noise color fields inside a circular mask. State changes are conveyed by
 * lerping color/energy uniforms each frame, so transitions crossfade
 * continuously instead of snapping.
 *
 * - `energy` scales flow speed and contrast (idle ≈ calm, running ≈ lively).
 * - Honors `prefers-reduced-motion`: renders a single static frame instead
 *   of animating.
 * - Calls `onContextFailed` if a WebGL context can't be created so the parent
 *   can fall back to the CSS orb.
 */

interface ShaderOrbProps {
    colors: [string, string, string];
    energy: number;
    size: number;
    onContextFailed: () => void;
}

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
    const value = parseInt(hex.slice(1), 16);
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    v_uv = a_pos;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 v_uv;
uniform float u_time;
uniform float u_energy;
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
        f.y
    );
}

float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
        v += a * noise(p);
        p *= 2.02;
        a *= 0.5;
    }
    return v;
}

void main() {
    vec2 uv = v_uv;
    float r = length(uv);
    float t = u_time * (0.15 + 0.5 * u_energy);

    // Domain warp drives the wisps' motion.
    vec2 q = vec2(
        fbm(uv * 1.8 + vec2(t * 0.6, -t * 0.4)),
        fbm(uv * 1.8 + vec2(-t * 0.5, t * 0.7))
    );

    // Siri look: dark glass sphere with colors concentrated into thin
    // ridged filaments (wisps) rather than filling the whole volume.
    float n1 = fbm(uv * 2.6 + 2.2 * q + vec2(t * 0.35, -t * 0.25));
    float wisp1 = pow(1.0 - abs(2.0 * n1 - 1.0), 4.0);
    float n2 = fbm(uv * 3.4 - 1.8 * q + vec2(-t * 0.28, t * 0.4));
    float wisp2 = pow(1.0 - abs(2.0 * n2 - 1.0), 5.0);

    // Near-black glass base with a faint depth tint toward the center.
    vec3 col = vec3(0.02, 0.02, 0.045) + 0.10 * mix(u_c0, u_c2, 0.5) * (1.0 - r);

    // Wisps biased toward the surface (rim) like refracted ribbons.
    float rimBias = 0.35 + 0.65 * smoothstep(0.15, 0.95, r);
    col += u_c0 * wisp1 * rimBias * (0.55 + 0.45 * u_energy);
    col += u_c1 * wisp2 * rimBias * (0.5 + 0.5 * u_energy);
    col += u_c2 * wisp1 * wisp2 * 1.2;

    // Iridescent rim: hue varies around the circumference and drifts.
    float ang = atan(uv.y, uv.x);
    vec3 iri = mix(u_c0, u_c1, 0.5 + 0.5 * sin(ang * 2.0 + t * 1.5));
    iri = mix(iri, u_c2, 0.5 + 0.5 * sin(ang * 3.0 - t));
    float rim = smoothstep(0.72, 0.98, r);
    col += iri * rim * 0.5;

    // Specular flare — the bright core hotspot — plus a sharp glint.
    vec2 flarePos = vec2(-0.25, 0.18);
    float flare = pow(max(0.0, 1.0 - length(uv - flarePos) * 1.6), 6.0);
    col += vec3(0.85, 1.0, 0.92) * flare * (0.8 + 0.6 * u_energy);
    float glint = pow(max(0.0, 1.0 - length(uv - flarePos) * 4.0), 3.0);
    col += vec3(1.0) * glint;

    col *= 0.9 + 0.15 * (1.0 - r);
    float mask = smoothstep(1.0, 0.94, r);
    gl_FragColor = vec4(col * mask, mask);
}
`;

function compileProgram(gl: WebGLRenderingContext): WebGLProgram | null {
    const compile = (type: number, source: string): WebGLShader | null => {
        const shader = gl.createShader(type);
        if (!shader) {
            return null;
        }
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error("[AgentStatusOrb] shader compile failed:", gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertex || !fragment) {
        return null;
    }
    const program = gl.createProgram();
    if (!program) {
        return null;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("[AgentStatusOrb] program link failed:", gl.getProgramInfoLog(program));
        return null;
    }
    return program;
}

const LERP_RATE = 4.0;

export function ShaderOrb({ colors, energy, size, onContextFailed }: ShaderOrbProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    /** Target uniform values; the render loop eases toward these. */
    const targetRef = useRef<{ colors: [Rgb, Rgb, Rgb]; energy: number }>({
        colors: [hexToRgb(colors[0]), hexToRgb(colors[1]), hexToRgb(colors[2])],
        energy,
    });
    const failedRef = useRef(false);
    /** Repaints one frame when animation is off (prefers-reduced-motion). */
    const staticRepaintRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        targetRef.current = {
            colors: [hexToRgb(colors[0]), hexToRgb(colors[1]), hexToRgb(colors[2])],
            energy,
        };
        staticRepaintRef.current?.();
    }, [colors[0], colors[1], colors[2], energy]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true });
        const program = gl ? compileProgram(gl) : null;
        if (!gl || !program) {
            if (!failedRef.current) {
                failedRef.current = true;
                onContextFailed();
            }
            return;
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = size * dpr;
        canvas.height = size * dpr;
        gl.viewport(0, 0, canvas.width, canvas.height);

        gl.useProgram(program);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const posLocation = gl.getAttribLocation(program, "a_pos");
        gl.enableVertexAttribArray(posLocation);
        gl.vertexAttribPointer(posLocation, 2, gl.FLOAT, false, 0, 0);

        const uTime = gl.getUniformLocation(program, "u_time");
        const uEnergy = gl.getUniformLocation(program, "u_energy");
        const uColors = [
            gl.getUniformLocation(program, "u_c0"),
            gl.getUniformLocation(program, "u_c1"),
            gl.getUniformLocation(program, "u_c2"),
        ];

        gl.clearColor(0, 0, 0, 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        const current = {
            colors: targetRef.current.colors.map((c) => [...c] as Rgb) as [Rgb, Rgb, Rgb],
            energy: targetRef.current.energy,
        };

        const draw = (timeSeconds: number) => {
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.uniform1f(uTime, timeSeconds);
            gl.uniform1f(uEnergy, current.energy);
            current.colors.forEach((c, i) => gl.uniform3f(uColors[i], c[0], c[1], c[2]));
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        };

        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        let rafId = 0;
        let lastMs = performance.now();
        const startMs = lastMs;

        const tick = (nowMs: number) => {
            const dt = Math.min((nowMs - lastMs) / 1000, 0.1);
            lastMs = nowMs;
            // Ease uniforms toward their targets for continuous crossfades.
            const k = 1 - Math.exp(-LERP_RATE * dt);
            const target = targetRef.current;
            current.energy += (target.energy - current.energy) * k;
            for (let i = 0; i < 3; i++) {
                for (let ch = 0; ch < 3; ch++) {
                    current.colors[i][ch] += (target.colors[i][ch] - current.colors[i][ch]) * k;
                }
            }
            draw((nowMs - startMs) / 1000);
            rafId = requestAnimationFrame(tick);
        };

        const renderStatic = () => {
            const target = targetRef.current;
            current.energy = target.energy;
            current.colors = target.colors.map((c) => [...c] as Rgb) as [Rgb, Rgb, Rgb];
            draw(1.7);
        };

        const applyMotionPreference = () => {
            cancelAnimationFrame(rafId);
            if (reducedMotion.matches) {
                renderStatic();
            } else {
                lastMs = performance.now();
                rafId = requestAnimationFrame(tick);
            }
        };

        applyMotionPreference();
        reducedMotion.addEventListener("change", applyMotionPreference);
        staticRepaintRef.current = () => {
            if (reducedMotion.matches) {
                renderStatic();
            }
        };

        return () => {
            cancelAnimationFrame(rafId);
            reducedMotion.removeEventListener("change", applyMotionPreference);
            staticRepaintRef.current = null;
            gl.getExtension("WEBGL_lose_context")?.loseContext();
        };
    }, [size, onContextFailed]);

    return (
        <canvas
            ref={canvasRef}
            style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                borderRadius: "50%",
                pointerEvents: "none",
            }}
        />
    );
}
