'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Sky, Environment, Stars } from '@react-three/drei';
import { useRef, useMemo } from 'react';
import * as THREE from 'three';

export interface Map3DProps {
    floodLevel: number; // 0 to 10 (meters)
    showHeatmap: boolean;
    wireframe: boolean;
}

function Terrain({ floodLevel, showHeatmap, wireframe }: Map3DProps) {
    const meshRef = useRef<THREE.Mesh>(null!);

    // Generate terrain geometry
    const geometry = useMemo(() => {
        const size = 100;
        const segments = 128;
        const geom = new THREE.PlaneGeometry(size, size, segments, segments);

        const positionAttribute = geom.attributes.position;
        const vertex = new THREE.Vector3();

        // Create a simple terrain with hills and a river valley
        for (let i = 0; i < positionAttribute.count; i++) {
            vertex.fromBufferAttribute(positionAttribute, i);

            // Simple Perlin-like noise (mock)
            const x = vertex.x * 0.1;
            const y = vertex.y * 0.1;

            // Valley in the middle (x near 0)
            const valley = Math.pow(Math.abs(vertex.x / 40), 2) * 10;

            // Hills
            const hills = Math.sin(x) * Math.cos(y) * 3 + Math.sin(x * 2.5) * 1.5;

            vertex.z = Math.max(-5, valley + hills);
            positionAttribute.setZ(i, vertex.z);
        }

        geom.computeVertexNormals();
        return geom;
    }, []);

    // Material setup
    const material = useMemo(() => {
        return new THREE.MeshStandardMaterial({
            color: showHeatmap ? '#8b5cf6' : '#557755', // Purple for heatmap mode, Green for terrain
            roughness: 0.8,
            metalness: 0.2,
            flatShading: true,
            wireframe: wireframe,
        });
    }, [wireframe, showHeatmap]);

    // Update logic if needed
    useFrame(() => {
        if (meshRef.current) {
            // animate or interact
        }
    });

    return (
        <group rotation={[-Math.PI / 2, 0, 0]}>
            <mesh ref={meshRef} geometry={geometry} material={material} receiveShadow castShadow />

            {/* Water Layer */}
            <mesh position={[0, 0, floodLevel]} rotation={[0, 0, 0]}>
                <planeGeometry args={[100, 100]} />
                <meshPhysicalMaterial
                    color="#00aaff"
                    transparent
                    opacity={0.6}
                    roughness={0.1}
                    metalness={0.1}
                    transmission={0.5}
                    thickness={1}
                />
            </mesh>
        </group>
    );
}

export default function Map3D({ floodLevel, showHeatmap, wireframe }: Map3DProps) {
    return (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            <Canvas shadows camera={{ position: [0, 50, 60], fov: 45 }}>
                <fog attach="fog" args={['#0f172a', 30, 150]} />
                <ambientLight intensity={0.4} />
                <directionalLight
                    position={[50, 50, 25]}
                    intensity={1.5}
                    castShadow
                    shadow-mapSize-width={2048}
                    shadow-mapSize-height={2048}
                />

                <group>
                    <Terrain floodLevel={floodLevel} showHeatmap={showHeatmap} wireframe={wireframe} />
                </group>

                <OrbitControls
                    enableDamping
                    dampingFactor={0.05}
                    minDistance={10}
                    maxDistance={100}
                    maxPolarAngle={Math.PI / 2 - 0.1}
                />

                <Sky sunPosition={[100, 20, 100]} turbidity={10} rayleigh={0.5} />
                <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
                <Environment preset="night" />
            </Canvas>
        </div>
    );
}
