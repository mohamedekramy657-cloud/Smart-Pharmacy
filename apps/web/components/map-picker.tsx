'use client';

import { useEffect, useRef, useState } from 'react';
import type { Map as LeafletMap, Marker } from 'leaflet';

const TILE_URL = process.env.NEXT_PUBLIC_MAP_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ?? '&copy; OpenStreetMap contributors';

/**
 * Optional map pin selection (Leaflet + configurable tile provider, no API key in the browser).
 * If tiles fail to load (provider down/blocked) the component reports it and search keeps
 * working through GPS or city/district selection.
 */
export function MapPicker({ center, value, onPick, unavailableText }: { center: { lat: number; lng: number }; value: { lat: number; lng: number } | null; onPick: (p: { lat: number; lng: number }) => void; unavailableText: string }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const [failed, setFailed] = useState(false);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    let cancelled = false;
    let tileErrors = 0;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !el.current || map.current) return;
      const m = L.map(el.current, { center: [center.lat, center.lng], zoom: 13 });
      const layer = L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 });
      layer.on('tileerror', () => { tileErrors++; if (tileErrors >= 4) setFailed(true); });
      layer.addTo(m);
      const icon = L.divIcon({ className: '', html: '<div style="width:18px;height:18px;border-radius:9px;background:#0f766e;border:3px solid white;box-shadow:0 0 0 2px #0f766e"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
      m.on('click', (e) => {
        const p = { lat: Math.round(e.latlng.lat * 1e5) / 1e5, lng: Math.round(e.latlng.lng * 1e5) / 1e5 };
        if (marker.current) marker.current.setLatLng(e.latlng); else marker.current = L.marker(e.latlng, { icon }).addTo(m);
        pickRef.current(p);
      });
      map.current = m;
    })().catch(() => setFailed(true));
    return () => { cancelled = true; map.current?.remove(); map.current = null; marker.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {failed && <p role="status" className="mb-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{unavailableText}</p>}
      <div ref={el} className="h-72 w-full overflow-hidden rounded-lg border border-slate-300" aria-label="Map: click to set your location" />
      {value && <p className="mt-1 text-xs text-slate-600">{value.lat.toFixed(5)}, {value.lng.toFixed(5)}</p>}
    </div>
  );
}
