/**
 * Real geographic data fetching:
 * - Elevation grid from Open-Meteo (SRTM 90m DEM)
 * - Building footprints from OpenStreetMap (Overpass API)
 */

export interface GeoElevation {
    grid: number[][];   // [row][col] — real elevation in meters
    rows: number;
    cols: number;
    min: number;        // min elevation (meters)
    max: number;        // max elevation (meters)
    bbox: { south: number; west: number; north: number; east: number };
}

export interface GeoBuilding {
    lat: number;
    lng: number;
    type: 'residential' | 'commercial' | 'hospital' | 'school';
    floors: number;
    name?: string;
}

export interface GeoData {
    elevation: GeoElevation | null;
    buildings: GeoBuilding[];
}

const ELEV_GRID = 25; // 25×25 = 625 sample points

export async function fetchGeoData(aoiCoords: number[][] | null | undefined): Promise<GeoData> {
    if (!aoiCoords || aoiCoords.length < 4) return { elevation: null, buildings: [] };
    const pts = aoiCoords.slice(0, -1);
    const bbox = {
        south: Math.min(...pts.map(p => p[1])),
        north: Math.max(...pts.map(p => p[1])),
        west: Math.min(...pts.map(p => p[0])),
        east: Math.max(...pts.map(p => p[0])),
    };
    const [elev, bldg] = await Promise.allSettled([
        fetchElevation(bbox),
        fetchBuildings(bbox),
    ]);
    return {
        elevation: elev.status === 'fulfilled' ? elev.value : null,
        buildings: bldg.status === 'fulfilled' ? bldg.value : [],
    };
}

/* ---- Elevation from Open-Meteo (SRTM 90m) ---- */
async function fetchElevation(bbox: GeoElevation['bbox']): Promise<GeoElevation> {
    const rows = ELEV_GRID, cols = ELEV_GRID;
    const lats: number[] = [], lngs: number[] = [];
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
            lats.push(+(bbox.south + (bbox.north - bbox.south) * r / (rows - 1)).toFixed(6));
            lngs.push(+(bbox.west + (bbox.east - bbox.west) * c / (cols - 1)).toFixed(6));
        }

    // Batch into groups of ~100 to stay within URL length limits
    const batch = 100;
    const promises: Promise<number[]>[] = [];
    for (let i = 0; i < lats.length; i += batch) {
        const bLat = lats.slice(i, i + batch).join(',');
        const bLng = lngs.slice(i, i + batch).join(',');
        promises.push(
            fetch(`https://api.open-meteo.com/v1/elevation?latitude=${bLat}&longitude=${bLng}`, {
                signal: AbortSignal.timeout(10000),
            })
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
                .then(d => d.elevation as number[])
        );
    }
    const chunks = await Promise.all(promises);
    const all = chunks.flat();

    let min = Infinity, max = -Infinity;
    const grid: number[][] = [];
    for (let r = 0; r < rows; r++) {
        const row: number[] = [];
        for (let c = 0; c < cols; c++) {
            let e = all[r * cols + c] ?? 0;
            if (!isFinite(e)) e = 0;
            row.push(e);
            min = Math.min(min, e);
            max = Math.max(max, e);
        }
        grid.push(row);
    }
    return { grid, rows, cols, min, max, bbox };
}

/* ---- Buildings from OpenStreetMap (Overpass API) ---- */
async function fetchBuildings(bbox: GeoElevation['bbox']): Promise<GeoBuilding[]> {
    const q = `[out:json][timeout:12];(way["building"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out center qt 120;`;
    const resp = await fetch(
        `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`,
        { signal: AbortSignal.timeout(15000) },
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    return (data.elements ?? [])
        .filter((el: any) => el.center?.lat && el.center?.lon)
        .map((el: any) => {
            const t = el.tags ?? {};
            const bt = t.building ?? '';
            const am = t.amenity ?? '';
            let type: GeoBuilding['type'] = 'residential';
            if (am === 'hospital' || bt === 'hospital') type = 'hospital';
            else if (['school', 'university', 'college'].includes(am) || bt === 'school') type = 'school';
            else if (['commercial', 'retail', 'office', 'industrial', 'warehouse', 'supermarket'].includes(bt)) type = 'commercial';
            return {
                lat: el.center.lat as number,
                lng: el.center.lon as number,
                type,
                floors: parseInt(t['building:levels']) || (type === 'commercial' ? 3 : type === 'hospital' ? 4 : type === 'school' ? 2 : 1),
                name: t.name as string | undefined,
            };
        });
}
