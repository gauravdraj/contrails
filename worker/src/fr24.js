export function buildFlightRow(item, direction) {
  const flight = item.flight || {};
  const ident = flight.identification || {};
  const status = flight.status || {};
  const aircraft = flight.aircraft || {};
  const airline = flight.airline || {};
  const airport = flight.airport || {};
  const timing = flight.time || {};
  const genericStatus = status.generic?.status || {};

  const code = airline.code || {};

  const row = {
    flight: ident.number?.default || "",
    callsign: ident.callsign || "",
    airline: airline.short || airline.name || "",
    airline_iata: code.iata || "",
    airline_icao: code.icao || "",
    ac_code: aircraft.model?.code || "",
    ac_name: aircraft.model?.text || "",
    reg: aircraft.registration || "",
    status: status.text || "",
    color: genericStatus.color || "",
    sched_dep: timing.scheduled?.departure || null,
    sched_arr: timing.scheduled?.arrival || null,
    est_dep: timing.estimated?.departure || null,
    est_arr: timing.estimated?.arrival || null,
    actual_dep: timing.real?.departure || null,
    actual_arr: timing.real?.arrival || null,
    live: status.live || false,
  };

  if (direction === "arrival") {
    const origin = airport.origin || {};
    row.from_iata = origin.code?.iata || "";
    row.from_name = origin.name || "";
  } else {
    const destination = airport.destination || {};
    row.to_iata = destination.code?.iata || "";
    row.to_name = destination.name || "";
  }

  return row;
}

export function extractFlights(data, direction) {
  return data.map((item) => buildFlightRow(item, direction));
}

export function buildSchedulePayload(raw, iata) {
  const plugin = raw?.result?.response?.airport?.pluginData || {};
  const schedule = plugin.schedule || {};
  const detail = plugin.details || {};

  return {
    iata,
    name: detail.name || iata,
    arrivals: extractFlights(schedule.arrivals?.data || [], "arrival"),
    departures: extractFlights(schedule.departures?.data || [], "departure"),
  };
}
