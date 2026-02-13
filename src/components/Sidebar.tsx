'use client';

import {
    Menu, X, Droplets, Activity, ArrowLeft,
    AlertTriangle, Clock, TrendingUp, Grid3x3,
    Navigation, Building2, Eye
} from 'lucide-react';
import { useState } from 'react';

type ViewMode = 'perspective' | 'oblique' | 'top';

interface SidebarProps {
    floodLevel: number;
    setFloodLevel: (level: number) => void;
    simulationRunning: boolean;
    toggleSimulation: () => void;
    onBackToAOI?: () => void;
    resetSimulation?: () => void;
    showMesh: boolean;
    toggleMesh: () => void;
    showEvacRoutes: boolean;
    toggleEvacRoutes: () => void;
    showBuildings: boolean;
    toggleBuildings: () => void;
    viewMode?: ViewMode;
    setViewMode?: (mode: ViewMode) => void;
}

export default function Sidebar({
    floodLevel, setFloodLevel,
    simulationRunning, toggleSimulation,
    onBackToAOI, resetSimulation,
    showMesh, toggleMesh,
    showEvacRoutes, toggleEvacRoutes,
    showBuildings, toggleBuildings,
    viewMode = 'perspective', setViewMode,
}: SidebarProps) {
    const [isOpen, setIsOpen] = useState(true);

    const waterHeight = (floodLevel * 2.5).toFixed(1);
    const spread = (Math.min(floodLevel / 20, 1) * 100).toFixed(0);
    const riskLevel = floodLevel > 15 ? 'EXTREME' : floodLevel > 10 ? 'HIGH' : floodLevel > 6 ? 'MODERATE' : floodLevel > 3 ? 'LOW' : 'SAFE';
    const riskColor = floodLevel > 15 ? '#ef4444' : floodLevel > 10 ? '#f59e0b' : floodLevel > 6 ? '#facc15' : floodLevel > 3 ? '#38bdf8' : '#34d399';

    return (
        <>
            <button onClick={() => setIsOpen(!isOpen)} className="sidebar-toggle">
                {isOpen ? <X size={24} /> : <Menu size={24} />}
            </button>

            <div className={`sidebar ${isOpen ? 'open' : ''}`}>
                <div className="sidebar-content">

                    <div>
                        <h1 className="brand-title">FloodRisk AI</h1>
                        <p className="brand-subtitle">3D Flood Simulation</p>
                    </div>

                    {onBackToAOI && (
                        <button onClick={onBackToAOI} className="btn list-btn"
                            style={{ justifyContent: 'center', gap: '0.5rem' }}>
                            <ArrowLeft size={16} /> Redraw AOI
                        </button>
                    )}

                    {/* Mesh Toggle */}
                    <button onClick={toggleMesh}
                        className={`btn list-btn ${showMesh ? 'active' : ''}`}
                        style={{ justifyContent: 'center', gap: '0.5rem' }}>
                        <Grid3x3 size={16} />
                        {showMesh ? '3D Mesh: ON' : 'Show 3D Mesh'}
                        {showMesh && <div className="pulse-dot" style={{ width: 6, height: 6 }} />}
                    </button>

                    {/* Buildings Toggle */}
                    <button onClick={toggleBuildings}
                        className={`btn list-btn ${showBuildings ? 'active' : ''}`}
                        style={{ justifyContent: 'center', gap: '0.5rem' }}>
                        <Building2 size={16} />
                        {showBuildings ? 'Buildings: ON' : 'Show Buildings'}
                        {showBuildings && <div className="pulse-dot" style={{ width: 6, height: 6 }} />}
                    </button>

                    {/* Evacuation Routes Toggle */}
                    <button onClick={toggleEvacRoutes}
                        className={`btn list-btn ${showEvacRoutes ? 'active' : ''}`}
                        style={{ justifyContent: 'center', gap: '0.5rem', border: showEvacRoutes ? '1px solid rgba(0,255,68,0.4)' : undefined }}>
                        <Navigation size={16} />
                        {showEvacRoutes ? 'Evac Routes: ON' : 'Show Evac Routes'}
                        {showEvacRoutes && <div className="pulse-dot" style={{ width: 6, height: 6, background: '#00ff44' }} />}
                    </button>

                    {/* Camera View */}
                    {setViewMode && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                            <div style={{ fontSize: '0.6rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.15rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <Eye size={12} /> Camera View
                            </div>
                            <div style={{ display: 'flex', gap: '0.3rem' }}>
                                {([['perspective', '3D'], ['oblique', 'Oblique'], ['top', 'Top']] as [ViewMode, string][]).map(([mode, label]) => (
                                    <button key={mode} onClick={() => setViewMode(mode)}
                                        className="btn list-btn"
                                        style={{
                                            flex: 1, justifyContent: 'center', padding: '0.4rem 0.2rem',
                                            fontSize: '0.68rem', fontWeight: viewMode === mode ? 700 : 400,
                                            background: viewMode === mode ? 'rgba(56,189,248,0.2)' : undefined,
                                            border: viewMode === mode ? '1px solid rgba(56,189,248,0.5)' : undefined,
                                            color: viewMode === mode ? '#38bdf8' : undefined,
                                        }}>
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Water Level */}
                    <div className="control-group">
                        <h2 className="section-title">
                            <Droplets size={14} style={{ display: 'inline', marginRight: 4 }} />
                            Flood Simulation
                        </h2>

                        <div className="control-item">
                            <div className="control-label">
                                <span>Water Level</span>
                                <span className="control-value" style={{ color: riskColor, fontSize: '1rem' }}>{waterHeight}m</span>
                            </div>
                            <input type="range" min="0" max="20" step="0.1"
                                value={floodLevel}
                                onChange={(e) => setFloodLevel(parseFloat(e.target.value))}
                                className="range-input"
                            />
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: '#64748b' }}>
                                <span>0m</span><span>25m</span><span>50m</span>
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button onClick={toggleSimulation}
                                className={`btn ${simulationRunning ? 'btn-danger-soft' : 'btn-success-soft'}`}
                                style={{ flex: 2 }}>
                                {simulationRunning ? <><Activity size={16} /> Pause</> : <><TrendingUp size={16} /> Simulate</>}
                            </button>
                            {resetSimulation && (
                                <button onClick={resetSimulation} className="btn list-btn" style={{ flex: 1, justifyContent: 'center' }}>
                                    <Clock size={16} />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Status */}
                    <div className="stats-card">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                            <h3 style={{ fontSize: '0.8rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem', color: riskColor }}>
                                <AlertTriangle size={14} /> {riskLevel}
                            </h3>
                            {simulationRunning && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <div className="pulse-dot" />
                                    <span style={{ fontSize: '0.6rem', color: '#34d399' }}>LIVE</span>
                                </div>
                            )}
                        </div>
                        <div style={{ width: '100%', height: '6px', background: '#1e293b', borderRadius: '3px', overflow: 'hidden', marginBottom: '0.75rem' }}>
                            <div style={{
                                height: '100%', borderRadius: '3px', transition: 'all 0.15s linear',
                                width: `${Math.min((floodLevel / 20) * 100, 100)}%`,
                                background: `linear-gradient(90deg, #34d399, #38bdf8, #facc15, #f59e0b, #ef4444)`,
                                backgroundSize: '500% 100%',
                                backgroundPosition: `${Math.min((floodLevel / 20) * 100, 100)}% 0`,
                            }} />
                        </div>
                        <div className="stats-grid">
                            <div className="stats-item">
                                <p>Water Height</p>
                                <p style={{ color: riskColor }}>{waterHeight}m</p>
                            </div>
                            <div className="stats-item">
                                <p>Flood Spread</p>
                                <p>{spread}%</p>
                            </div>
                        </div>
                    </div>

                    {/* How it works */}
                    <div style={{ padding: '0.75rem', borderRadius: '8px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <p style={{ fontSize: '0.6rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.4rem' }}>
                            How it works
                        </p>
                        <p style={{ fontSize: '0.68rem', color: '#94a3b8', lineHeight: 1.5 }}>
                            Water spreads outward from the 💧 source you placed. Zones expand as the water level rises:
                        </p>
                        <div style={{ fontSize: '0.68rem', marginTop: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                            <span style={{ color: '#fca5a5' }}>🔴 Red = Critical (near water body)</span>
                            <span style={{ color: '#fde047' }}>🟡 Yellow = Warning (moderate risk)</span>
                            <span style={{ color: '#86efac' }}>🟢 Green = Monitor (low risk)</span>
                        </div>
                    </div>

                </div>
            </div>
        </>
    );
}
