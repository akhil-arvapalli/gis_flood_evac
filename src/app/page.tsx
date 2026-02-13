 'use client';

import dynamic from 'next/dynamic';
import { useState, useEffect } from 'react';
import Sidebar from '@/components/Sidebar';
import { fetchGeoData, type GeoData } from '@/lib/geodata';

const AOISelector = dynamic(() => import('@/components/AOISelector'), {
  ssr: false,
  loading: () => <LoadingScreen message="Loading 2D Map..." />
});

const FloodTerrain3D = dynamic(() => import('@/components/FloodTerrain3D'), {
  ssr: false,
  loading: () => <LoadingScreen message="Initializing 3D Engine..." />
});

function LoadingScreen({ message }: { message: string }) {
  return (
    <div className="loading-container">
      <div className="spinner" />
      <span className="loading-text">{message}</span>
    </div>
  );
}

type AppMode = 'aoi-selection' | 'loading-data' | '3d-simulation';

export default function Home() {
  const [mode, setMode] = useState<AppMode>('aoi-selection');
  const [aoiCoordinates, setAOICoordinates] = useState<number[][] | null>(null);
  const [waterSource, setWaterSource] = useState<number[] | null>(null);
  const [floodLevel, setFloodLevel] = useState(0);
  const [isSimulating, setIsSimulating] = useState(false);
  const [showMesh, setShowMesh] = useState(true);
  const [showEvacRoutes, setShowEvacRoutes] = useState(false);
  const [showBuildings, setShowBuildings] = useState(true);
  const [geoData, setGeoData] = useState<GeoData | null>(null);
  const [viewMode, setViewMode] = useState<'perspective' | 'oblique' | 'top'>('perspective');

  // Smooth flood animation
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isSimulating && mode === '3d-simulation') {
      interval = setInterval(() => {
        setFloodLevel((prev) => {
          if (prev >= 20) {
            setIsSimulating(false);
            return 20;
          }
          return prev + 0.08;
        });
      }, 50);
    }
    return () => clearInterval(interval);
  }, [isSimulating, mode]);

  const handleAOISelected = async (coordinates: number[][], source: number[]) => {
    setAOICoordinates(coordinates);
    setWaterSource(source);
    setFloodLevel(0);
    setIsSimulating(false);
    setShowMesh(true);
    setMode('loading-data');
    try {
      const data = await fetchGeoData(coordinates);
      setGeoData(data);
    } catch {
      setGeoData(null);
    }
    setMode('3d-simulation');
  };

  const handleBackToAOI = () => {
    setMode('aoi-selection');
    setAOICoordinates(null);
    setWaterSource(null);
    setFloodLevel(0);
    setIsSimulating(false);
  };

  const resetSimulation = () => {
    setFloodLevel(0);
    setIsSimulating(false);
  };

  return (
    <main className="app-container">
      <div className="map-container">
        {mode === 'aoi-selection' ? (
          <AOISelector onAOISelected={handleAOISelected} />
        ) : mode === 'loading-data' ? (
          <LoadingScreen message="Fetching real terrain & building data from APIs..." />
        ) : (
          <FloodTerrain3D
            floodLevel={floodLevel}
            aoiCoordinates={aoiCoordinates}
            waterSource={waterSource}
            showMesh={showMesh}
            showEvacRoutes={showEvacRoutes}
            showBuildings={showBuildings}
            geoData={geoData}
            viewMode={viewMode}
          />
        )}
      </div>

      {mode === '3d-simulation' && (
        <div className="ui-layer">
          <div style={{ pointerEvents: 'auto', height: '100%' }}>
            <Sidebar
              floodLevel={floodLevel}
              setFloodLevel={setFloodLevel}
              simulationRunning={isSimulating}
              toggleSimulation={() => setIsSimulating(!isSimulating)}
              onBackToAOI={handleBackToAOI}
              resetSimulation={resetSimulation}
              showMesh={showMesh}
              toggleMesh={() => setShowMesh(!showMesh)}
              showEvacRoutes={showEvacRoutes}
              toggleEvacRoutes={() => setShowEvacRoutes(!showEvacRoutes)}
              showBuildings={showBuildings}
              toggleBuildings={() => setShowBuildings(!showBuildings)}
              viewMode={viewMode}
              setViewMode={setViewMode}
            />
          </div>

          {/* Bottom Progress */}
          <div className="overlay-bottom">
            <div className="timeline-bar">
              <span className="timeline-info" style={{ color: '#34d399' }}>0m</span>
              <div className="progress-track">
                <div className="progress-fill" style={{
                  width: `${Math.min((floodLevel / 20) * 100, 100)}%`,
                  background: floodLevel > 15 ? '#ef4444' : floodLevel > 10 ? '#f59e0b' : '#38bdf8',
                  transition: 'all 0.15s linear'
                }} />
              </div>
              <span className="timeline-info" style={{ textAlign: 'right', color: '#ef4444' }}>50m</span>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
