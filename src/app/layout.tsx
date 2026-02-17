import type { Metadata } from 'next';
import { Inter, Outfit } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit', weight: ['400', '500', '600', '700'] });

export const metadata: Metadata = {
  title: 'FloodRisk AI — 3D Flood Simulation & Evacuation Platform',
  description: 'Real-time 3D flood risk assessment with terrain modeling, building impact analysis, and AI-powered evacuation routing. Built with real elevation and OpenStreetMap data.',
  keywords: 'flood risk, 3D simulation, evacuation, GIS, terrain modeling',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${outfit.variable} ${inter.className}`}>{children}</body>
    </html>
  );
}

