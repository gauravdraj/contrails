import AIRPORTS from "../../airports.json" with { type: "json" };

// airports.json (shared with the frontend) rows are [iata, lat, lng, name, city, rank, elevationFt];
// Worker callers read [iata, label, lat, lng], labelled by city.
export const MAJOR_AIRPORTS = AIRPORTS.map(([iata, lat, lng, name, city]) => [iata, city || name, lat, lng]);
