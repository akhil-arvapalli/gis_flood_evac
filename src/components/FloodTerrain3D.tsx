'use client';

import { useRef, useMemo, useEffect, useState } from 'react';
import * as THREE from 'three';
import type { GeoData, GeoElevation, GeoBuilding } from '@/lib/geodata';

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
    for (let i = 0; i < oct; i++) { v += smoothNoise(x * f, y * f) * a; m += a; a *= 0.5; f *= 2; }
    return v / m;
}
function seededRng(s: number) {
    let st = Math.abs(s) || 1;
    return () => { st = (st * 16807 + 0) % 2147483647; return (st - 1) / 2147483646; };
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
    return grid[iy][ix] * (1 - fx) * (1 - fy) + grid[iy][ix1] * fx * (1 - fy)
        + grid[iy1][ix] * (1 - fx) * fy + grid[iy1][ix1] * fx * fy;
}

/* ================================================================
   TEXT SPRITE
   ================================================================ */
function createTextSprite(text: string, opts: {
    fontSize?: number; color?: string; bgColor?: string; borderColor?: string;
} = {}): THREE.Sprite {
    const { fontSize = 22, color = '#fff', bgColor = 'rgba(15,23,42,0.9)', borderColor = 'rgba(255,255,255,0.18)' } = opts;
    const pad = 10;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `bold ${fontSize}px "Segoe UI",Arial,sans-serif`;
    const tw = ctx.measureText(text).width;
    const cw = tw + pad * 2, ch = fontSize * 1.35 + pad * 2;
    canvas.width = Math.ceil(cw) * 2; canvas.height = Math.ceil(ch) * 2;
    ctx.scale(2, 2);
    const rr = 5;
    ctx.beginPath();
    ctx.moveTo(rr, 0); ctx.lineTo(cw - rr, 0);
    ctx.quadraticCurveTo(cw, 0, cw, rr); ctx.lineTo(cw, ch - rr);
    ctx.quadraticCurveTo(cw, ch, cw - rr, ch); ctx.lineTo(rr, ch);
    ctx.quadraticCurveTo(0, ch, 0, ch - rr); ctx.lineTo(0, rr);
    ctx.quadraticCurveTo(0, 0, rr, 0);
    ctx.closePath();
    ctx.fillStyle = bgColor; ctx.fill();
    ctx.strokeStyle = borderColor; ctx.lineWidth = 1; ctx.stroke();
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
   WATER SURFACE SHADER  (realistic ArcGIS-style depth-based water)
   ================================================================ */
const waterVertexShader = `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  uniform float uTime;
  void main() {
    vUv = uv;
    vec3 pos = position;
    // subtle animated ripples
    float wave = sin(pos.x * 3.0 + uTime * 1.5) * 0.04
               + sin(pos.z * 4.0 - uTime * 2.0) * 0.03
               + sin((pos.x + pos.z) * 5.0 + uTime * 0.8) * 0.02;
    pos.y += wave;
    vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
  }
`;

const waterFragmentShader = `
  uniform float uWaterLevel;
  uniform float uTime;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    // depth-based color: deeper = darker blue, shallow = lighter
    float depth = max(uWaterLevel - vWorldPos.y, 0.0);
    float depthN = clamp(depth / 6.0, 0.0, 1.0);

    // deep water: dark navy. shallow: lighter blue with some transparency
    vec3 deepColor = vec3(0.02, 0.12, 0.35);
    vec3 shallowColor = vec3(0.15, 0.45, 0.75);
    vec3 veryShallow = vec3(0.3, 0.6, 0.85);

    vec3 color = depthN > 0.4
      ? mix(shallowColor, deepColor, (depthN - 0.4) / 0.6)
      : mix(veryShallow, shallowColor, depthN / 0.4);

    // animated caustics / ripple highlights
    float ripple = sin(vWorldPos.x * 8.0 + uTime * 2.0) * sin(vWorldPos.z * 6.0 - uTime * 1.5);
    float specular = smoothstep(0.6, 1.0, ripple) * 0.15;
    color += vec3(specular);

    // shallow edges = more transparent
    float alpha = uOpacity * smoothstep(0.0, 0.15, depthN) * (0.65 + depthN * 0.35);

    gl_FragColor = vec4(color, alpha);
  }
`;

/* ================================================================
   TERRAIN
   ================================================================ */
const SIZE = 80, SEGS = 180, MAX_H = 22;

function aoiSeed(coords: number[][] | null | undefined) {
    if (!coords || coords.length < 4) return { sx: 3.7, sy: 1.2, ridgeF: 12, valleyAng: 0.6 };
    const pts = coords.slice(0, -1);
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const sx = ((cx * 1000) % 100) + ((cy * 1000) % 50);
    const sy = ((cy * 1000) % 100) + ((cx * 1000) % 50);
    const ridgeF = 8 + ((Math.abs(cx * 7 + cy * 13) * 100) % 10);
    const valleyAng = ((cx * 3 + cy * 5) % 3) - 1.0;
    return { sx, sy, ridgeF, valleyAng };
}

function applyTerrainColors(geom: THREE.PlaneGeometry, heights: number[], minH: number, maxH: number) {
    const pos = geom.attributes.position;
    const cols = SEGS + 1;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
        const t = maxH > minH ? (heights[i] - minH) / (maxH - minH) : 0;
        const ix = i % cols, iy = Math.floor(i / cols);
        const hL = ix > 0 ? heights[i - 1] : heights[i];
        const hR = ix < cols - 1 ? heights[i + 1] : heights[i];
        const hU = iy > 0 ? heights[i - cols] : heights[i];
        const hD = iy < SEGS ? heights[i + cols] : heights[i];
        const cell = SIZE / SEGS;
        const slope = Math.sqrt(((hR - hL) / (2 * cell)) ** 2 + ((hD - hU) / (2 * cell)) ** 2);
        const sf = Math.min(slope / 2.5, 1);
        const nv = hash(ix * 7 + 31, iy * 13 + 47) * 0.10 - 0.05;
        const te = Math.min(Math.max(t + nv, 0), 1);
        let r: number, g: number, b: number;
        if (te < 0.12) { const s = te / 0.12; r = 0.08 + s * 0.06; g = 0.32 + s * 0.12; b = 0.06 + s * 0.04; }
        else if (te < 0.30) { const s = (te - 0.12) / 0.18; r = 0.14 + s * 0.14; g = 0.44 + s * 0.14; b = 0.10; }
        else if (te < 0.50) { const s = (te - 0.30) / 0.20; r = 0.28 + s * 0.22; g = 0.58 - s * 0.06; b = 0.10 + s * 0.04; }
        else if (te < 0.72) { const s = (te - 0.50) / 0.22; r = 0.50 + s * 0.10; g = 0.52 - s * 0.14; b = 0.14 + s * 0.10; }
        else { const s = (te - 0.72) / 0.28; r = 0.60 + s * 0.24; g = 0.58 + s * 0.22; b = 0.52 + s * 0.28; }
        const rockR = 0.46 + nv, rockG = 0.40 + nv * 0.5, rockB = 0.34;
        const blend = sf * 0.75;
        r = r * (1 - blend) + rockR * blend;
        g = g * (1 - blend) + rockG * blend;
        b = b * (1 - blend) + rockB * blend;
        colors[i * 3] = Math.min(Math.max(r, 0), 1);
        colors[i * 3 + 1] = Math.min(Math.max(g, 0), 1);
        colors[i * 3 + 2] = Math.min(Math.max(b, 0), 1);
    }
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function generateTerrainProcedural(aoiCoords?: number[][] | null) {
    const { sx, sy, ridgeF, valleyAng } = aoiSeed(aoiCoords);
    const geom = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
    const pos = geom.attributes.position;
    const heights: number[] = [];
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const nx = (x + SIZE / 2) / SIZE, ny = (y + SIZE / 2) / SIZE;
        let h = fbm(nx * 6 + sx, ny * 6 + sy, 6) * MAX_H;
        h += Math.abs(Math.sin(nx * ridgeF + sx) * Math.cos(ny * (ridgeF * 0.7) + sy)) * 4;
        const dr = Math.abs(x * valleyAng + Math.sin(ny * 5 + sx * 0.3) * 6);
        h -= Math.max(0, 6 - dr * 0.4);
        h = Math.max(0, h);
        pos.setZ(i, h); heights.push(h);
        minH = Math.min(minH, h); maxH = Math.max(maxH, h);
    }
    applyTerrainColors(geom, heights, minH, maxH);
    geom.computeVertexNormals();
    return { geometry: geom, heights, minH, maxH };
}

function generateTerrainFromReal(elevData: GeoElevation, aoiCoords?: number[][] | null) {
    const geom = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
    const pos = geom.attributes.position;
    const heights: number[] = [];
    const { sx, sy } = aoiSeed(aoiCoords);
    const range = Math.max(elevData.max - elevData.min, 0.5);
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const nx = (x + SIZE / 2) / SIZE;
        const ny = (y + SIZE / 2) / SIZE;
        const realE = bilinearInterp(elevData.grid, elevData.rows, elevData.cols, nx, ny);
        let h = ((realE - elevData.min) / range) * MAX_H;
        h += fbm(nx * 14 + sx, ny * 14 + sy, 3) * MAX_H * 0.015;
        h = Math.max(0, h);
        pos.setZ(i, h); heights.push(h);
        minH = Math.min(minH, h); maxH = Math.max(maxH, h);
    }
    applyTerrainColors(geom, heights, minH, maxH);
    geom.computeVertexNormals();
    return { geometry: geom, heights, minH, maxH };
}

function buildSides(geom: THREE.PlaneGeometry) {
    const pos = geom.attributes.position;
    const cols = SEGS + 1;
    const verts: number[] = [], idxs: number[] = [];
    let base = 0;
    const edges = [
        (j: number) => j, (j: number) => SEGS * cols + j,
        (i: number) => i * cols, (i: number) => i * cols + SEGS,
    ];
    for (const fn of edges) {
        const sb = base;
        for (let t = 0; t < cols; t++) {
            const idx = fn(t);
            verts.push(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
            verts.push(pos.getX(idx), pos.getY(idx), -1);
        }
        for (let t = 0; t < cols - 1; t++) {
            const tl = sb + t * 2, bl = tl + 1, tr = tl + 2, br = tl + 3;
            idxs.push(tl, bl, tr, tr, bl, br);
        }
        base += cols * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idxs); g.computeVertexNormals();
    return g;
}

/* ================================================================
   FLOOD WATER SURFACE MESH
   Build a per-vertex water plane that only shows where terrain < waterLevel
   This creates realistic water filling valleys/streets, not a flat disc
   ================================================================ */
const WATER_SEGS = 180;

function createFloodWaterMesh(): { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform> } {
    const geom = new THREE.PlaneGeometry(SIZE, SIZE, WATER_SEGS, WATER_SEGS);
    const uniforms = {
        uWaterLevel: { value: 0.0 },
        uTime: { value: 0.0 },
        uOpacity: { value: 0.82 },
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

/** Update water geometry: per-vertex, only show where terrain is below water */
function updateFloodWater(
    waterGeom: THREE.PlaneGeometry,
    terrainHeights: number[],
    waterH: number,
    wsWx: number, wsWz: number, spread: number,
) {
    const pos = waterGeom.attributes.position;
    const cols = WATER_SEGS + 1;
    const tCols = SEGS + 1;
    for (let i = 0; i < pos.count; i++) {
        const gx = pos.getX(i), gy = pos.getY(i);
        // get terrain height at this water vertex
        const nx = (gx + SIZE / 2) / SIZE;
        const ny = (gy + SIZE / 2) / SIZE;
        const tix = Math.min(Math.max(Math.round(nx * SEGS), 0), SEGS);
        const tiy = Math.min(Math.max(Math.round(ny * SEGS), 0), SEGS);
        const tH = terrainHeights[tiy * tCols + tix] ?? 0;

        // world coords for distance check
        const wx = gx;
        const wz = -gy;
        const d = Math.hypot(wx - wsWx, wz - (-wsWz));

        // flood fill: water only where terrain is below water level AND within spread radius
        // Use smooth falloff at edges for natural look
        const inRange = d < spread;
        const underWater = tH < waterH && inRange;

        if (underWater) {
            // Place water at water level (above terrain)
            pos.setZ(i, waterH);
        } else {
            // Push underwater vertices far below to hide them
            pos.setZ(i, -100);
        }
    }
    pos.needsUpdate = true;
    waterGeom.computeVertexNormals();
}

/* ================================================================
   HEIGHT LOOKUP
   ================================================================ */
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

/* ================================================================
   INFRASTRUCTURE
   ================================================================ */
interface Building {
    wx: number; wz: number; elev: number;
    kind: 'residential' | 'commercial' | 'hospital' | 'school';
    pop: number;
    name?: string;
    floors?: number;
}
interface SafeZone { wx: number; wz: number; elev: number; label: string; cap: number }

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
        if (r > 0.92) { kind = 'hospital'; pop = 150 + Math.floor(rng() * 100); }
        else if (r > 0.85) { kind = 'school'; pop = 80 + Math.floor(rng() * 100); }
        else if (r > 0.60) { kind = 'commercial'; pop = 30 + Math.floor(rng() * 50); }
        buildings.push({ wx, wz, elev, kind, pop });
    }
    return buildings;
}

function mapRealBuildings(
    geoBuildings: GeoBuilding[],
    bbox: GeoElevation['bbox'],
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
                wx, wz, elev, kind: gb.type,
                pop: (popPerFloor[gb.type] ?? 4) * gb.floors + Math.floor(Math.random() * 10),
                name: gb.name, floors: gb.floors,
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
            if (e > bestE && !zones.some(zz => Math.hypot(zz.wx - wx, zz.wz - wz) < SIZE * 0.18))
                { bestE = e; bestWx = wx; bestWz = wz; }
        }
        if (bestE > MAX_H * 0.25)
            zones.push({ wx: bestWx, wz: bestWz, elev: bestE, label: labels[z], cap: 200 + Math.floor(rng() * 400) });
    }
    return zones;
}

/* ================================================================
   A* PATHFINDING
   ================================================================ */
const GRID = 50;

function computeEvacPaths(
    buildings: Building[], safeZones: SafeZone[],
    heights: number[], waterH: number, wsWx: number, wsWz: number, spread: number,
) {
    if (safeZones.length === 0 || spread < 1) return [];
    const cost = new Float32Array(GRID * GRID);
    for (let gz = 0; gz < GRID; gz++) for (let gx = 0; gx < GRID; gx++) {
        const wx = ((gx / (GRID - 1)) - 0.5) * SIZE;
        const wz = ((gz / (GRID - 1)) - 0.5) * SIZE;
        const e = heightAtWorld(heights, wx, wz);
        const d = Math.hypot(wx - wsWx, wz - wsWz);
        cost[gz * GRID + gx] = (d < spread && e < waterH) ? 1e6 : 1;
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
            for (let i = 1; i < open.length; i++)
                if (gScore[open[i]] + heur(open[i]) < gScore[open[bi]] + heur(open[bi])) bi = i;
            const cur = open[bi]; open.splice(bi, 1);
            if (closed[cur]) continue; closed[cur] = 1;
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
                if (g < gScore[ni]) { gScore[ni] = g; parent[ni] = cur; open.push(ni); }
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
            ci = parent[ci]; safe++;
        }
        return path;
    }
    const routes: { path: THREE.Vector3[]; from: Building; to: SafeZone; risk: 'safe' | 'caution' | 'danger'; dist: number }[] = [];
    for (const b of buildings) {
        const distToFlood = Math.hypot(b.wx - wsWx, b.wz - wsWz);
        const isFlooded = distToFlood < spread && b.elev < waterH;
        const isThreatened = distToFlood < spread * 1.5 && b.elev < waterH * 1.3;
        if (!isFlooded && !isThreatened) continue;
        let best: SafeZone | null = null, bestD = Infinity;
        for (const z of safeZones) { const d = Math.hypot(b.wx - z.wx, b.wz - z.wz); if (d < bestD) { bestD = d; best = z; } }
        if (!best) continue;
        const path = astar(b.wx, b.wz, best.wx, best.wz);
        if (path.length < 2) continue;
        let maxProx = 0;
        for (const pt of path) { const d = Math.hypot(pt.x - wsWx, pt.z - wsWz); if (spread > 0) maxProx = Math.max(maxProx, 1 - d / spread); }
        const risk: 'safe' | 'caution' | 'danger' = maxProx > 0.7 ? 'danger' : maxProx > 0.35 ? 'caution' : 'safe';
        const dist = path.reduce((s, p, i) => i === 0 ? 0 : s + p.distanceTo(path[i - 1]), 0);
        routes.push({ path, from: b, to: best, risk, dist });
    }
    return routes;
}

/* ================================================================
   CAMERA PRESETS
   ================================================================ */
type ViewMode = 'perspective' | 'oblique' | 'top';

const VIEW_PRESETS: Record<ViewMode, { pos: [number, number, number]; target: [number, number, number]; fov: number }> = {
    perspective: { pos: [65, 55, 65], target: [0, 5, 0], fov: 45 },
    oblique: { pos: [40, 30, 55], target: [0, 3, -5], fov: 35 },
    top: { pos: [0, 90, 0.1], target: [0, 0, 0], fov: 50 },
};

/* ================================================================
   COMPONENT
   ================================================================ */
const B_BASE_COLORS: Record<string, number> = {
    residential: 0xd8d0c8, commercial: 0xc0c8d4, hospital: 0xebe5de, school: 0xd4c8a0,
};

export type { ViewMode };

export interface FloodTerrainViewProps {
    floodLevel: number;
    aoiCoordinates?: number[][] | null;
    waterSource?: number[] | null;
    showMesh: boolean;
    showEvacRoutes: boolean;
    showBuildings: boolean;
    geoData?: GeoData | null;
    viewMode?: ViewMode;
}

export default function FloodTerrainView({
    floodLevel, aoiCoordinates, waterSource, showMesh, showEvacRoutes, showBuildings, geoData, viewMode = 'perspective',
}: FloodTerrainViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const stateRef = useRef<{
        renderer: THREE.WebGLRenderer; scene: THREE.Scene;
        camera: THREE.PerspectiveCamera; controls: any; animId: number;
        waterMesh: THREE.Mesh; waterUniforms: Record<string, THREE.IUniform>;
        overlay: THREE.Mesh; wire: THREE.LineSegments; marker: THREE.Mesh;
        heights: number[]; maxH: number; minH: number; geom: THREE.PlaneGeometry;
        buildingsGroup: THREE.Group; roadsGroup: THREE.Group;
        safeZonesGroup: THREE.Group; evacGroup: THREE.Group;
        buildingData: Building[]; safeZoneData: SafeZone[];
    } | null>(null);

    const [impactStats, setImpactStats] = useState({
        affectedBuildings: 0, affectedPop: 0, floodedArea: 0,
        safeRoutes: 0, cautionRoutes: 0, dangerRoutes: 0, totalRoutes: 0, priorityEvac: 0,
    });

    const [dataInfo, setDataInfo] = useState({
        elevSrc: '', bldgSrc: '', bldgCount: 0,
        realElevMin: 0, realElevMax: 0, vertExag: 0,
    });

    const wsNorm = useMemo<[number, number]>(() => {
        if (!aoiCoordinates || aoiCoordinates.length < 4 || !waterSource) return [0.5, 0.5];
        const pts = aoiCoordinates.slice(0, -1);
        let mnX = pts[0][0], mxX = pts[0][0], mnY = pts[0][1], mxY = pts[0][1];
        pts.forEach(([x, y]) => { mnX = Math.min(mnX, x); mxX = Math.max(mxX, x); mnY = Math.min(mnY, y); mxY = Math.max(mxY, y); });
        return [
            mxX > mnX ? (waterSource[0] - mnX) / (mxX - mnX) : 0.5,
            mxY > mnY ? (waterSource[1] - mnY) / (mxY - mnY) : 0.5,
        ];
    }, [aoiCoordinates, waterSource]);

    const areaKm2 = useMemo(() => {
        if (!aoiCoordinates || aoiCoordinates.length < 4) return 0;
        const pts = aoiCoordinates.slice(0, -1);
        let a = 0;
        for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; }
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
        // smooth transition
        const startPos = camera.position.clone();
        const endPos = new THREE.Vector3(...preset.pos);
        const endTarget = new THREE.Vector3(...preset.target);
        const startFov = camera.fov;
        const endFov = preset.fov;
        let t = 0;
        const dur = 600;
        const startTime = performance.now();
        function animate() {
            t = Math.min((performance.now() - startTime) / dur, 1);
            const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
            camera.position.lerpVectors(startPos, endPos, ease);
            camera.fov = startFov + (endFov - startFov) * ease;
            camera.updateProjectionMatrix();
            if (controls) {
                controls.target.copy(endTarget);
                controls.update();
            }
            if (t < 1) requestAnimationFrame(animate);
        }
        animate();
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
        el.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x87ceeb);
        scene.fog = new THREE.FogExp2(0x87ceeb, 0.004);

        const preset = VIEW_PRESETS[viewMode];
        const camera = new THREE.PerspectiveCamera(preset.fov, w / h, 0.1, 500);
        camera.position.set(...preset.pos);
        camera.lookAt(...preset.target);

        // Lighting — brighter, more natural
        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        scene.add(new THREE.HemisphereLight(0x87ceeb, 0x556b2f, 0.5));
        const sun = new THREE.DirectionalLight(0xfff5e6, 1.8);
        sun.position.set(50, 70, 40);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        const sc = sun.shadow.camera; sc.left = sc.bottom = -60; sc.right = sc.top = 60;
        scene.add(sun);
        scene.add(new THREE.DirectionalLight(0x88aaff, 0.3).translateX(-30).translateY(30));

        /* ---- TERRAIN ---- */
        const useRealElev = !!geoData?.elevation;
        const { geometry: geom, heights, maxH, minH } = useRealElev
            ? generateTerrainFromReal(geoData!.elevation!, aoiCoordinates)
            : generateTerrainProcedural(aoiCoordinates);

        const terrainMesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
            vertexColors: true, roughness: 0.75, metalness: 0.02, flatShading: false, side: THREE.DoubleSide,
        }));
        terrainMesh.rotation.x = -Math.PI / 2;
        terrainMesh.receiveShadow = true; terrainMesh.castShadow = true;
        scene.add(terrainMesh);

        const sideMesh = new THREE.Mesh(buildSides(geom), new THREE.MeshStandardMaterial({
            color: 0x8b7355, roughness: 0.9, side: THREE.DoubleSide,
        }));
        sideMesh.rotation.x = -Math.PI / 2; sideMesh.castShadow = true;
        scene.add(sideMesh);

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(SIZE + 40, SIZE + 40),
            new THREE.MeshStandardMaterial({ color: 0x3a5a3a }),
        );
        ground.rotation.x = -Math.PI / 2; ground.position.y = -1; ground.receiveShadow = true;
        scene.add(ground);

        /* ---- REALISTIC WATER (shader-based, per-vertex flood fill) ---- */
        const { mesh: waterMesh, uniforms: waterUniforms } = createFloodWaterMesh();
        scene.add(waterMesh);

        /* ---- Risk overlay on terrain (red/yellow/green zones) ---- */
        const overlayGeom = geom.clone();
        overlayGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count * 3), 3));
        const overlay = new THREE.Mesh(overlayGeom, new THREE.MeshBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
        }));
        overlay.rotation.x = -Math.PI / 2; overlay.position.y = 0.18; overlay.visible = false;
        scene.add(overlay);

        // wireframe
        const wire = new THREE.LineSegments(
            new THREE.WireframeGeometry(geom),
            new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.13 }),
        );
        wire.rotation.x = -Math.PI / 2; wire.position.y = 0.12;
        scene.add(wire);

        // water source marker
        const marker = new THREE.Mesh(
            new THREE.SphereGeometry(1.0, 16, 16),
            new THREE.MeshStandardMaterial({ color: 0x2563eb, emissive: 0x3b82f6, emissiveIntensity: 0.9 }),
        );
        marker.position.set(0, maxH + 3, 0);
        scene.add(marker);

        /* ---- BUILDINGS ---- */
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

            // ArcGIS-like: mostly white/light gray buildings, compact footprints
            const footW = b.kind === 'commercial' ? 1.5 + rng() * 0.8 : b.kind === 'hospital' ? 2.2 : b.kind === 'school' ? 2.5 : 0.9 + rng() * 0.6;
            const footD = b.kind === 'school' ? 1.4 : b.kind === 'hospital' ? 1.8 : footW * (0.6 + rng() * 0.5);
            const floors = b.floors ?? (b.kind === 'commercial' ? 3 + Math.floor(rng() * 5) : b.kind === 'hospital' ? 3 + Math.floor(rng() * 2) : b.kind === 'school' ? 2 : 1 + Math.floor(rng() * 3));
            const floorH = 0.5;
            const bh = floors * floorH;

            // White/light gray base (like reference image)
            const baseColor = B_BASE_COLORS[b.kind] ?? 0xcccccc;
            const baseMat = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.4, metalness: 0.05 });
            const baseMesh = new THREE.Mesh(new THREE.BoxGeometry(footW, bh, footD), baseMat);
            baseMesh.position.y = bh / 2; baseMesh.castShadow = true; baseMesh.receiveShadow = true;
            group.add(baseMesh);

            // window strips
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

            // flat roof with slight edge (ArcGIS style)
            const roofSlab = new THREE.Mesh(
                new THREE.BoxGeometry(footW + 0.08, 0.08, footD + 0.08),
                new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.6 }),
            );
            roofSlab.position.y = bh + 0.04; roofSlab.receiveShadow = true;
            group.add(roofSlab);

            // hospital cross
            if (b.kind === 'hospital') {
                const crossMat = new THREE.MeshStandardMaterial({ color: 0xdd2222, emissive: 0xdd2222, emissiveIntensity: 0.3 });
                const ch1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.8, 0.3), crossMat);
                ch1.position.set(footW / 2 + 0.07, bh * 0.65, 0); group.add(ch1);
                const ch2 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.8), crossMat);
                ch2.position.set(footW / 2 + 0.07, bh * 0.65, 0); group.add(ch2);
            }

            // labels (only for critical buildings)
            if (b.kind === 'hospital' || b.kind === 'school' || b.name) {
                const icon = b.kind === 'hospital' ? '🏥' : b.kind === 'school' ? '🏫' : '🏢';
                const text = b.name ? `${icon} ${b.name}` : `${icon} ${b.kind.charAt(0).toUpperCase() + b.kind.slice(1)}`;
                const lbl = createTextSprite(text, {
                    fontSize: 16,
                    color: b.kind === 'hospital' ? '#ff8888' : b.kind === 'school' ? '#ffdd66' : '#aaccff',
                });
                lbl.position.set(0, bh + 2.0, 0); group.add(lbl);
            }

            group.position.set(b.wx, b.elev, b.wz);
            group.userData = { baseMesh, kind: b.kind, baseColor };
            buildingsGroup.add(group);
        }
        scene.add(buildingsGroup);

        /* ---- ROADS ---- */
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

        /* ---- SAFE ZONES ---- */
        const safeZoneData = generateSafeZones(heights, aoiSeedVal);
        const safeZonesGroup = new THREE.Group();
        for (const z of safeZoneData) {
            const pole = new THREE.Mesh(
                new THREE.CylinderGeometry(0.12, 0.12, 3.5, 8),
                new THREE.MeshStandardMaterial({ color: 0x00dd44, emissive: 0x00dd44, emissiveIntensity: 0.3 }),
            );
            pole.position.set(z.wx, z.elev + 1.75, z.wz); safeZonesGroup.add(pole);
            const flag = new THREE.Mesh(
                new THREE.PlaneGeometry(1.6, 0.8),
                new THREE.MeshStandardMaterial({ color: 0x00ff44, emissive: 0x00ff44, emissiveIntensity: 0.3, side: THREE.DoubleSide }),
            );
            flag.position.set(z.wx + 0.8, z.elev + 3.0, z.wz); safeZonesGroup.add(flag);
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(2.5, 0.15, 8, 32),
                new THREE.MeshStandardMaterial({ color: 0x00ff44, transparent: true, opacity: 0.25, emissive: 0x00ff44, emissiveIntensity: 0.2 }),
            );
            ring.rotation.x = -Math.PI / 2; ring.position.set(z.wx, z.elev + 0.2, z.wz);
            safeZonesGroup.add(ring);
            const lbl = createTextSprite(`🏁 ${z.label} (${z.cap})`, {
                fontSize: 16, color: '#88ff88', bgColor: 'rgba(0,30,0,0.88)', borderColor: 'rgba(0,255,68,0.3)',
            });
            lbl.position.set(z.wx, z.elev + 4.5, z.wz); safeZonesGroup.add(lbl);
        }
        scene.add(safeZonesGroup);

        const evacGroup = new THREE.Group();
        scene.add(evacGroup);

        /* ---- DATA INFO ---- */
        const elevRange = geoData?.elevation ? Math.max(geoData.elevation.max - geoData.elevation.min, 0.5) : 0;
        setDataInfo({
            elevSrc: useRealElev ? 'Open-Meteo SRTM' : 'Simulated (procedural)',
            bldgSrc: useRealBldg ? 'OpenStreetMap' : 'Simulated (procedural)',
            bldgCount: buildingData.length,
            realElevMin: useRealElev ? Math.round(geoData!.elevation!.min) : 0,
            realElevMax: useRealElev ? Math.round(geoData!.elevation!.max) : 0,
            vertExag: useRealElev ? +(MAX_H / elevRange).toFixed(1) : 0,
        });

        /* ---- CONTROLS ---- */
        let controls: any = null;
        import('three/examples/jsm/controls/OrbitControls.js').then(mod => {
            controls = new mod.OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true; controls.dampingFactor = 0.08;
            controls.minDistance = 10; controls.maxDistance = 180;
            controls.maxPolarAngle = Math.PI / 2 - 0.02;
            controls.target.set(...preset.target); controls.update();
            if (stateRef.current) stateRef.current.controls = controls;
        });

        stateRef.current = {
            renderer, scene, camera, controls, animId: 0,
            waterMesh, waterUniforms,
            overlay, wire, marker, heights, maxH, minH, geom,
            buildingsGroup, roadsGroup, safeZonesGroup, evacGroup,
            buildingData, safeZoneData,
        };

        const clock = new THREE.Clock();
        function loop() {
            stateRef.current!.animId = requestAnimationFrame(loop);
            controls?.update();
            const t = clock.getElapsedTime();
            // Update water shader time for ripples
            waterUniforms.uTime.value = t;
            // Safe zone animation
            safeZonesGroup.children.forEach(child => {
                if ((child as THREE.Mesh).geometry instanceof THREE.TorusGeometry) child.rotation.z = t * 0.4;
            });
            // Evac glow
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
            camera.aspect = rw / rh; camera.updateProjectionMatrix();
            renderer.setSize(rw, rh);
        };
        window.addEventListener('resize', onResize);

        return () => {
            cancelAnimationFrame(stateRef.current?.animId ?? 0);
            window.removeEventListener('resize', onResize);
            controls?.dispose(); renderer.dispose();
            if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
            stateRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [aoiCoordinates, geoData]);

    /* ======== DYNAMIC UPDATE ======== */
    useEffect(() => {
        const s = stateRef.current;
        if (!s) return;
        const { waterMesh, waterUniforms, overlay, wire, marker, heights, maxH, geom,
            buildingsGroup, roadsGroup, safeZonesGroup, evacGroup,
            buildingData, safeZoneData } = s;

        const waterH = (floodLevel / 20) * maxH * 0.85;
        const show = floodLevel > 0.3;
        const wsWx = (wsNorm[0] - 0.5) * SIZE;
        const wsWz = -(wsNorm[1] - 0.5) * SIZE;
        const spread = (floodLevel / 20) * SIZE * 0.8;

        // ---- REALISTIC WATER: fill valleys/streets with depth-based water ----
        waterMesh.visible = show;
        if (show) {
            waterUniforms.uWaterLevel.value = waterH;
            updateFloodWater(
                waterMesh.geometry as THREE.PlaneGeometry,
                heights, waterH, wsWx, wsWz, spread,
            );
        }

        // ---- Risk overlay ----
        overlay.visible = show;
        if (show) {
            const pos = geom.attributes.position;
            const ca = overlay.geometry.attributes.color as THREE.BufferAttribute;
            const arr = ca.array as Float32Array;
            const gsx = wsWx, gsy = -wsWz;
            for (let i = 0; i < pos.count; i++) {
                const dx = pos.getX(i) - gsx, dy = pos.getY(i) - gsy;
                const d = Math.sqrt(dx * dx + dy * dy);
                const under = heights[i] <= waterH && d <= spread;
                if (under) {
                    // ArcGIS-style: flooded areas tinted blue-red, not bright colored
                    const depthRatio = Math.min((waterH - heights[i]) / (maxH * 0.3), 1);
                    if (depthRatio > 0.6) { arr[i * 3] = 0.8; arr[i * 3 + 1] = 0.1; arr[i * 3 + 2] = 0.1; } // deep = red
                    else if (depthRatio > 0.25) { arr[i * 3] = 0.8; arr[i * 3 + 1] = 0.5; arr[i * 3 + 2] = 0.1; } // medium = orange
                    else { arr[i * 3] = 0.2; arr[i * 3 + 1] = 0.3; arr[i * 3 + 2] = 0.7; } // shallow = blue tint
                } else { arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = 0; }
            }
            ca.needsUpdate = true;
        }

        wire.visible = showMesh;
        marker.position.set(wsWx, maxH + 3, wsWz);
        buildingsGroup.visible = showBuildings;
        roadsGroup.visible = showBuildings;
        safeZonesGroup.visible = showEvacRoutes;

        // ---- Building impact: flooded buildings turn RED (like reference) ----
        buildingsGroup.children.forEach((grp, idx) => {
            if (idx >= buildingData.length) return;
            const bld = buildingData[idx];
            const ud = (grp as THREE.Group).userData;
            const bm = ud?.baseMesh as THREE.Mesh | undefined;
            if (!bm) return;
            const mat = bm.material as THREE.MeshStandardMaterial;
            const d = Math.hypot(bld.wx - wsWx, bld.wz - wsWz);
            if (show && d < spread && bld.elev < waterH) {
                // Flooded = bright red (like reference ArcGIS image)
                mat.color.setHex(0xdd1111);
                mat.emissive.setHex(0xcc0000);
                mat.emissiveIntensity = 0.5;
            } else if (show && d < spread * 1.3 && bld.elev < waterH * 1.2) {
                // At-risk = orange
                mat.color.setHex(0xff6600);
                mat.emissive.setHex(0xff4400);
                mat.emissiveIntensity = 0.25;
            } else {
                mat.color.setHex(ud?.baseColor ?? 0xcccccc);
                mat.emissive.setHex(0x000000);
                mat.emissiveIntensity = 0;
            }
        });

        // ---- Evacuation routes ----
        while (evacGroup.children.length) {
            const c = evacGroup.children[0]; evacGroup.remove(c);
            if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose();
        }
        if (showEvacRoutes && show) {
            const routes = computeEvacPaths(buildingData, safeZoneData, heights, waterH, wsWx, wsWz, spread);
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
                    cone.position.copy(pt); cone.lookAt(pt.clone().add(tan)); cone.rotateX(Math.PI / 2);
                    evacGroup.add(cone);
                }
                evacGroup.add(new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8),
                    new THREE.MeshStandardMaterial({ color: 0xff4444, emissive: 0xff4444, emissiveIntensity: 0.5 }))
                    .translateX(route.path[0].x).translateY(route.path[0].y).translateZ(route.path[0].z));
                evacGroup.add(new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8),
                    new THREE.MeshStandardMaterial({ color: 0x00ff44, emissive: 0x00ff44, emissiveIntensity: 0.5 }))
                    .translateX(route.path[route.path.length - 1].x).translateY(route.path[route.path.length - 1].y).translateZ(route.path[route.path.length - 1].z));
            }
            let affBld = 0, affPop = 0, priorityEvac = 0;
            for (const bld of buildingData) {
                const d = Math.hypot(bld.wx - wsWx, bld.wz - wsWz);
                if (d < spread && bld.elev < waterH) { affBld++; affPop += bld.pop; if (bld.kind === 'hospital' || bld.kind === 'school') priorityEvac++; }
            }
            setImpactStats({
                affectedBuildings: affBld, affectedPop: affPop,
                floodedArea: Math.round(Math.PI * (spread * spread) * 0.01),
                safeRoutes: routes.filter(r => r.risk === 'safe').length,
                cautionRoutes: routes.filter(r => r.risk === 'caution').length,
                dangerRoutes: routes.filter(r => r.risk === 'danger').length,
                totalRoutes: routes.length, priorityEvac,
            });
        } else {
            setImpactStats({ affectedBuildings: 0, affectedPop: 0, floodedArea: 0, safeRoutes: 0, cautionRoutes: 0, dangerRoutes: 0, totalRoutes: 0, priorityEvac: 0 });
        }
    }, [floodLevel, showMesh, wsNorm, showEvacRoutes, showBuildings]);

    /* ======== HUD ======== */
    const waterHeight = (floodLevel * 2.5).toFixed(1);
    const riskLabel = floodLevel > 15 ? 'EXTREME' : floodLevel > 10 ? 'HIGH' : floodLevel > 6 ? 'MODERATE' : 'LOW';
    const riskColor = floodLevel > 15 ? '#ef4444' : floodLevel > 10 ? '#f59e0b' : floodLevel > 6 ? '#facc15' : '#34d399';
    const riskIcon = floodLevel > 15 ? '🔴' : floodLevel > 10 ? '🟠' : floodLevel > 6 ? '🟡' : '🟢';

    return (
        <div ref={containerRef} style={{ position: 'absolute', inset: 0, background: '#0f172a' }}>
            {/* INFO BAR */}
            <div style={{
                position: 'absolute', top: '1rem', left: '50%', transform: 'translateX(-50%)', zIndex: 10,
                background: 'rgba(15,23,42,0.92)', backdropFilter: 'blur(12px)',
                padding: '0.75rem 1.5rem', borderRadius: '10px',
                border: `1px solid ${floodLevel > 10 ? 'rgba(239,68,68,0.4)' : 'rgba(56,189,248,0.3)'}`,
                color: '#f8fafc', display: 'flex', gap: '1.5rem', alignItems: 'center',
                fontSize: '0.75rem', fontFamily: 'monospace',
            }}>
                {[
                    { label: 'Area', value: `${areaKm2.toFixed(2)} km²`, color: '#38bdf8' },
                    { label: 'Water', value: `${waterHeight}m`, color: floodLevel > 10 ? '#f59e0b' : '#38bdf8' },
                    { label: 'Spread', value: `${(Math.min(floodLevel / 20, 1) * 100).toFixed(0)}%`, color: '#f8fafc' },
                    { label: 'Risk', value: `${riskIcon} ${riskLabel}`, color: riskColor },
                ].map(({ label, value, color }, idx) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                        {idx > 0 && <div style={{ width: 1, height: 28, background: 'rgba(255,255,255,0.1)' }} />}
                        <div>
                            <div style={{ color: '#64748b', fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</div>
                            <div style={{ fontSize: '1rem', fontWeight: 700, color }}>{value}</div>
                        </div>
                    </div>
                ))}
            </div>

            {/* DATA SOURCES BADGE */}
            <div style={{
                position: 'absolute', bottom: '1rem', left: '1rem', zIndex: 10,
                background: 'rgba(15,23,42,0.94)', backdropFilter: 'blur(12px)',
                padding: '0.7rem 0.9rem', borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.6rem',
                fontFamily: 'monospace', color: '#94a3b8',
            }}>
                <div style={{ fontSize: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#64748b', marginBottom: '0.4rem', fontWeight: 700 }}>
                    Data Sources
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.25rem' }}>
                    <span style={{ color: dataInfo.elevSrc.includes('SRTM') ? '#34d399' : '#f59e0b' }}>
                        {dataInfo.elevSrc.includes('SRTM') ? '📡' : '⚠️'}
                    </span>
                    <span>Elevation: <b style={{ color: dataInfo.elevSrc.includes('SRTM') ? '#34d399' : '#fbbf24' }}>{dataInfo.elevSrc}</b></span>
                </div>
                {dataInfo.realElevMin !== 0 || dataInfo.realElevMax !== 0 ? (
                    <div style={{ marginLeft: '1.2rem', marginBottom: '0.25rem', fontSize: '0.55rem', color: '#64748b' }}>
                        Range: {dataInfo.realElevMin}m – {dataInfo.realElevMax}m
                        {dataInfo.vertExag > 1.5 && <span> · Vert. exaggeration: ×{dataInfo.vertExag}</span>}
                    </div>
                ) : null}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.15rem' }}>
                    <span style={{ color: dataInfo.bldgSrc.includes('OpenStreetMap') ? '#34d399' : '#f59e0b' }}>
                        {dataInfo.bldgSrc.includes('OpenStreetMap') ? '🏗️' : '⚠️'}
                    </span>
                    <span>Buildings: <b style={{ color: dataInfo.bldgSrc.includes('OpenStreetMap') ? '#34d399' : '#fbbf24' }}>{dataInfo.bldgSrc}</b></span>
                </div>
                <div style={{ marginLeft: '1.2rem', fontSize: '0.55rem', color: '#64748b' }}>
                    {dataInfo.bldgCount} structures {dataInfo.bldgSrc.includes('OpenStreetMap') ? 'found' : 'generated'}
                </div>
            </div>

            {/* EVACUATION GUIDE */}
            {showEvacRoutes && (
                <div style={{
                    position: 'absolute', top: '5rem', right: '1rem', zIndex: 10,
                    background: 'rgba(15,23,42,0.94)', backdropFilter: 'blur(12px)',
                    padding: '1rem', borderRadius: '10px', maxWidth: '260px',
                    border: '1px solid rgba(0,255,68,0.2)',
                    color: '#e2e8f0', fontSize: '0.68rem', fontFamily: 'system-ui, sans-serif', lineHeight: 1.6,
                }}>
                    <div style={{ fontWeight: 700, fontSize: '0.78rem', marginBottom: '0.5rem', color: '#00ff88', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        📋 How to Read Evacuation Routes
                    </div>
                    <p style={{ color: '#94a3b8', marginBottom: '0.5rem' }}>
                        Each <b style={{ color: '#e2e8f0' }}>glowing tube</b> = an escape path
                        from a <b style={{ color: '#ff6b6b' }}>threatened building</b> to
                        the <b style={{ color: '#00ff88' }}>nearest safe zone</b> on high ground.
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginBottom: '0.5rem' }}>
                        {[
                            { bg: '#00ff44', label: 'Safe', desc: '— clear path, no flood' },
                            { bg: '#ffaa00', label: 'Caution', desc: '— passes near flood' },
                            { bg: '#ff4444', label: 'Danger', desc: '— route near/through flood' },
                        ].map(r => (
                            <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <div style={{ width: 28, height: 4, borderRadius: 2, background: r.bg }} />
                                <span><b style={{ color: r.bg }}>{r.label}</b> {r.desc}</span>
                            </div>
                        ))}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.62rem', color: '#64748b' }}>
                        <span>▶ <b>Arrow cones</b> = walk direction</span>
                        <span>🔴 <b>Red dot</b> = at-risk building (start)</span>
                        <span>🟢 <b>Green dot</b> = safe zone (destination)</span>
                        <span>⚡ Routes reroute dynamically as water rises</span>
                    </div>
                </div>
            )}

            {/* IMPACT PANEL */}
            {showEvacRoutes && floodLevel > 0.3 && (
                <div style={{
                    position: 'absolute', bottom: '5rem', left: '50%', transform: 'translateX(-50%)', zIndex: 10,
                    background: 'rgba(15,23,42,0.94)', backdropFilter: 'blur(12px)',
                    padding: '1rem 1.5rem', borderRadius: '12px',
                    border: '1px solid rgba(255,68,68,0.25)',
                    color: '#f8fafc', fontSize: '0.7rem', fontFamily: 'monospace',
                    display: 'flex', gap: '1.2rem', alignItems: 'flex-start',
                }}>
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ color: '#64748b', fontSize: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Buildings</div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#ff6b6b' }}>{impactStats.affectedBuildings}</div>
                        <div style={{ color: '#94a3b8', fontSize: '0.52rem' }}>flooded</div>
                    </div>
                    <div style={{ width: 1, height: 44, background: 'rgba(255,255,255,0.08)' }} />
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ color: '#64748b', fontSize: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>People</div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#ff8888' }}>{impactStats.affectedPop}</div>
                        <div style={{ color: '#94a3b8', fontSize: '0.52rem' }}>at risk</div>
                    </div>
                    {impactStats.priorityEvac > 0 && (<>
                        <div style={{ width: 1, height: 44, background: 'rgba(255,255,255,0.08)' }} />
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ color: '#64748b', fontSize: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Priority</div>
                            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#ff4444' }}>{impactStats.priorityEvac}</div>
                            <div style={{ color: '#94a3b8', fontSize: '0.52rem' }}>🏥🏫 critical</div>
                        </div>
                    </>)}
                    <div style={{ width: 1, height: 44, background: 'rgba(255,255,255,0.08)' }} />
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ color: '#64748b', fontSize: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Routes</div>
                        <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.25rem', fontSize: '0.72rem' }}>
                            <span style={{ color: '#00ff44' }}>✓{impactStats.safeRoutes}</span>
                            <span style={{ color: '#ffaa00' }}>⚠{impactStats.cautionRoutes}</span>
                            <span style={{ color: '#ff4444' }}>✗{impactStats.dangerRoutes}</span>
                        </div>
                        <div style={{ color: '#94a3b8', fontSize: '0.48rem', marginTop: '0.15rem' }}>{impactStats.totalRoutes} total</div>
                    </div>
                </div>
            )}

            {/* LEGEND */}
            <div style={{
                position: 'absolute', bottom: '1rem', right: '1rem', zIndex: 10,
                background: 'rgba(15,23,42,0.92)', backdropFilter: 'blur(12px)',
                padding: '0.75rem 1rem', borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.65rem',
            }}>
                <div style={{ color: '#64748b', fontSize: '0.55rem', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.4rem' }}>Legend</div>
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
                    <div key={l} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.2rem' }}>
                        <div style={{ width: 20, height: 8, borderRadius: 2, background: c, flexShrink: 0 }} />
                        <span style={{ color: t }}>{l}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
