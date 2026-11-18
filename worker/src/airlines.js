import AIRLINES_DATA from "../../airlines.json" with { type: "json" };

const PRIV_REG = new RegExp("^(?:" + AIRLINES_DATA.privateRegistrationPrefixes.join("|") + ")", "i");
const PRIV_ANON_HEX = /^~[0-9a-f]{4,}$/i;
const PRIV_HEXLIKE = /^(?:~)?[0-9a-f]{6}$/i;

export function airlineName(callsign) {
  if (!callsign || callsign.length < 3) return null;
  return AIRLINES_DATA.airlines[callsign.substring(0, 3).toUpperCase()]?.name || null;
}

export function isLikelyPrivateCallsign(callsign, options = {}) {
  if (!callsign) return !!options.missingIsPrivate;
  if (PRIV_REG.test(callsign) || PRIV_ANON_HEX.test(callsign)) return true;
  return options.hexlikeIsPrivate !== false && !isAirlineCallsign(callsign) && PRIV_HEXLIKE.test(callsign);
}

export function isAirlineCallsign(callsign) {
  if (!callsign || PRIV_REG.test(callsign) || PRIV_ANON_HEX.test(callsign)) return false;
  if (AIRLINES_DATA.fractionalCallsignPrefixes.includes(callsign.substring(0, 3).toUpperCase())) return false;
  return !!airlineName(callsign) || /^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/i.test(callsign);
}
