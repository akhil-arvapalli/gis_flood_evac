'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPin, Pentagon, Trash2, ArrowRight, Search, Waves } from 'lucide-react';

interface AOISelectorProps {
    onAOISelected: (coordinates: number[][], waterSource: number[]) => void;
}

type DrawStep = 'idle' | 'drawing-polygon' | 'placing-source' | 'ready';

export default function AOISelector({ onAOISelected }: AOISelectorProps) {
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<any>(null);
    const polygonLayerRef = useRef<any>(null);
    const [step, setStep] = useState<DrawStep>('idle');
    const [polygon, setPolygon] = useState<number[][]>([]);
    const [waterSource, setWaterSource] = useState<number[] | null>(null);
    const [searchQuery, setSearchQuery] = useState('');

    // Refs to hold stable handler references and mutable polygon data
    const polygonRef = useRef<number[][]>([]);
    const polygonHandlerRef = useRef<((e: any) => void) | null>(null);
    const sourceHandlerRef = useRef<((e: any) => void) | null>(null);

    useEffect(() => {
        if (!mapContainerRef.current || mapRef.current) return;

        import('leaflet').then((L) => {
            delete (L.Icon.Default.prototype as any)._getIconUrl;
            L.Icon.Default.mergeOptions({
                iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
                iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
            });

            const map = L.map(mapContainerRef.current!, { center: [20, 78], zoom: 5, zoomControl: true });
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19,
            }).addTo(map);

            polygonLayerRef.current = L.layerGroup().addTo(map);
            mapRef.current = map;
        });

        return () => {
            if (mapRef.current) {
                // Clean up all handlers before destroying the map
                if (polygonHandlerRef.current) mapRef.current.off('click', polygonHandlerRef.current);
                if (sourceHandlerRef.current) mapRef.current.off('click', sourceHandlerRef.current);
                mapRef.current.remove();
                mapRef.current = null;
            }
        };
    }, []);

    const searchLocation = async () => {
        if (!searchQuery.trim() || !mapRef.current) return;
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`);
            const data = await res.json();
            if (data?.[0]) mapRef.current.setView([parseFloat(data[0].lat), parseFloat(data[0].lon)], 14);
        } catch (err) { console.error('Search failed:', err); }
    };

    const clearLayers = () => { if (polygonLayerRef.current) polygonLayerRef.current.clearLayers(); };

    const drawOnMap = (points: number[][], source: number[] | null) => {
        import('leaflet').then((L) => {
            clearLayers();
            if (!polygonLayerRef.current) return;

            // Draw polygon vertices
            points.forEach(([lng, lat], i) => {
                L.circleMarker([lat, lng], {
                    radius: 7, fillColor: i === 0 ? '#34d399' : '#38bdf8',
                    color: '#fff', weight: 2, fillOpacity: 1
                }).addTo(polygonLayerRef.current);
            });

            // Draw polygon
            if (points.length >= 3) {
                L.polygon(points.map(([lng, lat]) => [lat, lng] as [number, number]), {
                    color: '#38bdf8', fillColor: '#38bdf8', fillOpacity: 0.15, weight: 2, dashArray: '6'
                }).addTo(polygonLayerRef.current);
            }
            if (points.length >= 2) {
                L.polyline(points.map(([lng, lat]) => [lat, lng] as [number, number]), {
                    color: '#38bdf8', weight: 2, opacity: 0.7
                }).addTo(polygonLayerRef.current);
            }

            // Draw water source
            if (source) {
                // Draw danger rings from the water source
                [0.008, 0.005, 0.002].forEach((r, i) => {
                    const colors = ['rgba(34,197,94,0.15)', 'rgba(250,204,21,0.2)', 'rgba(239,68,68,0.25)'];
                    const borders = ['#22c55e', '#facc15', '#ef4444'];
                    L.circle([source[1], source[0]], {
                        radius: r * 111000,
                        color: borders[i], fillColor: colors[i], fillOpacity: 0.3, weight: 1, dashArray: '4'
                    }).addTo(polygonLayerRef.current);
                });

                L.circleMarker([source[1], source[0]], {
                    radius: 10, fillColor: '#3b82f6', color: '#fff', weight: 3, fillOpacity: 1
                }).addTo(polygonLayerRef.current);

                L.marker([source[1], source[0]], {
                    icon: L.divIcon({
                        html: '<div style="background:#1e40af;color:white;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;white-space:nowrap;border:2px solid #60a5fa;">💧 Water Source</div>',
                        className: '', iconAnchor: [40, 40]
                    })
                }).addTo(polygonLayerRef.current);
            }
        });
    };

    // Remove any active map click handlers safely
    const removeAllHandlers = () => {
        if (mapRef.current) {
            if (polygonHandlerRef.current) {
                mapRef.current.off('click', polygonHandlerRef.current);
                polygonHandlerRef.current = null;
            }
            if (sourceHandlerRef.current) {
                mapRef.current.off('click', sourceHandlerRef.current);
                sourceHandlerRef.current = null;
            }
        }
    };

    // Step 1: Start drawing polygon
    const startDrawing = () => {
        setStep('drawing-polygon');
        setPolygon([]);
        setWaterSource(null);
        polygonRef.current = [];
        clearLayers();
        removeAllHandlers();
        if (mapRef.current) {
            mapRef.current.getContainer().style.cursor = 'crosshair';
            const handler = (e: any) => {
                const { lat, lng } = e.latlng;
                const updated = [...polygonRef.current, [lng, lat]];
                polygonRef.current = updated;
                setPolygon(updated);
                drawOnMap(updated, null);
            };
            polygonHandlerRef.current = handler;
            mapRef.current.on('click', handler);
        }
    };

    // Step 2: Finish polygon, start placing water source
    const finishPolygon = () => {
        if (polygonRef.current.length < 3) return;
        setStep('placing-source');
        if (mapRef.current) {
            // Remove polygon click handler using the stored ref
            if (polygonHandlerRef.current) {
                mapRef.current.off('click', polygonHandlerRef.current);
                polygonHandlerRef.current = null;
            }
            mapRef.current.getContainer().style.cursor = 'pointer';
            const handler = (e: any) => {
                const { lat, lng } = e.latlng;
                const src = [lng, lat];
                setWaterSource(src);
                drawOnMap(polygonRef.current, src);
                setStep('ready');
                if (mapRef.current) {
                    mapRef.current.getContainer().style.cursor = '';
                    if (sourceHandlerRef.current) {
                        mapRef.current.off('click', sourceHandlerRef.current);
                        sourceHandlerRef.current = null;
                    }
                }
            };
            sourceHandlerRef.current = handler;
            mapRef.current.on('click', handler);
        }
    };

    // Step 3: Convert to 3D
    const convertTo3D = () => {
        if (!waterSource || polygonRef.current.length < 3) return;
        const closed = [...polygonRef.current, polygonRef.current[0]];
        onAOISelected(closed, waterSource);
    };

    const clearAll = () => {
        setPolygon([]); setWaterSource(null); setStep('idle');
        polygonRef.current = [];
        clearLayers();
        removeAllHandlers();
        if (mapRef.current) {
            mapRef.current.getContainer().style.cursor = '';
        }
    };

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative', background: '#0f172a' }}>
            <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

            {/* Search Bar */}
            <div style={{
                position: 'absolute', top: '1rem', left: '50%', transform: 'translateX(-50%)',
                zIndex: 1000, display: 'flex', gap: '0.5rem', width: '420px', maxWidth: '90vw'
            }}>
                <input type="text" value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && searchLocation()}
                    placeholder="Search location... (Mumbai, Tokyo, etc.)"
                    style={{
                        flex: 1, padding: '0.75rem 1rem', borderRadius: '8px',
                        background: 'rgba(15, 23, 42, 0.92)', backdropFilter: 'blur(12px)',
                        border: '1px solid rgba(255,255,255,0.15)', color: '#f8fafc',
                        fontSize: '0.85rem', outline: 'none'
                    }}
                />
                <button onClick={searchLocation} style={{
                    padding: '0.75rem', borderRadius: '8px',
                    background: 'rgba(56,189,248,0.2)', border: '1px solid rgba(56,189,248,0.4)',
                    color: '#38bdf8', cursor: 'pointer', display: 'flex', alignItems: 'center'
                }}>
                    <Search size={18} />
                </button>
            </div>

            {/* Controls */}
            <div style={{
                position: 'absolute', top: '4.5rem', right: '1rem',
                zIndex: 1000, display: 'flex', flexDirection: 'column', gap: '0.5rem'
            }}>
                {step === 'idle' && (
                    <button onClick={startDrawing} className="btn btn-success-soft"
                        style={{ padding: '0.75rem 1.5rem', width: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Pentagon size={18} />
                        Step 1: Draw AOI
                    </button>
                )}
                {step === 'drawing-polygon' && (
                    <>
                        <button onClick={finishPolygon} disabled={polygon.length < 3}
                            className="btn btn-success-soft"
                            style={{
                                padding: '0.75rem 1.5rem', width: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem',
                                opacity: polygon.length < 3 ? 0.5 : 1, cursor: polygon.length < 3 ? 'not-allowed' : 'pointer'
                            }}>
                            <ArrowRight size={18} />
                            Done ({polygon.length} pts)
                        </button>
                        <button onClick={clearAll} className="btn btn-danger-soft"
                            style={{ padding: '0.75rem 1.5rem', width: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <Trash2 size={18} /> Clear
                        </button>
                    </>
                )}
                {step === 'placing-source' && (
                    <div style={{
                        padding: '1rem', borderRadius: '8px', background: 'rgba(15,23,42,0.95)',
                        border: '1px solid rgba(59,130,246,0.5)', color: '#93c5fd', maxWidth: '220px'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', fontWeight: 700, fontSize: '0.85rem' }}>
                            <Waves size={16} /> Step 2
                        </div>
                        <p style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
                            Click on a <b style={{ color: '#60a5fa' }}>river, lake, or water body</b> inside your AOI to mark the flood origin.
                        </p>
                    </div>
                )}
                {step === 'ready' && (
                    <>
                        <button onClick={convertTo3D} className="btn btn-success-soft"
                            style={{ padding: '0.75rem 1.5rem', width: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <ArrowRight size={18} />
                            Convert to 3D Mesh
                        </button>
                        <button onClick={clearAll} className="btn btn-danger-soft"
                            style={{ padding: '0.75rem 1.5rem', width: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <Trash2 size={18} /> Start Over
                        </button>
                    </>
                )}
            </div>

            {/* Bottom instructions */}
            <div style={{
                position: 'absolute', bottom: '2rem', left: '50%', transform: 'translateX(-50%)',
                zIndex: 1000, background: 'rgba(15,23,42,0.92)', backdropFilter: 'blur(12px)',
                padding: '1.25rem 2.5rem', borderRadius: '12px',
                border: '1px solid rgba(56,189,248,0.2)', color: '#f8fafc', textAlign: 'center',
            }}>
                {step === 'idle' && (
                    <>
                        <h2 style={{
                            fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem',
                            background: 'linear-gradient(to right, #38bdf8, #818cf8)',
                            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'
                        }}>
                            FloodRisk AI — Area Selection
                        </h2>
                        <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
                            Search a location → Draw your AOI → Place the water source → Convert to 3D
                        </p>
                    </>
                )}
                {step === 'drawing-polygon' && (
                    <p style={{ color: '#38bdf8', fontSize: '0.85rem' }}>
                        <MapPin size={16} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
                        Click on the map to draw your Area of Interest (min 3 points)
                    </p>
                )}
                {step === 'placing-source' && (
                    <p style={{ color: '#60a5fa', fontSize: '0.85rem' }}>
                        <Waves size={16} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
                        Now click on a water body (river/lake) to mark where the flood originates
                    </p>
                )}
                {step === 'ready' && (
                    <p style={{ color: '#34d399', fontSize: '0.85rem' }}>
                        ✅ AOI and water source set! Click <b>Convert to 3D Mesh</b> to enter simulation.
                    </p>
                )}
            </div>
        </div>
    );
}
