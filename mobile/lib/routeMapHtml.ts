/**
 * Builds a self-contained Leaflet + OpenStreetMap page for RouteScreen's
 * map view, rendered inside a `react-native-webview`. Deliberately not
 * `react-native-maps` — Leaflet/OSM needs no API key on either platform
 * (react-native-maps needs a Google Maps key on Android that only the
 * app owner can provision), and it reuses the same `react-native-webview`
 * dependency already in the app for ViewDocumentScreen. Leaflet/its CSS
 * load from unpkg's CDN and tiles from OpenStreetMap's tile servers —
 * both need the device to have internet access, same as every other
 * network call in this app.
 */
export type MapStop = { label: string; latitude: number; longitude: number };

function esc(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\x3c');
}

export function buildRouteMapHtml(stops: MapStop[]): string {
  const points = stops.map((s) => [s.latitude, s.longitude]);
  const markersJs = stops
    .map((s, i) => `L.marker([${s.latitude}, ${s.longitude}]).addTo(map).bindPopup('${esc(`${i + 1}. ${s.label}`)}');`)
    .join('\n');
  const polylineJs =
    points.length > 1 ? `L.polyline(${JSON.stringify(points)}, { color: '#7c9cff', weight: 3 }).addTo(map);` : '';
  const viewJs =
    points.length > 0
      ? `map.fitBounds(${JSON.stringify(points)}, { padding: [30, 30] });`
      : `map.setView([39.8, -98.6], 4);`; // no coordinates at all yet — fall back to a US-wide view

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <style>
          html, body, #map { height: 100%; margin: 0; padding: 0; background: #0b0b0f; }
        </style>
      </head>
      <body>
        <div id="map"></div>
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <script>
          var map = L.map('map', { zoomControl: true });
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 18,
          }).addTo(map);
          ${markersJs}
          ${polylineJs}
          ${viewJs}
        </script>
      </body>
    </html>
  `;
}
