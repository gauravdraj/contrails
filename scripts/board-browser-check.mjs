// Deterministic board fixtures shared by the full browser check and archived layout comparisons.
import assert from 'node:assert/strict';

export async function checkBoardLayouts(cdp, screenshot, { baseline = false } = {}) {
  const results = [], failures = [];
  function verify(condition, message) { if (!baseline && !condition) failures.push(message); }
  // Freeze board data only: use the real popup/sheet, tab handlers, countdown and styles.
  await cdp.evaluate(`(() => {
    clearActiveAirportRefreshTimer(); clearRefreshTimer(); clearMapFetchTimer();
    window.__reviewRefreshAirport = refreshActiveAirportPopup;
    refreshActiveAirportPopup = async function() {};
  })()`);
  try {
    for (const [width, height] of [[390,844],[1280,800]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 760 });
      const heights = {};
      for (const scenario of ['empty','takeoffs','landings','go-around','long-eta']) {
        const metrics = await cdp.evaluate(`(() => {
          closeActiveAirportPanel();
          if (typeof _airportBoardView !== 'undefined') _airportBoardView = 'list';
          const scenario = ${JSON.stringify(scenario)}, now = Date.now();
          const source = { callsign: 'UAL123', hex: 'a00001', originIata: 'HNL', destIata: 'LAX', aircraftType: 'B738',
            altFt: 1200, etaMin: 2, reportTs: now, lat: 51.477, lng: -0.36, runway: '27R', sequence: 1 };
          const arrivals = Array.from({ length: scenario === 'landings' || scenario === 'go-around' ? 5 : scenario === 'long-eta' ? 3 : 0 }, (_, i) => ({
            ...source, hex: 'a0000' + (i + 1), callsign: 'UAL' + (123 + i), sequence: i + 1,
            etaMin: scenario === 'long-eta' ? [13,13,120][i] : 2 + i, touchdownAtMs: now + (scenario === 'long-eta' ? [13,13,120][i] : 2 + i) * 60000,
            goAround: scenario === 'go-around' && i === 3 }));
          const departures = scenario === 'takeoffs' ? [ { ...source, sequence: null, status: 'Departing', speedKts: 110 },
            { ...source, sequence: null, hex: 'b00002', callsign: 'UAL456', status: 'Taxiing', speedKts: 14 } ] : [];
          [...arrivals,...departures].forEach(r => { routeCache[r.callsign] = { originSource: 'track', destSource: 'schedule' }; });
          const data = { arrivals, departures, landed: [], activeArrivalRunways: ['27R'], activeDepartureRunways: true };
          _airportPopupCache.LHR = { data, ts: now, snapshot: null, loading: false, stale: false };
          openAirportSchedulePopup('LHR', 'London Heathrow', 51.471, -0.46);
          renderSchedulePopup(scenario === 'takeoffs' ? 'departures' : 'arrivals');
          const root = _activeAirportPopup.getElement(), card = root.querySelector('.sched-card');
          const rect = el => { const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, height:r.height, width:r.width }; };
          const flight = card.querySelector('.sched-row .sched-flight'), route = card.querySelector('.sched-row .sched-route');
          const close = root.querySelector('.maplibregl-popup-close-button') || document.querySelector('#airport-panel-close');
          const ladder = card.querySelector('[data-board-view=ladder]');
          const surface = root.querySelector('.maplibregl-popup-content') || document.querySelector('#airport-panel-sheet');
          return { card: rect(card), surface: rect(surface), close: rect(close), ladder: ladder && rect(ladder),
            rowHeights: [...card.querySelectorAll('.sched-row')].map(n => rect(n).height),
            padding: getComputedStyle(surface).padding, rowFont: flight && getComputedStyle(flight).fontSize,
            routeFont: route && getComputedStyle(route).fontSize, nextFont: card.querySelector('.sched-next-flight') && getComputedStyle(card.querySelector('.sched-next-flight')).fontSize,
            rowOverflow: [...card.querySelectorAll('.sched-row')].some(n => n.scrollWidth > n.clientWidth),
            provenance: [...card.querySelectorAll('.route-provenance')].every(n => n.scrollWidth <= n.clientWidth && getComputedStyle(n.parentElement).textOverflow !== 'ellipsis'),
            altitudes: [...card.querySelectorAll('.sched-alt')].map(n => n.textContent),
            pulse: card.querySelector('.sched-dot.live') && getComputedStyle(card.querySelector('.sched-dot.live')).animationName,
            summary: card.querySelector('.sched-next-status')?.textContent,
            etas: [...card.querySelectorAll('[data-countdown]')].map(n => ({ text: n.textContent, clientWidth:n.clientWidth, scrollWidth:n.scrollWidth,
              parentFits:n.parentElement.scrollWidth <= n.parentElement.clientWidth })) };
        })()`);
        heights[scenario] = metrics.surface.height;
        results.push({ width, scenario, height: metrics.surface.height, cardWidth: metrics.card.width, padding: metrics.padding });
        // Popup placement runs after layout; capture only once its automatic pan has settled.
        await cdp.evaluate(`new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          setTimeout(function settled() {
            if (!map.isMoving()) resolve();
            else if (Date.now() > deadline) reject(new Error('Board screenshot pan did not settle'));
            else setTimeout(settled, 50);
          }, 100);
        })`);
        await screenshot(`${baseline ? 'v247' : 'v248'}-${width}-${scenario}`);
        verify(!metrics.rowOverflow, `${width}/${scenario}: row overflows`);
        verify(metrics.provenance, `${width}/${scenario}: provenance clipped`);
        verify(width < 760 || metrics.card.width === 280, `${width}/${scenario}: desktop card width ${metrics.card.width}`);
        if (metrics.ladder) verify(metrics.close.bottom <= metrics.ladder.top || metrics.close.left >= metrics.ladder.right || metrics.close.right <= metrics.ladder.left,
          `${width}/${scenario}: close/Ladder overlap`);
        if (metrics.rowFont) verify(metrics.rowFont === '13px' && metrics.routeFont === '12px' && metrics.nextFont === '16px', `${width}/${scenario}: fonts changed`);
        if (['landings','go-around','long-eta'].includes(scenario)) {
          verify(metrics.altitudes.length === (scenario === 'long-eta' ? 2 : 4), `${width}/${scenario}: missing altitude`);
          if (scenario !== 'go-around') verify(metrics.rowHeights.every(h => h < 50), `${width}/${scenario}: rows exceed two lines ${metrics.rowHeights}`);
          verify(metrics.pulse === 'sched-pulse', `${width}/${scenario}: live dot is not pulsing`);
        }
        if (scenario === 'long-eta') {
          verify(metrics.etas.some(e => e.text === '~13min') && metrics.etas.some(e => e.text === '~2h'), `${width}: long ETA fixtures missing`);
          for (const eta of metrics.etas) verify(eta.scrollWidth <= eta.clientWidth && eta.parentFits, `${width}: clipped ${JSON.stringify(eta)}`);
          verify(metrics.summary?.startsWith('ETA '), `${width}: summary ETA prefix missing`);
        }
      }
      verify(heights.empty < heights.takeoffs && heights.takeoffs < heights.landings, `${width}: board does not size to content: ${JSON.stringify(heights)}`);
      if (!baseline) {
        const scroll = await cdp.evaluate(`(() => {
          const data = _airportPopupCache.LHR.data;
          const template = data.arrivals[0];
          data.arrivals = Array.from({length:15}, (_,i) => ({...template, hex:'a'+i, callsign:'UAL'+i, etaMin:2+i, touchdownAtMs:Date.now()+(2+i)*60000}));
          data.departures = data.arrivals.map(r => ({...r,status:'Taxiing',speedKts:10}));
          renderSchedulePopup('arrivals');
          const root = () => _activeAirportPopup.getElement();
          root().querySelector('.sched-rows').scrollTop = 80;
          const arrivalScroll = root().querySelector('.sched-rows').scrollTop;
          root().querySelector('[data-dir=departures]').click();
          const firstDeparture = root().querySelector('.sched-rows').scrollTop;
          root().querySelector('.sched-rows').scrollTop = 35;
          const departureScroll = root().querySelector('.sched-rows').scrollTop;
          root().querySelector('[data-dir=arrivals]').click();
          const restoredArrival = root().querySelector('.sched-rows').scrollTop;
          root().querySelector('[data-dir=departures]').click();
          return {arrivalScroll,firstDeparture,departureScroll,restoredArrival,restoredDeparture:root().querySelector('.sched-rows').scrollTop};
        })()`);
        verify(scroll.arrivalScroll > 0 && scroll.firstDeparture === 0 && scroll.restoredArrival === scroll.arrivalScroll && scroll.restoredDeparture === scroll.departureScroll,
          `${width}: tab scroll ${JSON.stringify(scroll)}`);
        const unknown = await cdp.evaluate(`(() => {
          const data = _airportPopupCache.LHR.data;
          data.activeArrivalRunways = []; data.arrivals = data.arrivals.slice(0,5).map(r => ({...r,runway:null}));
          _airportBoardView = 'ladder'; renderSchedulePopup('arrivals');
          const lane = _activeAirportPopup.getElement().querySelector('.sched-ladder-unknown');
          return lane && {height:lane.clientHeight,text:lane.textContent};
        })()`);
        verify(unknown && unknown.height >= 150 && unknown.text.includes('Runway unknown'), `${width}: unknown lane missing or too short`);
      }
    }
  } finally {
    await cdp.evaluate('closeActiveAirportPanel(); refreshActiveAirportPopup = window.__reviewRefreshAirport; delete window.__reviewRefreshAirport');
  }
  console.log('BOARD LAYOUTS ' + JSON.stringify(results));
  assert.deepEqual(failures, [], failures.join('\n'));
  return baseline ? 'v2.47 mobile and desktop screenshots and measured heights' : 'mobile and desktop: content height, v2.47 fonts, altitude, provenance, pulse, ETA widths, controls and per-tab scroll';
}
