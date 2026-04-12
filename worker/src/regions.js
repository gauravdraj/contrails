import { haversineKm } from "./geo.js";

export const METRO_REGIONS = [
  // US metros
  { name: "Bay Area", lat: 37.62, lon: -122.38 },
  { name: "Los Angeles", lat: 33.94, lon: -118.41 },
  { name: "Chicago", lat: 41.98, lon: -87.90 },
  { name: "New York", lat: 40.66, lon: -73.78 },
  { name: "Washington DC", lat: 38.85, lon: -77.04 },
  { name: "Dallas-Fort Worth", lat: 32.90, lon: -97.04 },
  { name: "Denver", lat: 39.86, lon: -104.67 },
  { name: "Atlanta", lat: 33.64, lon: -84.43 },
  { name: "Seattle", lat: 47.45, lon: -122.31 },
  { name: "Miami", lat: 25.80, lon: -80.29 },
  { name: "Boston", lat: 42.37, lon: -71.02 },
  { name: "Phoenix", lat: 33.44, lon: -112.01 },
  { name: "Houston", lat: 29.98, lon: -95.34 },
  { name: "Minneapolis", lat: 44.88, lon: -93.22 },
  { name: "Detroit", lat: 42.21, lon: -83.35 },
  { name: "Philadelphia", lat: 39.87, lon: -75.24 },
  { name: "Orlando", lat: 28.43, lon: -81.31 },
  { name: "Las Vegas", lat: 36.08, lon: -115.15 },
  { name: "San Diego", lat: 32.73, lon: -117.19 },
  { name: "Portland", lat: 45.59, lon: -122.60 },
  { name: "Honolulu", lat: 21.32, lon: -157.92 },
  // International metros
  { name: "London", lat: 51.47, lon: -0.46 },
  { name: "Paris", lat: 49.01, lon: 2.55 },
  { name: "Frankfurt", lat: 50.03, lon: 8.57 },
  { name: "Amsterdam", lat: 52.31, lon: 4.76 },
  { name: "Dubai", lat: 25.25, lon: 55.36 },
  { name: "Tokyo", lat: 35.55, lon: 139.78 },
  { name: "Singapore", lat: 1.35, lon: 103.99 },
  { name: "Sydney", lat: -33.95, lon: 151.18 },
  { name: "Toronto", lat: 43.68, lon: -79.63 },
  { name: "Mexico City", lat: 19.44, lon: -99.07 },
];

export function findNearestRegion(lat, lon, maxKm) {
  let best = null;
  for (const region of METRO_REGIONS) {
    const dist = haversineKm(lat, lon, region.lat, region.lon);
    if (dist <= maxKm && (best === null || dist < best.dist)) {
      best = { name: region.name, dist };
    }
  }
  return best;
}
