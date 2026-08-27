/**
 * Geo helpers for Route/Weather — deliberately dependency-free.
 *
 * Geocoding and forecasts both go through Open-Meteo, which is free and
 * keyless for both its geocoding and forecast endpoints — no API key to
 * request from the user or manage as a Supabase secret, unlike the
 * Claude extraction function's ANTHROPIC_API_KEY. Distance is a plain
 * Haversine great-circle calculation, not a real driving route — no
 * routing/maps API is involved, so RouteScreen labels this explicitly as
 * an estimate rather than implying turn-by-turn accuracy it doesn't have.
 */

const EARTH_RADIUS_MILES = 3958.8;

/** Great-circle distance between two lat/lng points, in miles. */
export function haversineDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

export type GeocodeResult = { latitude: number; longitude: number };

/**
 * Resolves a free-text address/city query to coordinates via Open-Meteo's
 * geocoding API. Returns null (not a thrown error) when nothing matches —
 * a venue without coordinates is a normal, expected state (weather/route
 * just skip it), not a failure condition the caller needs to handle as an
 * exception.
 */
export async function geocodeAddress(query: string): Promise<GeocodeResult | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(trimmed)}&count=1&language=en&format=json`;
  const response = await fetch(url);
  if (!response.ok) return null;

  const data = await response.json();
  const first = data?.results?.[0];
  if (!first || typeof first.latitude !== 'number' || typeof first.longitude !== 'number') return null;

  return { latitude: first.latitude, longitude: first.longitude };
}

export type ForecastResult = {
  tempHighF: number;
  tempLowF: number;
  weatherCode: number;
};

// Open-Meteo's daily forecast only meaningfully covers ~16 days out.
// Requesting past that (or for a past date) still returns 200 with an
// empty/short `daily` array rather than an error, so we check the actual
// returned dates rather than trusting a fixed day-count.
export async function fetchForecast(latitude: number, longitude: number, date: string): Promise<ForecastResult | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&daily=temperature_2m_max,temperature_2m_min,weathercode&temperature_unit=fahrenheit&timezone=auto` +
    `&start_date=${date}&end_date=${date}`;
  const response = await fetch(url);
  if (!response.ok) return null;

  const data = await response.json();
  const dates: string[] = data?.daily?.time ?? [];
  const index = dates.indexOf(date);
  if (index === -1) return null; // outside the forecast horizon — not an error, just "no data yet"

  const tempHighF = data.daily.temperature_2m_max?.[index];
  const tempLowF = data.daily.temperature_2m_min?.[index];
  const weatherCode = data.daily.weathercode?.[index];
  if (typeof tempHighF !== 'number' || typeof tempLowF !== 'number' || typeof weatherCode !== 'number') return null;

  return { tempHighF, tempLowF, weatherCode };
}

// A small subset of Open-Meteo's WMO weather codes, mapped to plain
// labels — full table has ~30 codes, this covers the common cases and
// falls back to a generic label for anything unmapped.
const WEATHER_CODE_LABELS: Record<number, string> = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Heavy rain showers',
  95: 'Thunderstorms',
};

export function weatherCodeLabel(code: number): string {
  return WEATHER_CODE_LABELS[code] ?? 'Mixed conditions';
}
