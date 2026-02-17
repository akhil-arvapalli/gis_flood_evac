'use client';

import { useRef, useMemo, useEffect, useState } from 'react';
import * as THREE from 'three';

export type { ViewMode };

export interface FloodTerrainViewProps {
    floodLevel: number;
    aoiCoordinates?: number[][] | null;
    waterSources: number[][];
    showMesh: boolean;
    showEvacRoutes: boolean;
    showBuildings: boolean;
    geoData?: GeoData | null;
    viewMode?: ViewMode;
    interactionMode?: 'view' | 'block';
    blockedAreas: { x: number, z: number, r: number }[];
    setBlockedAreas: (areas: { x: number, z: number, r: number }[]) => void;
}

type GeoData = any; // Keep your existing type
type ViewMode = 'perspective' | 'oblique' | 'top' | 'free';

/* ================================================================
   NOISE
   ================================================================ */
function hash(x: number, y: number): number {
    let h = ((x * 374761393 + y * 668265263) | 0);
    h = ((h ^ (h >> 13)) * 1274126177) | 0;
    return (h & 0x7fffffff) / 0x7fffffff;
}

function smoothNoise(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const n00 = hash(ix, iy), n10 = hash(ix + 1, iy);
    const n01 = hash(ix, iy + 1), n11 = hash(ix + 1, iy + 1);
    return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
}

function fbm(x: number, y: number, oct: number): number {
    let v = 0, a = 1, f = 1, m = 0;
    for (let i = 0; i < oct; i++) {
        v += smoothNoise(x * f, y * f) * a;
        m += a;
        a *= 0.5;
        f *= 2;
    }
    return v / m;
}

function seededRng(s: number) {
    let st = Math.abs(s) || 1;
    return () => {
        st = (st * 16807 + 0) % 2147483647;
        return (st - 1) / 2147483646;
    };
}

/* ================================================================
   BILINEAR
   ================================================================ */
function bilinearInterp(grid: number[][], rows: number, cols: number, nx: number, ny: number): number {
    const gx = Math.min(Math.max(nx, 0), 0.9999) * (cols - 1);
    const gy = Math.min(Math.max(ny, 0), 0.9999) * (rows - 1);
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const fx = gx - ix, fy = gy - iy;
    const ix1 = Math.min(ix + 1, cols - 1), iy1 = Math.min(iy + 1, rows - 1);
    return grid[iy][ix] * (1 - fx) * (1 - fy) + grid[iy][ix1] * fx * (1 - fy) + grid[iy1][ix] * (1 - fx) * fy + grid[iy1][ix1] * fx * fy;
}

/* ================================================================
   CONSTANTS
   ================================================================ */
const SIZE = 80;
const SEGS = 180;
const MAX_H = 25;

/* ================================================================
   TERRAIN GENERATION — PROCEDURAL
   ================================================================ */
function generateTerrainProcedural(aoiCoordinates?: number[][] | null): {
    geometry: THREE.PlaneGeometry;
    heights: number[];
    maxH: number;
    minH: number;
} {
    const geom = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
    const pos = geom.attributes.position;
    const cols = SEGS + 1;
    const heights: number[] = new Array(pos.count).fill(0);
    const seed = aoiCoordinates ? Math.abs(Math.floor(aoiCoordinates.flat().reduce((a, b) => a + b * 10000, 0))) : 42;
    const ox = (seed % 1000) / 100, oy = ((seed >> 10) % 1000) / 100;
    let maxHt = -Infinity, minHt = Infinity;

    for (let i = 0; i < pos.count; i++) {
        const gx = pos.getX(i), gy = pos.getY(i);
        const nx = gx / SIZE, ny = gy / SIZE;
        let h = fbm(nx * 3 + ox, ny * 3 + oy, 6) * MAX_H;
        const riverDist = Math.abs(gy / SIZE + Math.sin(gx / SIZE * 4) * 0.12);
        h *= Math.min(1, riverDist * 5 + 0.15);
        pos.setZ(i, h);
        heights[i] = h;
        if (h > maxHt) maxHt = h;
        if (h < minHt) minHt = h;
    }
    pos.needsUpdate = true;

    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
        const h = heights[i];
        const t = maxHt > minHt ? (h - minHt) / (maxHt - minHt) : 0;
        let r: number, g: number, b: number;
        if (t < 0.15) {
            r = 0.22 + t * 0.8;
            g = 0.30 + t * 1.2;
            b = 0.12;
        } else if (t < 0.45) {
            const tt = (t - 0.15) / 0.3;
            r = 0.34 + tt * 0.15;
            g = 0.48 + tt * 0.1;
            b = 0.15 + tt * 0.05;
        } else if (t < 0.7) {
            const tt = (t - 0.45) / 0.25;
            r = 0.49 + tt * 0.2;
            g = 0.42 + tt * 0.05;
            b = 0.20 + tt * 0.1;
        } else {
            const tt = (t - 0.7) / 0.3;
            r = 0.6 + tt * 0.2;
            g = 0.55 + tt * 0.2;
            b = 0.45 + tt * 0.25;
        }
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
    }
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.computeVertexNormals();
    return { geometry: geom, heights, maxH: maxHt, minH: minHt };
}

/* ================================================================
   TERRAIN GENERATION — FROM REAL ELEVATION DATA
   ================================================================ */
function generateTerrainFromReal(
    elevation: any,
    aoiCoordinates?: number[][] | null,
): {
    geometry: THREE.PlaneGeometry;
    heights: number[];
    maxH: number;
    minH: number
} {
    const geom = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
    const pos = geom.attributes.position;
    const heights: number[] = new Array(pos.count).fill(0);
    const eGrid = elevation.grid;
    const eRows = eGrid.length;
    const eCols = eGrid[0]?.length ?? 1;
    const elevRange = Math.max(elevation.max - elevation.min, 0.5);
    let maxHt = -Infinity, minHt = Infinity;

    for (let i = 0; i < pos.count; i++) {
        const gx = pos.getX(i), gy = pos.getY(i);
        const nx = (gx + SIZE / 2) / SIZE;
        const ny = (gy + SIZE / 2) / SIZE;
        const rawElev = bilinearInterp(eGrid, eRows, eCols, nx, 1 - ny);
        const h = ((rawElev - elevation.min) / elevRange) * MAX_H;
        pos.setZ(i, h);
        heights[i] = h;
        if (h > maxHt) maxHt = h;
        if (h < minHt) minHt = h;
    }
    pos.needsUpdate = true;

    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
        const h = heights[i];
        const t = maxHt > minHt ? (h - minHt) / (maxHt - minHt) : 0;
        let r: number, g: number, b: number;
        if (t < 0.15) {
            r = 0.22 + t * 0.8;
            g = 0.30 + t * 1.2;
            b = 0.12;
        } else if (t < 0.45) {
            const tt = (t - 0.15) / 0.3;
            r = 0.34 + tt * 0.15;
            g = 0.48 + tt * 0.1;
            b = 0.15 + tt * 0.05;
        } else if (t < 0.7) {
            const tt = (t - 0.45) / 0.25;
            r = 0.49 + tt * 0.2;
            g = 0.42 + tt * 0.05;
            b = 0.20 + tt * 0.1;
        } else {
            const tt = (t - 0.7) / 0.3;
            r = 0.6 + tt * 0.2;
            g = 0.55 + tt * 0.2;
            b = 0.45 + tt * 0.25;
        }
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
    }
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.computeVertexNormals();
    return { geometry: geom, heights, maxH: maxHt, minH: minHt };
}

/* ================================================================
   TERRAIN SIDES (skirt)
   ================================================================ */
function buildSides(terrainGeom: THREE.PlaneGeometry): THREE.BufferGeometry {
    const pos = terrainGeom.attributes.position;
    const cols = SEGS + 1;
    const baseY = -1;
    const verts: number[] = [];
    const indices: number[] = [];

    const edges: { idx: number; gx: number; gy: number; }[] = [];
    for (let c = 0; c < cols; c++) {
        edges.push({ idx: c, gx: pos.getX(c), gy: pos.getY(c) });
    }
    for (let c = 0; c < cols; c++) {
        const i = SEGS * cols + c;
        edges.push({ idx: i, gx: pos.getX(i), gy: pos.getY(i) });
    }
    for (let r = 0; r < cols; r++) {
        edges.push({ idx: r * cols, gx: pos.getX(r * cols), gy: pos.getY(r * cols) });
    }
    for (let r = 0; r < cols; r++) {
        const i = r * cols + SEGS;
        edges.push({ idx: i, gx: pos.getX(i), gy: pos.getY(i) });
    }

    function addStrip(strip: { idx: number; gx: number; gy: number }[]) {
        for (let i = 0; i < strip.length - 1; i++) {
            const a = strip[i], b = strip[i + 1];
            const vi = verts.length / 3;
            verts.push(a.gx, a.gy, pos.getZ(a.idx));
            verts.push(b.gx, b.gy, pos.getZ(b.idx));
            verts.push(a.gx, a.gy, baseY);
            verts.push(b.gx, b.gy, baseY);
            indices.push(vi, vi + 1, vi + 2);
            indices.push(vi + 1, vi + 3, vi + 2);
        }
    }

    const topRow: typeof edges = [], bottomRow: typeof edges = [];
    const leftCol: typeof edges = [], rightCol: typeof edges = [];
    for (let c = 0; c < cols; c++) topRow.push(edges[c]);
    for (let c = 0; c < cols; c++) bottomRow.push(edges[cols + c]);
    for (let r = 0; r < cols; r++) leftCol.push(edges[2 * cols + r]);
    for (let r = 0; r < cols; r++) rightCol.push(edges[3 * cols + r]);
    addStrip(topRow);
    addStrip(bottomRow);
    addStrip(leftCol);
    addStrip(rightCol);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
}

/* ================================================================
   TEXT SPRITE
   ================================================================ */
function createTextSprite(text: string, opts: {
    fontSize?: number;
    color?: string;
    bgColor?: string;
    borderColor?: string;
} = {}): THREE.Sprite {
    const { fontSize = 22, color = '#fff', bgColor = 'rgba(15,23,42,0.9)', borderColor = 'rgba(255,255,255,0.18)' } = opts;
    const pad = 10;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `bold ${fontSize}px "Segoe UI",Arial,sans-serif`;
    const tw = ctx.measureText(text).width;
    const cw = tw + pad * 2, ch = fontSize * 1.35 + pad * 2;
    canvas.width = Math.ceil(cw) * 2;
    canvas.height = Math.ceil(ch) * 2;
    ctx.scale(2, 2);
    const rr = 5;
    ctx.beginPath();
    ctx.moveTo(rr, 0);
    ctx.lineTo(cw - rr, 0);
    ctx.quadraticCurveTo(cw, 0, cw, rr);
    ctx.lineTo(cw, ch - rr);
    ctx.quadraticCurveTo(cw, ch, cw - rr, ch);
    ctx.lineTo(rr, ch);
    ctx.quadraticCurveTo(0, ch, 0, ch - rr);
    ctx.lineTo(0, rr);
    ctx.quadraticCurveTo(0, 0, rr, 0);
    ctx.closePath();
    ctx.fillStyle = bgColor;
    ctx.fill();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = `bold ${fontSize}px "Segoe UI",Arial,sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad, ch / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, sizeAttenuation: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(cw / 14, ch / 14, 1);
    return sprite;
}

/* ================================================================
   WATER SURFACE SHADER
   ================================================================ */
const waterVertexShader = `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vDepth;
uniform float uTime;
uniform float uWaterLevel;

void main() {
  vUv = uv;
  vec3 pos = position;
  float wave1 = sin(pos.x * 2.5 + uTime * 0.8) * cos(pos.z * 1.8 - uTime * 0.6) * 0.06;
  float wave2 = sin(pos.x * 4.5 - uTime * 1.2 + pos.z * 3.0) * 0.035;
  float wave3 = cos(pos.z * 6.0 + uTime * 1.5 + pos.x * 2.0) * 0.02;
  float wave4 = sin((pos.x + pos.z) * 8.0 + uTime * 2.5) * 0.012;
  pos.y += wave1 + wave2 + wave3 + wave4;
  float dx = cos(pos.x * 2.5 + uTime * 0.8) * 2.5 * cos(pos.z * 1.8 - uTime * 0.6) * 0.06 + cos(pos.x * 4.5 - uTime * 1.2 + pos.z * 3.0) * 4.5 * 0.035;
  float dz = -sin(pos.z * 1.8 - uTime * 0.6) * 1.8 * sin(pos.x * 2.5 + uTime * 0.8) * 0.06 + -sin(pos.z * 6.0 + uTime * 1.5 + pos.x * 2.0) * 6.0 * 0.02;
  vNormal = normalize(vec3(-dx, 1.0, -dz));
  vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
  vDepth = max(uWaterLevel - vWorldPos.y + wave1 + wave2, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
}
`;

const waterFragmentShader = `
uniform float uWaterLevel;
uniform float uTime;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vDepth;

float hash2D(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash2D(i);
  float b = hash2D(i + vec2(1.0, 0.0));
  float c = hash2D(i + vec2(0.0, 1.0));
  float d = hash2D(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  float depth = max(uWaterLevel - vWorldPos.y, 0.0);
  float depthN = clamp(depth / 8.0, 0.0, 1.0);
  vec3 deepColor = vec3(0.01, 0.06, 0.22);
  vec3 midColor = vec3(0.04, 0.18, 0.42);
  vec3 shallowColor = vec3(0.12, 0.38, 0.58);
  vec3 shoreColor = vec3(0.22, 0.55, 0.72);
  vec3 waterColor;
  if (depthN > 0.5) {
    waterColor = mix(midColor, deepColor, (depthN - 0.5) * 2.0);
  } else if (depthN > 0.15) {
    waterColor = mix(shallowColor, midColor, (depthN - 0.15) / 0.35);
  } else {
    waterColor = mix(shoreColor, shallowColor, depthN / 0.15);
  }
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float fresnel = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 3.0);
  vec3 skyColor = vec3(0.45, 0.65, 0.85);
  waterColor = mix(waterColor, skyColor, fresnel * 0.35);
  vec3 sunDir = normalize(vec3(0.5, 0.7, 0.4));
  vec3 halfVec = normalize(sunDir + viewDir);
  float spec = pow(max(dot(vNormal, halfVec), 0.0), 128.0);
  waterColor += vec3(1.0, 0.95, 0.85) * spec * 0.6;
  float causticScale = 12.0;
  float c1 = noise2D(vWorldPos.xz * causticScale + uTime * vec2(0.3, 0.2));
  float c2 = noise2D(vWorldPos.xz * causticScale * 1.3 - uTime * vec2(0.2, 0.35));
  float caustic = smoothstep(0.3, 0.7, c1) * smoothstep(0.3, 0.7, c2);
  float causticMask = smoothstep(0.0, 0.3, depthN) * (1.0 - smoothstep(0.3, 0.6, depthN));
  waterColor += vec3(0.2, 0.35, 0.45) * caustic * causticMask * 0.5;
  float foamLine = 1.0 - smoothstep(0.0, 0.06, depthN);
  float foamNoise = noise2D(vWorldPos.xz * 20.0 + uTime * 0.5);
  float foam = foamLine * step(0.4, foamNoise);
  waterColor = mix(waterColor, vec3(0.85, 0.92, 0.98), foam * 0.7);
  float ripple = sin(vWorldPos.x * 6.0 + uTime * 1.5) * sin(vWorldPos.z * 5.0 - uTime * 1.0);
  waterColor += vec3(0.06, 0.08, 0.12) * smoothstep(0.4, 1.0, ripple) * (1.0 - depthN);
  float alpha = uOpacity * smoothstep(0.0, 0.08, depthN) * (0.55 + depthN * 0.45);
  gl_FragColor = vec4(waterColor, alpha);
}
`;

const WATER_SEGS = 180;
function createFloodWaterMesh(): {
    mesh: THREE.Mesh;
    uniforms: Record<string, any>
} {
    const geom = new THREE.PlaneGeometry(SIZE, SIZE, WATER_SEGS, WATER_SEGS);
    const uniforms = {
        uWaterLevel: { value: 0.0 },
        uTime: { value: 0.0 },
        uOpacity: { value: 0.88 },
    };
    const mat = new THREE.ShaderMaterial({
        vertexShader: waterVertexShader,
        fragmentShader: waterFragmentShader,
        uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    return { mesh, uniforms };
}

function updateFloodWater(
    waterGeom: THREE.PlaneGeometry,
    terrainHeights: number[],
    waterH: number,
    wsWx: number[],
    wsWz: number[],
    spread: number,
) {
    const pos = waterGeom.attributes.position;
    const tCols = SEGS + 1;
    for (let i = 0; i < pos.count; i++) {
        const gx = pos.getX(i), gy = pos.getY(i);
        const nx = (gx + SIZE / 2) / SIZE;
        const ny = (gy + SIZE / 2) / SIZE;
        const tgxF = nx * SEGS, tgyF = ny * SEGS;
        const tix = Math.floor(Math.min(Math.max(tgxF, 0), SEGS - 1));
        const tiy = Math.floor(Math.min(Math.max(tgyF, 0), SEGS - 1));
        const fx = tgxF - tix, fy = tgyF - tiy;
        const tix1 = Math.min(tix + 1, SEGS), tiy1 = Math.min(tiy + 1, SEGS);
        const h00 = terrainHeights[tiy * tCols + tix] ?? 0;
        const h10 = terrainHeights[tiy * tCols + tix1] ?? 0;
        const h01 = terrainHeights[tiy1 * tCols + tix] ?? 0;
        const h11 = terrainHeights[tiy1 * tCols + tix1] ?? 0;
        const tH = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
        const wx = gx;
        const wz = -gy;
        let minD = Infinity;
        for (let k = 0; k < wsWx.length; k++) {
            const d = Math.hypot(wx - wsWx[k], wz - wsWz[k]);
            if (d < minD) minD = d;
        }
        const edgeFade = 1.0 - Math.max(0, Math.min(1, (minD - spread * 0.9) / (spread * 0.1)));
        const depthBelow = waterH - tH;
        if (depthBelow > 0 && edgeFade > 0.01) {
            const shoreBlend = Math.min(depthBelow / 1.5, 1.0);
            const effectiveH = tH + depthBelow * shoreBlend * edgeFade;
            pos.setZ(i, effectiveH);
        } else {
            pos.setZ(i, -100);
        }
    }
    pos.needsUpdate = true;
    waterGeom.computeVertexNormals();
}

function heightAt(heights: number[], gx: number, gy: number): number {
    const cols = SEGS + 1;
    const fx = (gx + SIZE / 2) / SIZE;
    const fy = (gy + SIZE / 2) / SIZE;
    const ix = Math.min(Math.max(Math.round(fx * SEGS), 0), SEGS);
    const iy = Math.min(Math.max(Math.round(fy * SEGS), 0), SEGS);
    return heights[iy * cols + ix] ?? 0;
}

function heightAtWorld(heights: number[], wx: number, wz: number): number {
    return heightAt(heights, wx, -wz);
}

interface Building {
    wx: number;
    wz: number;
    elev: number;
    kind: 'residential' | 'commercial' | 'hospital' | 'school';
    pop: number;
    name?: string;
    floors?: number;
}

interface SafeZone {
    wx: number;
    wz: number;
    elev: number;
    label: string;
    cap: number
}

function generateBuildingsProcedural(heights: number[], seed: number): Building[] {
    const rng = seededRng(seed);
    const buildings: Building[] = [];
    for (let attempt = 0; attempt < 400 && buildings.length < 80; attempt++) {
        const wx = (rng() - 0.5) * SIZE * 0.88;
        const wz = (rng() - 0.5) * SIZE * 0.88;
        const elev = heightAtWorld(heights, wx, wz);
        const e1 = heightAtWorld(heights, wx + 1, wz);
        const e2 = heightAtWorld(heights, wx, wz + 1);
        const slope = Math.sqrt((e1 - elev) ** 2 + (e2 - elev) ** 2);
        if (slope > 2.5 || elev > MAX_H * 0.65) continue;
        if (buildings.some(b => Math.hypot(b.wx - wx, b.wz - wz) < 3.2)) continue;
        const r = rng();
        let kind: Building['kind'] = 'residential', pop = 20 + Math.floor(rng() * 40);
        if (r > 0.92) {
            kind = 'hospital';
            pop = 150 + Math.floor(rng() * 100);
        } else if (r > 0.85) {
            kind = 'school';
            pop = 80 + Math.floor(rng() * 100);
        } else if (r > 0.60) {
            kind = 'commercial';
            pop = 30 + Math.floor(rng() * 50);
        }
        buildings.push({ wx, wz, elev, kind, pop });
    }
    return buildings;
}

function mapRealBuildings(
    geoBuildings: any[],
    bbox: any,
    heights: number[],
): Building[] {
    const popPerFloor: Record<string, number> = { residential: 4, commercial: 10, hospital: 50, school: 30 };
    return geoBuildings
        .map((gb): Building | null => {
            const normX = bbox.east !== bbox.west ? (gb.lng - bbox.west) / (bbox.east - bbox.west) : 0.5;
            const normY = bbox.north !== bbox.south ? (gb.lat - bbox.south) / (bbox.north - bbox.south) : 0.5;
            const wx = (normX - 0.5) * SIZE;
            const wz = -(normY - 0.5) * SIZE;
            if (Math.abs(wx) > SIZE * 0.48 || Math.abs(wz) > SIZE * 0.48) return null;
            const elev = heightAtWorld(heights, wx, wz);
            return {
                wx, wz, elev,
                kind: gb.type,
                pop: (popPerFloor[gb.type] ?? 4) * gb.floors + Math.floor(Math.random() * 10),
                name: gb.name,
                floors: gb.floors,
            };
        })
        .filter((b): b is Building => b !== null);
}

function generateSafeZones(heights: number[], seed: number): SafeZone[] {
    const rng = seededRng(seed + 99);
    const zones: SafeZone[] = [];
    const labels = ['Assembly Point A', 'Assembly Point B', 'Relief Camp', 'High Ground Alpha', 'Emergency Shelter'];
    for (let z = 0; z < 5; z++) {
        let bestWx = 0, bestWz = 0, bestE = -1;
        for (let a = 0; a < 60; a++) {
            const wx = (rng() - 0.5) * SIZE * 0.85;
            const wz = (rng() - 0.5) * SIZE * 0.85;
            const e = heightAtWorld(heights, wx, wz);
            if (e > bestE && !zones.some(zz => Math.hypot(zz.wx - wx, zz.wz - wz) < SIZE * 0.18)) {
                bestE = e;
                bestWx = wx;
                bestWz = wz;
            }
        }
        if (bestE > MAX_H * 0.25) zones.push({ wx: bestWx, wz: bestWz, elev: bestE, label: labels[z], cap: 200 + Math.floor(rng() * 400) });
    }
    return zones;
}

const GRID = 50;
function computeEvacPaths(
    buildings: Building[],
    safeZones: SafeZone[],
    heights: number[],
    waterH: number,
    wsWx: number[],
    wsWz: number[],
    spread: number,
    blockedAreas: { x: number, z: number, r: number }[]
) {
    if (safeZones.length === 0 || spread < 1) return [];
    const cost = new Float32Array(GRID * GRID);
    const GRID_SIZE = SIZE; // 80
    for (let gz = 0; gz < GRID; gz++) for (let gx = 0; gx < GRID; gx++) {
        const wx = ((gx / (GRID - 1)) - 0.5) * SIZE;
        const wz = -((gz / (GRID - 1)) - 0.5) * SIZE;
        const e = heightAtWorld(heights, wx, wz);
        let minD = Infinity;
        for (let k = 0; k < wsWx.length; k++) {
            const d = Math.hypot(wx - wsWx[k], wz - wsWz[k]);
            if (d < minD) minD = d;
        }
        // CHECK BLOCKED AREAS
        let isBlocked = false;
        for (const block of blockedAreas) {
            if (Math.hypot(wx - block.x, wz - block.z) < block.r) {
                isBlocked = true;
                break;
            }
        }

        if (isBlocked) {
            cost[gz * GRID + gx] = 1e9; // Impassable
        } else {
            cost[gz * GRID + gx] = (minD < spread && e < waterH) ? 1e6 : 1;
        }
    }


    function astar(fromWx: number, fromWz: number, toWx: number, toWz: number) {
        const clamp = (v: number) => Math.min(Math.max(v, 0), GRID - 1);
        const sx = clamp(Math.round(((fromWx / SIZE) + 0.5) * (GRID - 1)));
        const sy = clamp(Math.round(((-fromWz / SIZE) + 0.5) * (GRID - 1)));
        const ex = clamp(Math.round(((toWx / SIZE) + 0.5) * (GRID - 1)));
        const ey = clamp(Math.round(((-toWz / SIZE) + 0.5) * (GRID - 1)));
        const gScore = new Float32Array(GRID * GRID).fill(Infinity);
        const parent = new Int32Array(GRID * GRID).fill(-1);
        const closed = new Uint8Array(GRID * GRID);
        gScore[sy * GRID + sx] = 0;
        const open: number[] = [sy * GRID + sx];
        const heur = (idx: number) => Math.abs(idx % GRID - ex) + Math.abs(Math.floor(idx / GRID) - ey);
        const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
        while (open.length) {
            let bi = 0;
            for (let i = 1; i < open.length; i++) if (gScore[open[i]] + heur(open[i]) < gScore[open[bi]] + heur(open[bi])) bi = i;
            const cur = open[bi];
            open.splice(bi, 1);
            if (closed[cur]) continue;
            closed[cur] = 1;
            const cx = cur % GRID, cz = Math.floor(cur / GRID);
            if (cx === ex && cz === ey) break;
            for (const [dx, dz] of dirs) {
                const nx = cx + dx, nz = cz + dz;
                if (nx < 0 || nx >= GRID || nz < 0 || nz >= GRID) continue;
                const ni = nz * GRID + nx;
                if (closed[ni]) continue;
                const mc = (dx !== 0 && dz !== 0) ? 1.414 : 1;
                const w1x = ((cx / (GRID - 1)) - 0.5) * SIZE, w1z = -(((cz / (GRID - 1)) - 0.5) * SIZE);
                const w2x = ((nx / (GRID - 1)) - 0.5) * SIZE, w2z = -(((nz / (GRID - 1)) - 0.5) * SIZE);
                const ed = Math.max(0, heightAtWorld(heights, w2x, w2z) - heightAtWorld(heights, w1x, w1z));
                const g = gScore[cur] + mc * cost[ni] + ed * 0.5;
                if (g < gScore[ni]) {
                    gScore[ni] = g;
                    parent[ni] = cur;
                    open.push(ni);
                }
            }
        }
        const path: THREE.Vector3[] = [];
        let ci = ey * GRID + ex, safe = 0;
        while (ci >= 0 && safe < 3000) {
            const gx2 = ci % GRID, gz2 = Math.floor(ci / GRID);
            const wx = ((gx2 / (GRID - 1)) - 0.5) * SIZE;
            const wz = -(((gz2 / (GRID - 1)) - 0.5) * SIZE);
            path.unshift(new THREE.Vector3(wx, heightAtWorld(heights, wx, wz) + 0.5, wz));
            if (ci === sy * GRID + sx) break;
            ci = parent[ci];
            safe++;
        }
        return path;
    }

    const routes: {
        path: THREE.Vector3[];
        from: Building;
        to: SafeZone;
        risk: 'safe' | 'caution' | 'danger';
        dist: number
    }[] = [];
    for (const b of buildings) {
        let minD = Infinity;
        for (let k = 0; k < wsWx.length; k++) {
            const d = Math.hypot(b.wx - wsWx[k], b.wz - wsWz[k]);
            if (d < minD) minD = d;
        }
        const distToFlood = minD;
        const isFlooded = distToFlood < spread && b.elev < waterH;
        const isThreatened = distToFlood < spread * 1.5 && b.elev < waterH * 1.3;
        if (!isFlooded && !isThreatened) continue;
        let best: SafeZone | null = null, bestD = Infinity;
        for (const z of safeZones) {
            const d = Math.hypot(b.wx - z.wx, b.wz - z.wz);
            if (d < bestD) {
                bestD = d;
                best = z;
            }
        }
        if (!best) continue;
        const path = astar(b.wx, b.wz, best.wx, best.wz);
        if (path.length < 2) continue;
        let maxProx = 0;
        for (const pt of path) {
            let minP = Infinity;
            for (let k = 0; k < wsWx.length; k++) {
                const d = Math.hypot(pt.x - wsWx[k], pt.z - wsWz[k]);
                if (d < minP) minP = d;
            }
            if (spread > 0) maxProx = Math.max(maxProx, 1 - minP / spread);
        }
        const risk: 'safe' | 'caution' | 'danger' = maxProx > 0.7 ? 'danger' : maxProx > 0.35 ? 'caution' : 'safe';
        const dist = path.reduce((s, p, i) => i === 0 ? 0 : s + p.distanceTo(path[i - 1]), 0);
        routes.push({ path, from: b, to: best, risk, dist });
    }
    return routes;
}

const VIEW_PRESETS: Record<ViewMode, { pos: [number, number, number]; target: [number, number, number]; fov: number }> = {
    perspective: { pos: [65, 55, 65], target: [0, 5, 0], fov: 45 },
    oblique: { pos: [40, 30, 55], target: [0, 3, -5], fov: 35 },
    top: { pos: [0, 90, 0.1], target: [0, 0, 0], fov: 50 },
    free: { pos: [50, 50, 50], target: [0, 0, 0], fov: 50 },
};

const B_BASE_COLORS: Record<string, number> = {
    residential: 0xd8d0c8,
    commercial: 0xc0c8d4,
    hospital: 0xebe5de,
    school: 0xd4c8a0,
};

export default function FloodTerrainView({
    floodLevel,
    aoiCoordinates,
    waterSources,
    showMesh,
    showEvacRoutes,
    showBuildings,
    geoData,
    viewMode = 'perspective',
    interactionMode = 'view',
    blockedAreas,
    setBlockedAreas,
}: FloodTerrainViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const stateRef = useRef<{
        renderer: THREE.WebGLRenderer;
        scene: THREE.Scene;
        camera: THREE.PerspectiveCamera;
        controls: any;
        animId: number;
        waterMesh: THREE.Mesh;
        waterUniforms: Record<string, any>;
        overlay: THREE.Mesh;
        wire: THREE.LineSegments;
        markersGroup: THREE.Group;
        heights: number[];
        maxH: number;
        minH: number;
        geom: THREE.PlaneGeometry;
        buildingsGroup: THREE.Group;
        roadsGroup: THREE.Group;
        safeZonesGroup: THREE.Group;
        evacGroup: THREE.Group;
        blocksGroup: THREE.Group;
        buildingData: Building[];
        safeZoneData: SafeZone[];
    } | null>(null);

    const [impactStats, setImpactStats] = useState({
        affectedBuildings: 0,
        affectedPop: 0,
        floodedArea: 0,
        safeRoutes: 0,
        cautionRoutes: 0,
        dangerRoutes: 0,
        totalRoutes: 0,
        priorityEvac: 0,
    });

    const [dataInfo, setDataInfo] = useState({
        elevSrc: '',
        bldgSrc: '',
        bldgCount: 0,
        realElevMin: 0,
        realElevMax: 0,
        vertExag: 0,
    });

    const wsNorm = useMemo(() => {
        if (!aoiCoordinates || aoiCoordinates.length < 4 || waterSources.length === 0) return [[0.5, 0.5]];
        const pts = aoiCoordinates.slice(0, -1);
        let mnX = pts[0][0], mxX = pts[0][0], mnY = pts[0][1], mxY = pts[0][1];
        pts.forEach(([x, y]) => {
            mnX = Math.min(mnX, x);
            mxX = Math.max(mxX, x);
            mnY = Math.min(mnY, y);
            mxY = Math.max(mxY, y);
        });
        return waterSources.map(ws => [
            mxX > mnX ? (ws[0] - mnX) / (mxX - mnX) : 0.5,
            mxY > mnY ? (ws[1] - mnY) / (mxY - mnY) : 0.5,
        ]);
    }, [aoiCoordinates, waterSources]);

    const areaKm2 = useMemo(() => {
        if (!aoiCoordinates || aoiCoordinates.length < 4) return 0;
        const pts = aoiCoordinates.slice(0, -1);
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
        }
        a = Math.abs(a) / 2;
        const cLat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        return a * 111.32 * 111.32 * Math.cos(cLat * Math.PI / 180);
    }, [aoiCoordinates]);

    /* ======== VIEW MODE CHANGE ======== */
    useEffect(() => {
        const s = stateRef.current;
        if (!s) return;
        const preset = VIEW_PRESETS[viewMode];
        const { camera, controls } = s;

        const startPos = camera.position.clone();
        const endPos = new THREE.Vector3(...preset.pos);
        const endTarget = new THREE.Vector3(...preset.target);
        const startFov = camera.fov;
        const endFov = preset.fov;

        if (controls) {
            if (viewMode === 'free') {
                // FREE MODE - Full 3D navigation
                controls.maxPolarAngle = Math.PI; // Allow full rotation
                controls.minPolarAngle = 0; // No lower limit
                controls.minDistance = 2;
                controls.maxDistance = 500;
                controls.enablePan = true;
                controls.enableZoom = true;
                controls.enableRotate = true;
                controls.screenSpacePanning = true;

                // SWAPPED: Left click = pan (more intuitive), Right click = rotate
                controls.mouseButtons = {
                    LEFT: THREE.MOUSE.PAN,      // Left click = pan (drag to move)
                    MIDDLE: THREE.MOUSE.DOLLY,  // Middle/scroll = zoom
                    RIGHT: THREE.MOUSE.ROTATE   // Right click = rotate camera
                };

                controls.touches = {
                    ONE: THREE.TOUCH.ROTATE,
                    TWO: THREE.TOUCH.DOLLY_PAN
                };

                controls.zoomSpeed = 1.5;
                controls.rotateSpeed = 1.2;
                controls.panSpeed = 1.5;
                controls.dampingFactor = 0.05;

            } else {
                // LOCKED MODES - keep standard controls
                controls.maxPolarAngle = Math.PI / 2 - 0.02;
                controls.minPolarAngle = 0;
                controls.minDistance = 10;
                controls.maxDistance = 180;
                controls.enablePan = true;
                controls.enableZoom = true;
                controls.enableRotate = true;
                controls.screenSpacePanning = false;

                controls.mouseButtons = {
                    LEFT: THREE.MOUSE.ROTATE,   // Standard: left = rotate
                    MIDDLE: THREE.MOUSE.DOLLY,
                    RIGHT: THREE.MOUSE.PAN
                };

                controls.touches = {
                    ONE: THREE.TOUCH.ROTATE,
                    TWO: THREE.TOUCH.DOLLY_PAN
                };

                controls.zoomSpeed = 1.0;
                controls.rotateSpeed = 1.0;
                controls.panSpeed = 1.0;
                controls.dampingFactor = 0.08;
            }

            controls.update();
        }

        let t = 0;
        const dur = 600;
        const startTime = performance.now();

        function animate() {
            t = Math.min((performance.now() - startTime) / dur, 1);
            const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

            camera.position.lerpVectors(startPos, endPos, ease);
            camera.fov = startFov + (endFov - startFov) * ease;
            camera.updateProjectionMatrix();

            if (controls) {
                controls.target.lerp(endTarget, ease);
                controls.update();
            }

            if (t < 1) requestAnimationFrame(animate);
        }

        animate();
    }, [viewMode]);

    /* ======== KEYBOARD CONTROLS FOR FREE MODE ======== */
    useEffect(() => {
        if (viewMode !== 'free') return;

        const s = stateRef.current;
        if (!s) return;

        const { camera, controls } = s;
        const moveSpeed = 2.0;

        const onKeyDown = (e: KeyboardEvent) => {
            if (!controls) return;

            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
            const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
            const up = new THREE.Vector3(0, 1, 0);

            switch (e.key.toLowerCase()) {
                case 'w':
                    camera.position.addScaledVector(forward, moveSpeed);
                    controls.target.addScaledVector(forward, moveSpeed);
                    break;
                case 's':
                    camera.position.addScaledVector(forward, -moveSpeed);
                    controls.target.addScaledVector(forward, -moveSpeed);
                    break;
                case 'a':
                    camera.position.addScaledVector(right, -moveSpeed);
                    controls.target.addScaledVector(right, -moveSpeed);
                    break;
                case 'd':
                    camera.position.addScaledVector(right, moveSpeed);
                    controls.target.addScaledVector(right, moveSpeed);
                    break;
                case 'q':
                    camera.position.addScaledVector(up, moveSpeed);
                    controls.target.addScaledVector(up, moveSpeed);
                    break;
                case 'e':
                    camera.position.addScaledVector(up, -moveSpeed);
                    controls.target.addScaledVector(up, -moveSpeed);
                    break;
                case 'r':
                    camera.position.set(50, 50, 50);
                    controls.target.set(0, 0, 0);
                    break;
            }

            controls.update();
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [viewMode]);

    /* ======== INIT SCENE ======== */
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const w = el.clientWidth || window.innerWidth;
        const h = el.clientHeight || window.innerHeight;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(w, h);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.15;
        renderer.domElement.style.position = 'absolute';
        renderer.domElement.style.top = '0';
        renderer.domElement.style.left = '0';
        renderer.domElement.style.zIndex = '1';
        renderer.domElement.style.pointerEvents = 'auto';
        el.appendChild(renderer.domElement);

        // CRITICAL: Aggressively prevent context menu on the canvas
        const preventContext = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
        };
        renderer.domElement.addEventListener('contextmenu', preventContext, { capture: true });
        renderer.domElement.addEventListener('auxclick', preventContext, { capture: true }); // Middle click

        // Also prevent on the container
        el.addEventListener('contextmenu', preventContext, { capture: true });

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x87ceeb);
        scene.fog = new THREE.FogExp2(0x87ceeb, 0.004);

        const preset = VIEW_PRESETS[viewMode];
        const camera = new THREE.PerspectiveCamera(preset.fov, w / h, 0.1, 1000);
        camera.position.set(...preset.pos);
        camera.lookAt(...preset.target);

        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        scene.add(new THREE.HemisphereLight(0x87ceeb, 0x556b2f, 0.5));
        const sun = new THREE.DirectionalLight(0xfff5e6, 1.8);
        sun.position.set(50, 70, 40);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        const sc = sun.shadow.camera;
        sc.left = sc.bottom = -60;
        sc.right = sc.top = 60;
        scene.add(sun);
        scene.add(new THREE.DirectionalLight(0x88aaff, 0.3).translateX(-30).translateY(30));

        const useRealElev = !!geoData?.elevation;
        const { geometry: geom, heights, maxH, minH } = useRealElev
            ? generateTerrainFromReal(geoData!.elevation!, aoiCoordinates)
            : generateTerrainProcedural(aoiCoordinates);

        const terrainMesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.75,
            metalness: 0.02,
            flatShading: false,
            side: THREE.DoubleSide,
        }));
        terrainMesh.rotation.x = -Math.PI / 2;
        terrainMesh.receiveShadow = true;
        terrainMesh.castShadow = true;
        scene.add(terrainMesh);

        const sideMesh = new THREE.Mesh(buildSides(geom), new THREE.MeshStandardMaterial({
            color: 0x8b7355,
            roughness: 0.9,
            side: THREE.DoubleSide,
        }));
        sideMesh.rotation.x = -Math.PI / 2;
        sideMesh.castShadow = true;
        scene.add(sideMesh);

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(SIZE + 40, SIZE + 40),
            new THREE.MeshStandardMaterial({ color: 0x3a5a3a }),
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -1;
        ground.receiveShadow = true;
        scene.add(ground);

        const { mesh: waterMesh, uniforms: waterUniforms } = createFloodWaterMesh();
        scene.add(waterMesh);

        const overlayGeom = geom.clone();
        overlayGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count * 3), 3));
        const overlay = new THREE.Mesh(overlayGeom, new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
            side: THREE.DoubleSide,
        }));
        overlay.rotation.x = -Math.PI / 2;
        overlay.position.y = 0.18;
        overlay.visible = false;
        scene.add(overlay);

        const wire = new THREE.LineSegments(
            new THREE.WireframeGeometry(geom),
            new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.13 }),
        );
        wire.rotation.x = -Math.PI / 2;
        wire.position.y = 0.12;
        scene.add(wire);

        const markersGroup = new THREE.Group();
        scene.add(markersGroup);

        const aoiSeedVal = aoiCoordinates
            ? Math.abs(Math.floor(aoiCoordinates.flat().reduce((a, b) => a + b * 10000, 0)))
            : 42;
        const useRealBldg = (geoData?.buildings?.length ?? 0) > 0 && geoData?.elevation?.bbox;
        const buildingData: Building[] = useRealBldg
            ? mapRealBuildings(geoData!.buildings, geoData!.elevation!.bbox, heights)
            : generateBuildingsProcedural(heights, aoiSeedVal);

        const buildingsGroup = new THREE.Group();
        for (const b of buildingData) {
            const group = new THREE.Group();
            const rng = seededRng(Math.floor(b.wx * 100 + b.wz * 7777));
            const footW = b.kind === 'commercial' ? 1.5 + rng() * 0.8 : b.kind === 'hospital' ? 2.2 : b.kind === 'school' ? 2.5 : 0.9 + rng() * 0.6;
            const footD = b.kind === 'school' ? 1.4 : b.kind === 'hospital' ? 1.8 : footW * (0.6 + rng() * 0.5);
            const floors = b.floors ?? (b.kind === 'commercial' ? 3 + Math.floor(rng() * 5) : b.kind === 'hospital' ? 3 + Math.floor(rng() * 2) : b.kind === 'school' ? 2 : 1 + Math.floor(rng() * 3));
            const floorH = 0.5;
            const bh = floors * floorH;
            const baseColor = B_BASE_COLORS[b.kind] ?? 0xcccccc;
            const baseMat = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.4, metalness: 0.05 });
            const baseMesh = new THREE.Mesh(new THREE.BoxGeometry(footW, bh, footD), baseMat);
            baseMesh.position.y = bh / 2;
            baseMesh.castShadow = true;
            baseMesh.receiveShadow = true;
            group.add(baseMesh);

            for (let fl = 0; fl < Math.min(floors, 6); fl++) {
                const wy = fl * floorH + floorH * 0.35;
                const wh = floorH * 0.28;
                const winMat = new THREE.MeshStandardMaterial({ color: 0x2a4060, roughness: 0.2, metalness: 0.35 });
                for (const zOff of [footD / 2 + 0.01, -(footD / 2 + 0.01)]) {
                    const win = new THREE.Mesh(new THREE.PlaneGeometry(footW * 0.82, wh), winMat);
                    win.position.set(0, wy, zOff);
                    if (zOff < 0) win.rotation.y = Math.PI;
                    group.add(win);
                }
                for (const xOff of [footW / 2 + 0.01, -(footW / 2 + 0.01)]) {
                    const win = new THREE.Mesh(new THREE.PlaneGeometry(footD * 0.82, wh), winMat);
                    win.position.set(xOff, wy, 0);
                    win.rotation.y = xOff > 0 ? Math.PI / 2 : -Math.PI / 2;
                    group.add(win);
                }
            }

            const roofSlab = new THREE.Mesh(
                new THREE.BoxGeometry(footW + 0.08, 0.08, footD + 0.08),
                new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.6 }),
            );
            roofSlab.position.y = bh + 0.04;
            roofSlab.receiveShadow = true;
            group.add(roofSlab);

            if (b.kind === 'hospital') {
                const crossMat = new THREE.MeshStandardMaterial({ color: 0xdd2222, emissive: 0xdd2222, emissiveIntensity: 0.3 });
                const ch1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.8, 0.3), crossMat);
                ch1.position.set(footW / 2 + 0.07, bh * 0.65, 0);
                group.add(ch1);
                const ch2 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.8), crossMat);
                ch2.position.set(footW / 2 + 0.07, bh * 0.65, 0);
                group.add(ch2);
            }

            if (b.kind === 'hospital' || b.kind === 'school' || b.name) {
                const icon = b.kind === 'hospital' ? '🏥' : b.kind === 'school' ? '🏫' : '🏢';
                const text = b.name ? `${icon} ${b.name}` : `${icon} ${b.kind.charAt(0).toUpperCase() + b.kind.slice(1)}`;
                const lbl = createTextSprite(text, {
                    fontSize: 16,
                    color: b.kind === 'hospital' ? '#ff8888' : b.kind === 'school' ? '#ffdd66' : '#aaccff',
                });
                lbl.position.set(0, bh + 2.0, 0);
                group.add(lbl);
            }

            group.position.set(b.wx, b.elev, b.wz);
            group.userData = { baseMesh, kind: b.kind, baseColor };
            buildingsGroup.add(group);
        }
        scene.add(buildingsGroup);

        const roadsGroup = new THREE.Group();
        for (let i = 0; i < buildingData.length; i++) {
            for (let j = i + 1; j < buildingData.length; j++) {
                const d = Math.hypot(buildingData[i].wx - buildingData[j].wx, buildingData[i].wz - buildingData[j].wz);
                if (d > SIZE * 0.18) continue;
                const pts: THREE.Vector3[] = [];
                const steps = Math.max(6, Math.floor(d / 1.5));
                for (let ss = 0; ss <= steps; ss++) {
                    const t = ss / steps;
                    const wx = buildingData[i].wx + (buildingData[j].wx - buildingData[i].wx) * t;
                    const wz = buildingData[i].wz + (buildingData[j].wz - buildingData[i].wz) * t;
                    pts.push(new THREE.Vector3(wx, heightAtWorld(heights, wx, wz) + 0.08, wz));
                }
                roadsGroup.add(new THREE.Line(
                    new THREE.BufferGeometry().setFromPoints(pts),
                    new THREE.LineBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.35 }),
                ));
            }
        }
        scene.add(roadsGroup);

        const safeZoneData = generateSafeZones(heights, aoiSeedVal);
        const safeZonesGroup = new THREE.Group();
        for (const z of safeZoneData) {
            const pole = new THREE.Mesh(
                new THREE.CylinderGeometry(0.12, 0.12, 3.5, 8),
                new THREE.MeshStandardMaterial({ color: 0x00dd44, emissive: 0x00dd44, emissiveIntensity: 0.3 }),
            );
            pole.position.set(z.wx, z.elev + 1.75, z.wz);
            safeZonesGroup.add(pole);

            const flag = new THREE.Mesh(
                new THREE.PlaneGeometry(1.6, 0.8),
                new THREE.MeshStandardMaterial({ color: 0x00ff44, emissive: 0x00ff44, emissiveIntensity: 0.3, side: THREE.DoubleSide }),
            );
            flag.position.set(z.wx + 0.8, z.elev + 3.0, z.wz);
            safeZonesGroup.add(flag);

            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(2.5, 0.15, 8, 32),
                new THREE.MeshStandardMaterial({ color: 0x00ff44, transparent: true, opacity: 0.25, emissive: 0x00ff44, emissiveIntensity: 0.2 }),
            );
            ring.rotation.x = -Math.PI / 2;
            ring.position.set(z.wx, z.elev + 0.2, z.wz);
            safeZonesGroup.add(ring);

            const lbl = createTextSprite(`🏁 ${z.label} (${z.cap})`, {
                fontSize: 16,
                color: '#88ff88',
                bgColor: 'rgba(0,30,0,0.88)',
                borderColor: 'rgba(0,255,68,0.3)',
            });
            lbl.position.set(z.wx, z.elev + 4.5, z.wz);
            safeZonesGroup.add(lbl);
        }
        scene.add(safeZonesGroup);

        const evacGroup = new THREE.Group();
        scene.add(evacGroup);

        const blocksGroup = new THREE.Group();
        scene.add(blocksGroup);


        const elevRange = geoData?.elevation ? Math.max(geoData.elevation.max - geoData.elevation.min, 0.5) : 0;
        setDataInfo({
            elevSrc: useRealElev ? 'Open-Meteo SRTM' : 'Simulated (procedural)',
            bldgSrc: useRealBldg ? 'OpenStreetMap' : 'Simulated (procedural)',
            bldgCount: buildingData.length,
            realElevMin: useRealElev ? Math.round(geoData!.elevation!.min) : 0,
            realElevMax: useRealElev ? Math.round(geoData!.elevation!.max) : 0,
            vertExag: useRealElev ? +(MAX_H / elevRange).toFixed(1) : 0,
        });

        let controls: any = null;
        import('three/examples/jsm/controls/OrbitControls.js').then(mod => {
            controls = new mod.OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = 0.08;
            controls.enablePan = true;
            controls.enableZoom = true;
            controls.enableRotate = true;
            controls.screenSpacePanning = false;
            controls.minDistance = 10;
            controls.maxDistance = 180;
            controls.maxPolarAngle = Math.PI / 2 - 0.02;
            controls.target.set(...preset.target);

            // CRITICAL: Set mouse buttons explicitly to match initial ViewMode
            if (viewMode === 'free') {
                controls.mouseButtons = {
                    LEFT: THREE.MOUSE.PAN,
                    MIDDLE: THREE.MOUSE.DOLLY,
                    RIGHT: THREE.MOUSE.ROTATE
                };
                controls.touches = {
                    ONE: THREE.TOUCH.PAN,
                    TWO: THREE.TOUCH.DOLLY_ROTATE
                };
                controls.zoomSpeed = 1.5;
                controls.rotateSpeed = 1.2;
                controls.panSpeed = 1.5;
            } else {
                controls.mouseButtons = {
                    LEFT: THREE.MOUSE.ROTATE,
                    MIDDLE: THREE.MOUSE.DOLLY,
                    RIGHT: THREE.MOUSE.PAN
                };
                controls.touches = {
                    ONE: THREE.TOUCH.ROTATE,
                    TWO: THREE.TOUCH.DOLLY_PAN
                };
            }

            controls.update();

            if (stateRef.current) stateRef.current.controls = controls;
        });

        stateRef.current = {
            renderer, scene, camera, controls, animId: 0, waterMesh, waterUniforms,
            overlay, wire, markersGroup, heights, maxH, minH, geom,
            buildingsGroup, roadsGroup, safeZonesGroup, evacGroup, blocksGroup,
            buildingData, safeZoneData,
        };

        const clock = new THREE.Clock();
        function loop() {
            stateRef.current!.animId = requestAnimationFrame(loop);
            stateRef.current?.controls?.update();
            const t = clock.getElapsedTime();
            waterUniforms.uTime.value = t;
            safeZonesGroup.children.forEach(child => {
                if ((child as THREE.Mesh).geometry instanceof THREE.TorusGeometry) child.rotation.z = t * 0.4;
            });
            evacGroup.children.forEach(child => {
                const mat = (child as THREE.Mesh).material;
                if (mat && (mat as THREE.MeshStandardMaterial).emissiveIntensity !== undefined)
                    (mat as THREE.MeshStandardMaterial).emissiveIntensity = 0.3 + Math.sin(t * 3) * 0.25;
            });
            renderer.render(scene, camera);
        }
        loop();

        const onResize = () => {
            const rw = el.clientWidth || window.innerWidth;
            const rh = el.clientHeight || window.innerHeight;
            camera.aspect = rw / rh;
            camera.updateProjectionMatrix();
            renderer.setSize(rw, rh);
        };
        window.addEventListener('resize', onResize);

        return () => {
            cancelAnimationFrame(stateRef.current?.animId ?? 0);
            window.removeEventListener('resize', onResize);
            renderer.domElement.removeEventListener('contextmenu', preventContext, { capture: true });
            renderer.domElement.removeEventListener('auxclick', preventContext, { capture: true });
            el.removeEventListener('contextmenu', preventContext, { capture: true });
            controls?.dispose();
            renderer.dispose();
            if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
            stateRef.current = null;
        };
    }, [aoiCoordinates, geoData]);

    /* ======== INTERACTION (CLICK TO BLOCK) ======== */
    useEffect(() => {
        const s = stateRef.current;
        if (!s || interactionMode !== 'block') return;
        const { renderer, camera, geom } = s;

        const onDown = (e: MouseEvent) => {
            if (e.button !== 0) return; // Only Left Click
            const rect = renderer.domElement.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(new THREE.Vector2(x, y), camera);

            // Intersect with terrain
            const terrainMesh = s.scene.children.find(c => c.type === 'Mesh' && (c as THREE.Mesh).geometry === geom);
            if (!terrainMesh) return;

            const intersects = raycaster.intersectObject(terrainMesh);
            if (intersects.length > 0) {
                const p = intersects[0].point;
                // Check distance to existing blocks
                const existingIndex = blockedAreas.findIndex(b => Math.hypot(b.x - p.x, b.z - p.z) < b.r * 1.5);

                if (existingIndex >= 0) {
                    // Remove block
                    const newBlocks = [...blockedAreas];
                    newBlocks.splice(existingIndex, 1);
                    setBlockedAreas(newBlocks);
                } else {
                    // Add block
                    setBlockedAreas([...blockedAreas, { x: p.x, z: p.z, r: 4.0 }]);
                }
            }
        };

        renderer.domElement.addEventListener('mousedown', onDown);
        return () => renderer.domElement.removeEventListener('mousedown', onDown);
    }, [interactionMode, blockedAreas, setBlockedAreas]);

    /* ======== DYNAMIC UPDATE ======== */
    useEffect(() => {
        const s = stateRef.current;
        if (!s) return;

        const { waterMesh, waterUniforms, overlay, wire, markersGroup, heights, maxH, geom,
            buildingsGroup, roadsGroup, safeZonesGroup, evacGroup, blocksGroup, buildingData, safeZoneData } = s;

        const waterH = (floodLevel / 20) * maxH * 0.85;
        const show = floodLevel > 0.3;
        const wsWx = wsNorm.map(n => (n[0] - 0.5) * SIZE);
        const wsWz = wsNorm.map(n => -(n[1] - 0.5) * SIZE);
        const spread = (floodLevel / 20) * SIZE * 0.8;

        waterMesh.visible = show;
        if (show) {
            waterUniforms.uWaterLevel.value = waterH;
            updateFloodWater(waterMesh.geometry as THREE.PlaneGeometry, heights, waterH, wsWx, wsWz, spread);
        }

        overlay.visible = show;
        if (show) {
            const pos = geom.attributes.position;
            const ca = overlay.geometry.attributes.color as THREE.BufferAttribute;
            const arr = ca.array as Float32Array;
            for (let i = 0; i < pos.count; i++) {
                const px = pos.getX(i);
                const py = pos.getY(i);
                const wx = px;
                const wz = -py;
                let minD = Infinity;
                for (let k = 0; k < wsWx.length; k++) {
                    const d = Math.hypot(wx - wsWx[k], wz - wsWz[k]);
                    if (d < minD) minD = d;
                }
                const under = heights[i] <= waterH && minD <= spread;
                if (under) {
                    const depthRatio = Math.min((waterH - heights[i]) / (maxH * 0.3), 1);
                    if (depthRatio > 0.6) {
                        arr[i * 3] = 0.8;
                        arr[i * 3 + 1] = 0.1;
                        arr[i * 3 + 2] = 0.1;
                    } else if (depthRatio > 0.25) {
                        arr[i * 3] = 0.8;
                        arr[i * 3 + 1] = 0.5;
                        arr[i * 3 + 2] = 0.1;
                    } else {
                        arr[i * 3] = 0.2;
                        arr[i * 3 + 1] = 0.3;
                        arr[i * 3 + 2] = 0.7;
                    }
                } else {
                    arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = 0;
                }
            }
            ca.needsUpdate = true;
        }

        wire.visible = showMesh;

        while (markersGroup.children.length > 0) {
            const c = markersGroup.children[0];
            markersGroup.remove(c);
            const mesh = c as THREE.Mesh;
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) (mesh.material as any).dispose();
        }
        wsWx.forEach((wx, i) => {
            const wz = wsWz[i];
            const marker = new THREE.Mesh(
                new THREE.SphereGeometry(1.0, 16, 16),
                new THREE.MeshStandardMaterial({ color: 0x2563eb, emissive: 0x3b82f6, emissiveIntensity: 0.9 })
            );
            marker.position.set(wx, maxH + 3, wz);
            markersGroup.add(marker);
            const label = createTextSprite(`${i + 1}`, { fontSize: 24, color: 'white', bgColor: '#2563eb' });
            label.position.set(0, 2.5, 0);
            marker.add(label);
        });

        buildingsGroup.visible = showBuildings;
        roadsGroup.visible = showBuildings;
        safeZonesGroup.visible = showEvacRoutes;

        buildingsGroup.children.forEach((grp, idx) => {
            if (idx >= buildingData.length) return;
            const bld = buildingData[idx];
            const ud = (grp as THREE.Group).userData;
            const bm = ud?.baseMesh as THREE.Mesh | undefined;
            if (!bm) return;
            const mat = bm.material as THREE.MeshStandardMaterial;
            let minD = Infinity;
            for (let k = 0; k < wsWx.length; k++) {
                const d = Math.hypot(bld.wx - wsWx[k], bld.wz - wsWz[k]);
                if (d < minD) minD = d;
            }
            const d = minD;
            if (show && d < spread && bld.elev < waterH) {
                mat.color.setHex(0xdd1111);
                mat.emissive.setHex(0xcc0000);
                mat.emissiveIntensity = 0.5;
            } else if (show && d < spread * 1.3 && bld.elev < waterH * 1.2) {
                mat.color.setHex(0xff6600);
                mat.emissive.setHex(0xff4400);
                mat.emissiveIntensity = 0.25;
            } else {
                mat.color.setHex(ud?.baseColor ?? 0xcccccc);
                mat.emissive.setHex(0x000000);
                mat.emissiveIntensity = 0;
            }
        });

        while (evacGroup.children.length) {
            const c = evacGroup.children[0];
            evacGroup.remove(c);
            if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose();
        }

        // Render Blocks
        while (blocksGroup.children.length) {
            blocksGroup.remove(blocksGroup.children[0]);
        }
        blockedAreas.forEach((blk, i) => {
            const mesh = new THREE.Mesh(
                new THREE.CylinderGeometry(blk.r, blk.r, 2, 16),
                new THREE.MeshStandardMaterial({ color: 0xff0000, transparent: true, opacity: 0.6 })
            );
            mesh.position.set(blk.x, heightAtWorld(heights, blk.x, blk.z) + 1, blk.z);
            blocksGroup.add(mesh);

            const label = createTextSprite('⛔ BLOCKED', { fontSize: 18, color: '#ffaaaa', bgColor: 'rgba(50,0,0,0.8)' });
            label.position.set(0, 2.5, 0);
            mesh.add(label);
        });

        if (showEvacRoutes && show) {
            const routes = computeEvacPaths(buildingData, safeZoneData, heights, waterH, wsWx, wsWz, spread, blockedAreas);
            const riskColors = { safe: 0x00ff44, caution: 0xffaa00, danger: 0xff4444 };
            for (const route of routes) {
                if (route.path.length < 2) continue;
                const color = riskColors[route.risk];
                const curve = new THREE.CatmullRomCurve3(route.path);
                evacGroup.add(new THREE.Mesh(
                    new THREE.TubeGeometry(curve, Math.max(route.path.length * 2, 8), 0.2, 6, false),
                    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4, transparent: true, opacity: 0.8 }),
                ));
                const arrowCount = Math.max(2, Math.floor(route.path.length / 5));
                for (let ai = 1; ai <= arrowCount; ai++) {
                    const t = ai / (arrowCount + 1);
                    const pt = curve.getPointAt(t), tan = curve.getTangentAt(t);
                    const cone = new THREE.Mesh(
                        new THREE.ConeGeometry(0.3, 0.7, 6),
                        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 }),
                    );
                    cone.position.copy(pt);
                    cone.lookAt(pt.clone().add(tan));
                    cone.rotateX(Math.PI / 2);
                    evacGroup.add(cone);
                }
            }

            let affBld = 0, affPop = 0, priorityEvac = 0;
            for (const bld of buildingData) {
                let minD = Infinity;
                for (let k = 0; k < wsWx.length; k++) {
                    const d = Math.hypot(bld.wx - wsWx[k], bld.wz - wsWz[k]);
                    if (d < minD) minD = d;
                }
                const d = minD;
                if (d < spread && bld.elev < waterH) {
                    affBld++;
                    affPop += bld.pop;
                    if (bld.kind === 'hospital' || bld.kind === 'school') priorityEvac++;
                }
            }
            setImpactStats({
                affectedBuildings: affBld,
                affectedPop: affPop,
                floodedArea: Math.round(Math.PI * (spread * spread) * 0.01),
                safeRoutes: routes.filter(r => r.risk === 'safe').length,
                cautionRoutes: routes.filter(r => r.risk === 'caution').length,
                dangerRoutes: routes.filter(r => r.risk === 'danger').length,
                totalRoutes: routes.length,
                priorityEvac,
            });
        } else {
            setImpactStats({
                affectedBuildings: 0,
                affectedPop: 0,
                floodedArea: 0,
                safeRoutes: 0,
                cautionRoutes: 0,
                dangerRoutes: 0,
                totalRoutes: 0,
                priorityEvac: 0
            });
        }
    }, [floodLevel, showMesh, wsNorm, showEvacRoutes, showBuildings, blockedAreas]);

    const waterHeight = (floodLevel * 2.5).toFixed(1);
    const riskLabel = floodLevel > 15 ? 'EXTREME' : floodLevel > 10 ? 'HIGH' : floodLevel > 6 ? 'MODERATE' : 'LOW';
    const riskColor = floodLevel > 15 ? '#ef4444' : floodLevel > 10 ? '#f59e0b' : floodLevel > 6 ? '#facc15' : '#34d399';
    const riskIcon = floodLevel > 15 ? '🔴' : floodLevel > 10 ? '🟠' : floodLevel > 6 ? '🟡' : '🟢';

    const [legendOpen, setLegendOpen] = useState(true);
    const [dataOpen, setDataOpen] = useState(false);

    return (
        <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
            {/* FREE MODE CONTROLS INDICATOR */}
            {viewMode === 'free' && (
                <div style={{
                    position: 'absolute',
                    bottom: '20px',
                    right: '20px',
                    background: 'rgba(0,0,0,0.85)',
                    color: 'white',
                    padding: '12px 16px',
                    borderRadius: '8px',
                    fontSize: '11px',
                    fontFamily: 'monospace',
                    border: '1px solid rgba(255,255,255,0.2)',
                    zIndex: 1000,
                }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '6px', color: '#3b82f6' }}>🎮 FREE MODE</div>
                    <div>Left Click + Drag: Pan (move around)</div>
                    <div>Right Click + Drag: Rotate camera</div>
                    <div>Scroll Wheel: Zoom in/out</div>
                    <div style={{ borderTop: '1px solid rgba(255,255,255,0.2)', marginTop: '6px', paddingTop: '6px' }}>
                        <div>WASD: Fly forward/back/left/right</div>
                        <div>Q/E: Fly up/down</div>
                    </div>
                    <div style={{ marginTop: '4px', opacity: 0.7 }}>Press R to reset view</div>
                </div>
            )}

            {/* INFO BAR */}
            <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                background: `linear-gradient(180deg, ${floodLevel > 10 ? 'rgba(239,68,68,0.4)' : 'rgba(56,189,248,0.3)'}, transparent)`,
                padding: '1rem 1.5rem',
                display: 'flex',
                gap: '1.5rem',
                alignItems: 'center',
                fontSize: '0.75rem',
                fontFamily: 'monospace',
                zIndex: 100,
            }}>
                {[
                    { label: 'Area', value: `${areaKm2.toFixed(2)} km²`, color: '#38bdf8', icon: '📐' },
                    { label: 'Water', value: `${waterHeight}m`, color: floodLevel > 10 ? '#f59e0b' : '#38bdf8', icon: '💧' },
                    { label: 'Spread', value: `${(Math.min(floodLevel / 20, 1) * 100).toFixed(0)}%`, color: '#f8fafc', icon: '📊' },
                    { label: 'Risk', value: `${riskIcon} ${riskLabel}`, color: riskColor, icon: '' },
                ].map(({ label, value, color, icon }, idx) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {idx > 0 && <div style={{ width: '1px', height: '1.5rem', background: 'rgba(255,255,255,0.2)' }} />}
                        <div>
                            <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.6rem', marginBottom: '2px' }}>{icon} {label}</div>
                            <div style={{ color, fontWeight: 'bold', fontSize: '0.85rem' }}>{value}</div>
                        </div>
                    </div>
                ))}
            </div>

            {/* DATA SOURCES BADGE */}
            <div style={{
                position: 'absolute',
                top: '80px',
                left: '1rem',
                background: 'rgba(15,23,42,0.92)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                padding: '0.75rem',
                fontSize: '0.7rem',
                maxWidth: '280px',
                zIndex: 90,
                color: '#e2e8f0',
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: dataOpen ? '0.5rem' : 0, cursor: 'pointer' }}
                    onClick={() => setDataOpen(!dataOpen)}>
                    <span style={{ fontWeight: 'bold' }}>📡 Data Sources</span>
                    <span style={{ fontSize: '0.8rem' }}>{dataOpen ? '▼' : '▶'}</span>
                </div>
                {dataOpen && (<>
                    <div style={{ marginBottom: '0.4rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                        <span style={{ color: dataInfo.elevSrc.includes('SRTM') ? '#10b981' : '#f59e0b' }}>
                            {dataInfo.elevSrc.includes('SRTM') ? '✓' : '⚠'}
                        </span> Elevation: {dataInfo.elevSrc}
                    </div>
                    {(dataInfo.realElevMin !== 0 || dataInfo.realElevMax !== 0) && (
                        <div style={{ fontSize: '0.65rem', color: '#94a3b8', marginLeft: '1rem', marginBottom: '0.4rem' }}>
                            Range: {dataInfo.realElevMin}m – {dataInfo.realElevMax}m
                            {dataInfo.vertExag > 1.5 && <> · Vert. exaggeration: ×{dataInfo.vertExag}</>}
                        </div>
                    )}
                    <div>
                        <span style={{ color: dataInfo.bldgSrc.includes('OpenStreetMap') ? '#10b981' : '#f59e0b' }}>
                            {dataInfo.bldgSrc.includes('OpenStreetMap') ? '✓' : '⚠'}
                        </span> Buildings: {dataInfo.bldgSrc}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: '#94a3b8', marginLeft: '1rem' }}>
                        {dataInfo.bldgCount} structures {dataInfo.bldgSrc.includes('OpenStreetMap') ? 'found' : 'generated'}
                    </div>
                </>)}
            </div>

            {/* EVACUATION GUIDE */}
            {showEvacRoutes && (
                <div style={{
                    position: 'absolute',
                    top: dataOpen ? '200px' : '140px',
                    left: '1rem',
                    background: 'rgba(15,23,42,0.92)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '8px',
                    padding: '0.75rem',
                    fontSize: '0.7rem',
                    maxWidth: '280px',
                    zIndex: 90,
                    color: '#e2e8f0',
                }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>📋 Evacuation Routes Guide</div>
                    <div style={{ marginBottom: '0.5rem', fontSize: '0.65rem', lineHeight: '1.4' }}>
                        Each glowing tube = an escape path from a threatened building to the nearest safe zone.
                    </div>
                    {[
                        { bg: '#00ff44', label: 'Safe', desc: '— clear path' },
                        { bg: '#ffaa00', label: 'Caution', desc: '— passes near flood' },
                        { bg: '#ff4444', label: 'Danger', desc: '— route through flood' },
                    ].map(r => (
                        <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                            <div style={{ width: '20px', height: '3px', background: r.bg, borderRadius: '2px' }} />
                            <span style={{ fontSize: '0.65rem' }}><strong>{r.label}</strong> {r.desc}</span>
                        </div>
                    ))}
                    <div style={{ marginTop: '0.5rem', fontSize: '0.6rem', color: '#94a3b8', lineHeight: '1.3' }}>
                        ▶ Arrow cones = walk direction<br />
                        ⚡ Routes update dynamically as water rises
                    </div>
                </div>
            )}

            {/* IMPACT PANEL */}
            {showEvacRoutes && floodLevel > 0.3 && (
                <div style={{
                    position: 'absolute',
                    bottom: '1rem',
                    left: '1rem',
                    background: 'rgba(15,23,42,0.92)',
                    border: '1px solid rgba(239,68,68,0.3)',
                    borderRadius: '8px',
                    padding: '0.75rem',
                    fontSize: '0.7rem',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '0.75rem',
                    minWidth: '240px',
                    zIndex: 90,
                    color: '#e2e8f0',
                }}>
                    <div>
                        <div style={{ fontSize: '0.6rem', color: '#94a3b8' }}>Buildings</div>
                        <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#ef4444' }}>{impactStats.affectedBuildings}</div>
                        <div style={{ fontSize: '0.6rem', color: '#fca5a5' }}>flooded</div>
                    </div>
                    <div>
                        <div style={{ fontSize: '0.6rem', color: '#94a3b8' }}>People</div>
                        <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#fb923c' }}>{impactStats.affectedPop}</div>
                        <div style={{ fontSize: '0.6rem', color: '#fdba74' }}>at risk</div>
                    </div>
                    {impactStats.priorityEvac > 0 && (<>
                        <div>
                            <div style={{ fontSize: '0.6rem', color: '#94a3b8' }}>Priority</div>
                            <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#dc2626' }}>{impactStats.priorityEvac}</div>
                            <div style={{ fontSize: '0.6rem', color: '#fca5a5' }}>🏥🏫 critical</div>
                        </div>
                    </>)}
                    <div style={{ gridColumn: impactStats.priorityEvac > 0 ? 'auto' : '1 / -1' }}>
                        <div style={{ fontSize: '0.6rem', color: '#94a3b8', marginBottom: '4px' }}>Routes</div>
                        <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.65rem' }}>
                            <span style={{ color: '#10b981' }}>✓{impactStats.safeRoutes}</span>
                            <span style={{ color: '#f59e0b' }}>⚠{impactStats.cautionRoutes}</span>
                            <span style={{ color: '#ef4444' }}>✗{impactStats.dangerRoutes}</span>
                        </div>
                        <div style={{ fontSize: '0.6rem', color: '#cbd5e1' }}>{impactStats.totalRoutes} total</div>
                    </div>
                </div>
            )}

            {/* LEGEND */}
            <div style={{
                position: 'absolute',
                bottom: '1rem',
                right: '1rem',
                background: 'rgba(15,23,42,0.92)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                padding: '0.75rem',
                fontSize: '0.7rem',
                maxWidth: '200px',
                zIndex: 90,
                color: '#e2e8f0',
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: legendOpen ? '0.5rem' : 0, cursor: 'pointer' }}
                    onClick={() => setLegendOpen(!legendOpen)}>
                    <span style={{ fontWeight: 'bold' }}>🗺️ Legend</span>
                    <span style={{ fontSize: '0.8rem' }}>{legendOpen ? '▼' : '▶'}</span>
                </div>
                {legendOpen && (
                    <div>
                        {[
                            { c: 'linear-gradient(90deg, #0a2060, #2060aa, #4090cc)', l: 'Deep → Shallow Water', t: '#7dd3fc' },
                            { c: '#dd1111', l: '🏠 Flooded Building', t: '#fca5a5' },
                            { c: '#ff6600', l: '🏠 At-Risk Building', t: '#fdba74' },
                            { c: '#d8d0c8', l: '🏠 Safe Building', t: '#d1d5db' },
                            ...(showEvacRoutes ? [
                                { c: '#00ff44', l: '→ Safe Route', t: '#86efac' },
                                { c: '#ffaa00', l: '→ Caution Route', t: '#fde047' },
                                { c: '#ff4444', l: '→ Danger Route', t: '#fca5a5' },
                            ] : []),
                        ].map(({ c, l, t }) => (
                            <div key={l} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                                <div style={{ width: '24px', height: '12px', background: c, borderRadius: '3px', border: '1px solid rgba(255,255,255,0.2)' }} />
                                <span style={{ fontSize: '0.65rem', color: t }}>{l}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}