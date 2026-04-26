# 🌊 FloodRisk AI — Flood Susceptibility & 3D Evacuation Platform

> A comprehensive geospatial platform for disaster preparedness, combining an **AI-driven MCDA Flood Susceptibility Backend** with a **Real-Time 3D Simulation Frontend**. This dual-engine system allows urban planners and emergency responders to compute scientific flood risks and visualize physics-informed flood dynamics interactively in the browser.

This repository contains two core components:
1. **`gis_flood_evac/`**: The Next.js + Three.js real-time 3D interactive frontend.
2. **`gis/`**: The Python + Flask backend for Earth Engine data processing, MCDA flood susceptibility calculation, and A* routing.

---

## 🌟 1. The 3D Simulation Frontend (`gis_flood_evac`)

A browser-based 3D simulation platform built for visualizing flood risks and testing evacuation strategies.

### ✨ Key Features
- **AOI Selection (2D Map)**: Leaflet-powered interactive map with Nominatim geocoding. Draw a polygon to define your Area of Interest and mark water source origins (rivers, lakes, coasts).
- **Real Geographic Data**: Fetches elevation grids via Open-Meteo (SRTM 90m DEM) and building footprints via OpenStreetMap Overpass API. Graceful fallback to procedural terrain if APIs are unavailable.
- **3D Terrain Engine (Three.js)**: 180×180 segment geometry mapped from real elevation data, featuring height-based vertex coloring and seamless terrain skirts. Includes 4 camera presets (Perspective, Oblique, Top, Free).
- **Photorealistic Water Simulation**: Custom GLSL shader with multi-layer wave displacement, depth-dependent color gradients, caustics, and shore foam. Smoothly animates flood levels (0 – 50m).
- **Building Impact Analysis**: Renders 3D extruded buildings color-coded by flood risk state. Estimates populations based on building type (residential, commercial, hospital, school).
- **Evacuation Route Planning**: Real-time A* pathfinding computes escape routes to algorithmically placed safe zones. Includes a **Stress Test** mode to dynamically place road blockages and watch routes recalculate.
- **Live Impact Dashboard**: Sidebar displaying risk levels, water height, flood spread percentage, and affected population stats.

### 🛠️ Tech Stack
- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript 5
- **3D Rendering**: Three.js (raw WebGL)
- **Mapping**: Leaflet, CartoDB tiles
- **Data APIs**: Open-Meteo, OpenStreetMap Overpass, Nominatim

### 🚀 Getting Started (Frontend)
```bash
cd gis_flood_evac
npm install
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) to start drawing your AOI and running 3D simulations.

---

## 🧠 2. The Analytical Backend (`gis`)

An automated geospatial engine that computes a **6-factor Flood Susceptibility Index (FSI)**, identifies high-risk zones, overlays risk on road networks, and computes safe evacuation routes.

### ✨ Key Features
- **Data Ingestion**: Automatically fetches SRTM DEM and soil data from Google Earth Engine (GEE), and waterways/roads from OpenStreetMap via OSMnx.
- **AHP MCDA Model**: Computes FSI using the Analytic Hierarchy Process with a Consistency Ratio of 0.006. Factors include:
  - Elevation (23.2%)
  - River Proximity (39.1%)
  - Flow Accumulation via D8 algorithm (19.6%)
  - Slope (9.1%)
  - Soil Runoff Index (9.1%)
- **Nonlinear Rainfall Multiplier**: Amplifies the base risk based on local rainfall scenarios.
- **Evacuation Routing**: Maps flood risk onto OSM drivable road networks, penalizes flooded segments, and runs A* routing with haversine heuristics to find the safest route to shelters.
- **Rich Outputs**: Generates continuous and classified GeoTIFF risk rasters, interactive Folium maps, PNG overlays, and structured JSON situation reports.

### 🛠️ Tech Stack
- **Backend**: Python 3.11+, Flask
- **Geospatial Processing**: Google Earth Engine API, OSMnx, NetworkX
- **Math/Algorithms**: NumPy, SciPy, custom AHP and A* implementations

### 🚀 Getting Started (Backend)

**Prerequisites:** Python 3.11+ and a Google Cloud project with Earth Engine API enabled.

```bash
cd gis
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows
pip install -r requirements.txt

# Authenticate Earth Engine (one-time setup)
earthengine authenticate

# Run the CLI analysis (e.g., Hyderabad, 15km radius)
python main.py --lat 17.385 --lon 78.4867 --radius 15 --rainfall 200

# Or start the Flask API and 2D web GUI
python app.py
```
Open [http://localhost:5050](http://localhost:5050) to access the backend's web dashboard.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    subgraph Frontend [3D Simulation Engine (gis_flood_evac)]
        A[User draws AOI] --> B[Fetch Open-Meteo DEM & OSM Buildings]
        B --> C[Generate 3D Terrain & Extrude Buildings]
        C --> D[Run Custom GLSL Water Shader]
        D --> E[Simulate Evacuation with Dynamic Blockages]
    end

    subgraph Backend [Analytical Engine (gis)]
        F[User sets Lat/Lon & Rainfall] --> G[Google Earth Engine: DEM, Soil]
        F --> H[OSMnx: Rivers, Lakes, Roads]
        G & H --> I[Compute Flow Accumulation & Distance Transforms]
        I --> J[Apply AHP Weights: 6-Factor MCDA]
        J --> K[Generate FSI Risk Rasters]
        K --> L[Overlay on Road Graph for A* Routing]
    end
```

### 🤝 How They Work Together
While the `gis` backend serves as a rigorous, data-heavy analytical tool ideal for generating static reports, risk rasters, and precise A* road-network routing, the `gis_flood_evac` frontend provides an immersive, interactive sandbox. Users can test "what-if" scenarios (e.g., visually adjusting water levels, blocking roads) in a dynamic 3D environment, bridging the gap between mathematical flood modeling and intuitive visual decision-making.

---

## 📜 License

This suite was developed for advanced GIS and disaster management modeling. All external data sources are used under their respective open licenses (ODbL for OpenStreetMap, CC-BY for Open-Meteo, standard terms for Google Earth Engine).
