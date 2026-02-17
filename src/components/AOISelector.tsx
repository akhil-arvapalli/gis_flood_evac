'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { MapPin, Pentagon, Trash2, ArrowRight, Search, Waves, CheckCircle2, MapPinned, Building2, Mountain, TreePine } from 'lucide-react';

interface NominatimSuggestion {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    type: string;
    class: string;
    addresstype?: string;
}

interface AOISelectorProps {
    onAOISelected: (coordinates: number[][], waterSources: number[][]) => void;
}

type DrawStep = 'idle' | 'drawing-polygon' | 'placing-source' | 'ready';

function StepIndicator({ step }: { step: DrawStep }) {
    const steps = [
        { num: 1, label: 'Draw AOI' },
        { num: 2, label: 'Water Sources' },
        { num: 3, label: 'Launch 3D' },
    ];
    const active = step === 'idle' ? 0 : step === 'drawing-polygon' ? 1 : step === 'placing-source' ? 2 : 3;

    return (
        <div className="step-indicator">
            {steps.map((s, i) => (
                <div key={s.num} style={{ display: 'flex', alignItems: 'center' }}>
                    {i > 0 && <div className={`step-line ${active > i ? 'completed' : ''}`} />}
                    <div className={`step-dot ${active === s.num ? 'active' : active > s.num ? 'completed' : ''}`}>
                        {active > s.num ? <CheckCircle2 size={14} /> : s.num}
                    </div>
                </div>
            ))}
        </div>
    );
}

export default function AOISelector({ onAOISelected }: AOISelectorProps) {
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<any>(null);
    const polygonLayerRef = useRef<any>(null);
    const [step, setStep] = useState<DrawStep>('idle');
    const [polygon, setPolygon] = useState<number[][]>([]);
    const [waterSources, setWaterSources] = useState<number[][]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [suggestions, setSuggestions] = useState<NominatimSuggestion[]>([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [activeSuggIdx, setActiveSuggIdx] = useState(-1);
    const [searchLoading, setSearchLoading] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchContainerRef = useRef<HTMLDivElement>(null);

    // Refs to hold stable handler references and mutable polygon data
    const polygonRef = useRef<number[][]>([]);
    const polygonHandlerRef = useRef<((e: any) => void) | null>(null);
    const sourceHandlerRef = useRef<((e: any) => void) | null>(null);

    // Close suggestions on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
                setShowSuggestions(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    // Debounced autocomplete fetch
    const fetchSuggestions = useCallback((query: string) => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (query.trim().length < 2) { setSuggestions([]); setShowSuggestions(false); return; }
        setSearchLoading(true);
        debounceRef.current = setTimeout(async () => {
            try {
                const res = await fetch(
                    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&addressdetails=1`
                );
                const data: NominatimSuggestion[] = await res.json();
                setSuggestions(data);
                setShowSuggestions(data.length > 0);
                setActiveSuggIdx(-1);
            } catch { setSuggestions([]); }
            setSearchLoading(false);
        }, 300);
    }, []);

    const handleSearchInput = (val: string) => {
        setSearchQuery(val);
        fetchSuggestions(val);
    };

    const selectSuggestion = (s: NominatimSuggestion) => {
        setSearchQuery(s.display_name.split(',').slice(0, 2).join(','));
        setSuggestions([]);
        setShowSuggestions(false);
        if (mapRef.current) {
            mapRef.current.setView([parseFloat(s.lat), parseFloat(s.lon)], 14);
        }
    };

    const handleSearchKeyDown = (e: React.KeyboardEvent) => {
        if (!showSuggestions || suggestions.length === 0) {
            if (e.key === 'Enter') {
                // Fallback: direct search
                if (searchQuery.trim() && mapRef.current) {
                    fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`)
                        .then(r => r.json())
                        .then(d => { if (d?.[0]) mapRef.current.setView([parseFloat(d[0].lat), parseFloat(d[0].lon)], 14); });
                }
            }
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveSuggIdx(i => Math.min(i + 1, suggestions.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveSuggIdx(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' && activeSuggIdx >= 0) {
            e.preventDefault();
            selectSuggestion(suggestions[activeSuggIdx]);
        } else if (e.key === 'Escape') {
            setShowSuggestions(false);
        }
    };

    const getSuggestionIcon = (s: NominatimSuggestion) => {
        const c = s.class;
        if (c === 'place' || c === 'boundary') return <MapPinned size={14} />;
        if (c === 'building' || c === 'amenity') return <Building2 size={14} />;
        if (c === 'natural') return s.type === 'peak' ? <Mountain size={14} /> : <TreePine size={14} />;
        if (c === 'waterway' || c === 'water') return <Waves size={14} />;
        return <MapPin size={14} />;
    };

    const formatSuggestion = (s: NominatimSuggestion) => {
        const parts = s.display_name.split(',');
        const main = parts.slice(0, 2).join(',').trim();
        const secondary = parts.slice(2, 4).join(',').trim();
        return { main, secondary };
    };

    useEffect(() => {
        if (!mapContainerRef.current) return;
        let cancelled = false;

        import('leaflet').then((L) => {
            if (cancelled || !mapContainerRef.current) return;
            if (mapRef.current) {
                mapRef.current.remove();
                mapRef.current = null;
            }

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
            cancelled = true;
            if (mapRef.current) {
                if (polygonHandlerRef.current) mapRef.current.off('click', polygonHandlerRef.current);
                if (sourceHandlerRef.current) mapRef.current.off('click', sourceHandlerRef.current);
                mapRef.current.remove();
                mapRef.current = null;
            }
        };
    }, []);

    const clearLayers = () => { if (polygonLayerRef.current) polygonLayerRef.current.clearLayers(); };

    const drawOnMap = (points: number[][], sources: number[][]) => {
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

            // Draw water sources
            sources.forEach((source, idx) => {
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

                // Index label
                if (sources.length > 1) {
                    L.marker([source[1], source[0]], {
                        icon: L.divIcon({
                            html: `<div style="color:white;font-weight:bold;font-size:12px;text-align:center;margin-top:-6px;font-family:sans-serif;">${idx + 1}</div>`,
                            className: '', iconAnchor: [6, 9]
                        })
                    }).addTo(polygonLayerRef.current);
                }
            });
        });
    };

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

    const startDrawing = () => {
        setStep('drawing-polygon');
        setPolygon([]);
        setWaterSources([]);
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
                drawOnMap(updated, []);
            };
            polygonHandlerRef.current = handler;
            mapRef.current.on('click', handler);
        }
    };

    const finishPolygon = () => {
        if (polygonRef.current.length < 3) return;
        setStep('placing-source');
        if (mapRef.current) {
            if (polygonHandlerRef.current) {
                mapRef.current.off('click', polygonHandlerRef.current);
                polygonHandlerRef.current = null;
            }
            mapRef.current.getContainer().style.cursor = 'pointer';

            // Allow multiple sources
            const handler = (e: any) => {
                const { lat, lng } = e.latlng;
                const src = [lng, lat];
                setWaterSources(prev => {
                    const next = [...prev, src];
                    drawOnMap(polygonRef.current, next);
                    return next;
                });
            };
            sourceHandlerRef.current = handler;
            mapRef.current.on('click', handler);
        }
    };

    const convertTo3D = () => {
        if (waterSources.length === 0 || polygonRef.current.length < 3) return;
        const closed = [...polygonRef.current, polygonRef.current[0]];
        onAOISelected(closed, waterSources);
    };

    const clearAll = () => {
        setPolygon([]); setWaterSources([]); setStep('idle');
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

            {/* Autocomplete Search Bar */}
            <div className="search-container" ref={searchContainerRef}>
                <div style={{ display: 'flex', flex: 1 }}>
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => handleSearchInput(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                        placeholder="Search any location..."
                        className="search-input"
                        autoComplete="off"
                    />
                    <button onClick={() => { if (suggestions.length > 0) selectSuggestion(suggestions[0]); }} className="search-btn">
                        {searchLoading
                            ? <div className="search-spinner" />
                            : <Search size={18} />
                        }
                    </button>
                </div>
                {showSuggestions && suggestions.length > 0 && (
                    <div className="search-suggestions">
                        {suggestions.map((s, i) => {
                            const { main, secondary } = formatSuggestion(s);
                            return (
                                <div
                                    key={s.place_id}
                                    className={`search-suggestion-item ${i === activeSuggIdx ? 'active' : ''}`}
                                    onClick={() => selectSuggestion(s)}
                                    onMouseEnter={() => setActiveSuggIdx(i)}
                                >
                                    <span className="suggestion-icon">{getSuggestionIcon(s)}</span>
                                    <div className="suggestion-text">
                                        <span className="suggestion-main">{main}</span>
                                        {secondary && <span className="suggestion-secondary">{secondary}</span>}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Floating Action Controls */}
            <div className="aoi-controls">
                {step === 'idle' && (
                    <button onClick={startDrawing} className="fab fab-success">
                        <Pentagon size={18} />
                        Draw Area of Interest
                    </button>
                )}
                {step === 'drawing-polygon' && (
                    <>
                        <button onClick={finishPolygon} disabled={polygon.length < 3} className="fab fab-success">
                            <ArrowRight size={18} />
                            Done ({polygon.length} pts)
                        </button>
                        <button onClick={clearAll} className="fab fab-danger">
                            <Trash2 size={18} /> Clear
                        </button>
                    </>
                )}
                {step === 'placing-source' && (
                    <div className="source-hint">
                        <div className="source-hint-title">
                            <Waves size={16} /> Mark Water Sources
                        </div>
                        <p style={{ fontSize: '0.75rem', lineHeight: 1.5, marginBottom: '0.5rem' }}>
                            Click on <b>rivers, lakes, or seas</b> to add flood origins ({waterSources.length} added).
                        </p>
                        {waterSources.length > 0 && (
                            <button onClick={convertTo3D} className="fab fab-primary" style={{ width: '100%', marginTop: '0.5rem', justifyContent: 'center' }}>
                                <ArrowRight size={16} />
                                Start Simulation
                            </button>
                        )}
                        <button onClick={clearAll} className="fab fab-danger" style={{ width: '100%', marginTop: '0.5rem', justifyContent: 'center' }}>
                            <Trash2 size={16} /> Reset
                        </button>
                    </div>
                )}
                {step === 'ready' && (
                    <>
                        {/* 'ready' step effectively merged into placing-source for multi-select */}
                    </>
                )}
            </div>


        </div>
    );
}
