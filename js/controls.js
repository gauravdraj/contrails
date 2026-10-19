// Controls dock, search, filter toggles, and feature toggles.

// --- Controls dock ---
(function() {
  var controls = document.getElementById("map-controls");
  var toggle = document.getElementById("controls-toggle");
  if (!controls || !toggle) return;
  setControlsExpanded(false);
  toggle.addEventListener("click", function(e) {
    e.preventDefault();
    e.stopPropagation();
    setControlsExpanded(!controls.classList.contains("expanded"));
  });
  controls.addEventListener("click", function(e) {
    e.stopPropagation();
  });
  document.addEventListener("click", function(e) {
    if (!controls.classList.contains("expanded")) return;
    if (controls.contains(e.target)) return;
    setControlsExpanded(false);
  });
})();

// --- Search ---
(function() {
  var shell = document.getElementById("search-shell");
  var input = document.getElementById("search-input");
  var resultsEl = document.getElementById("search-results");
  if (!shell || !input || !resultsEl) return;
  input.setAttribute("aria-controls", "search-results");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");

  var renderedResults = [];
  var highlightIndex = -1;
  var lookupTimer = 0;
  var lookupSeq = 0;
  var remoteLookup = {
    key: "",
    query: null,
    status: "idle",
    result: null
  };

  function clearLookupTimer() {
    if (!lookupTimer) return;
    clearTimeout(lookupTimer);
    lookupTimer = 0;
  }

  function clearRemoteLookup() {
    clearLookupTimer();
    remoteLookup = {
      key: "",
      query: null,
      status: "idle",
      result: null
    };
  }

  function searchLookupKey(query) {
    return query ? (query.type + ":" + query.value) : "";
  }

  function setSearchResultsVisible(visible) {
    resultsEl.hidden = !visible;
    input.setAttribute("aria-expanded", visible ? "true" : "false");
    if (!visible) input.removeAttribute("aria-activedescendant");
  }

  function closeSearchResults() {
    renderedResults = [];
    highlightIndex = -1;
    resultsEl.innerHTML = "";
    setSearchResultsVisible(false);
  }

  function searchOptionIdBase(result) {
    var rawKey = result && result.key ? result.key : "result";
    var safeKey = String(rawKey).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    return "search-option-" + (safeKey || "result");
  }

  function assignSearchOptionIds() {
    var seenIds = {};
    for (var i = 0; i < renderedResults.length; i++) {
      var baseId = searchOptionIdBase(renderedResults[i]);
      var count = seenIds[baseId] || 0;
      seenIds[baseId] = count + 1;
      renderedResults[i].domId = count ? baseId + "-" + count : baseId;
    }
  }

  function syncSearchActiveDescendant() {
    if (resultsEl.hidden ||
        highlightIndex < 0 ||
        highlightIndex >= renderedResults.length ||
        !renderedResults[highlightIndex] ||
        renderedResults[highlightIndex].disabled ||
        !renderedResults[highlightIndex].domId) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    input.setAttribute("aria-activedescendant", renderedResults[highlightIndex].domId);
  }

  function matchScore(text, queryText) {
    if (!text) return -1;
    if (text === queryText) return 120;
    if (text.indexOf(queryText) === 0) return 90 - Math.min(20, text.length - queryText.length);
    var idx = text.indexOf(queryText);
    if (idx !== -1) return 65 - Math.min(20, idx);
    return -1;
  }

  function buildLocalResultMeta(plane, preferredLabel, aliasLabel) {
    var liveCallsign = plane.callsign ? plane.callsign.toUpperCase() : null;
    var airline = plane.callsign ? airlineName(plane.callsign) : null;
    var metaParts = [];
    if (liveCallsign && preferredLabel !== liveCallsign) metaParts.push("live " + liveCallsign);
    if (aliasLabel && aliasLabel !== preferredLabel) metaParts.push(aliasLabel);
    if (airline) metaParts.push(airline);
    metaParts.push(plane.icao24.toUpperCase());
    return metaParts.join(" · ");
  }

  function buildGlobalResultMeta(query, found) {
    var liveCallsign = found.callsign || null;
    var airline = liveCallsign ? airlineName(liveCallsign) : null;
    var metaParts = [];
    if (liveCallsign && query.display !== liveCallsign) metaParts.push("matched " + query.display);
    if (airline) metaParts.push(airline);
    metaParts.push(found.hex.toUpperCase());
    metaParts.push("exact live lookup");
    return metaParts.join(" · ");
  }

  function buildLocalResults(rawValue) {
    var queryText = normalizeSearchText(rawValue);
    if (!queryText) return [];
    var matches = [];
    for (var i = 0; i < aircraft.length; i++) {
      var plane = aircraft[i];
      var callsign = plane.callsign ? plane.callsign.toUpperCase() : "";
      var preferredLabel = callsign || plane.icao24.toUpperCase();
      var aliasLabel = null;
      var bestScore = -1;
      var variants = callsignVariants(plane.callsign);
      for (var v = 0; v < variants.length; v++) {
        var variant = variants[v];
        var variantScore = matchScore(variant, queryText);
        if (variant !== callsign) aliasLabel = variant;
        if (variantScore > bestScore) {
          bestScore = variantScore;
          preferredLabel = variant !== callsign ? variant : (callsign || plane.icao24.toUpperCase());
        }
      }
      var hexScore = matchScore(plane.icao24.toUpperCase(), queryText);
      if (hexScore > bestScore) {
        bestScore = hexScore;
        preferredLabel = plane.icao24.toUpperCase();
      }
      var airline = plane.callsign ? airlineName(plane.callsign) : null;
      var airlineScore = matchScore(normalizeSearchText(airline), queryText);
      if (airlineScore >= 0) bestScore = Math.max(bestScore, airlineScore - 4);
      if (bestScore < 0) continue;
      matches.push({
        key: "local:" + plane.icao24,
        type: "local",
        disabled: false,
        aircraft: plane,
        label: preferredLabel,
        meta: buildLocalResultMeta(plane, preferredLabel, aliasLabel),
        badge: "live",
        score: bestScore
      });
    }
    matches.sort(function(a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var distA = a.aircraft.slantKm != null ? a.aircraft.slantKm : (a.aircraft.viewDistKm != null ? a.aircraft.viewDistKm : 999999);
      var distB = b.aircraft.slantKm != null ? b.aircraft.slantKm : (b.aircraft.viewDistKm != null ? b.aircraft.viewDistKm : 999999);
      return distA - distB;
    });
    if (matches.length > SEARCH_SUGGESTION_LIMIT) matches.length = SEARCH_SUGGESTION_LIMIT;
    return matches;
  }

  function buildRemoteResult(query, localExactMatch) {
    if (!query || localExactMatch) return null;
    var lookupKey = searchLookupKey(query);
    if (remoteLookup.key !== lookupKey || remoteLookup.status === "loading") {
      return {
        key: "global-loading:" + lookupKey,
        type: "status",
        disabled: true,
        label: "Finding " + query.display + "…",
        meta: "Checking live traffic beyond the currently loaded aircraft.",
        badge: "global"
      };
    }
    if (remoteLookup.status === "ready" && remoteLookup.result) {
      return {
        key: "global:" + remoteLookup.result.hex,
        type: "global",
        disabled: false,
        query: query,
        result: remoteLookup.result,
        label: remoteLookup.result.callsign || remoteLookup.result.hex.toUpperCase(),
        meta: buildGlobalResultMeta(query, remoteLookup.result),
        badge: "global"
      };
    }
    if (remoteLookup.status === "empty") {
      return {
        key: "global-empty:" + lookupKey,
        type: "status",
        disabled: true,
        label: "No live match for " + query.display,
        meta: "Nothing exact is reporting right now.",
        badge: "global"
      };
    }
    if (remoteLookup.status === "error") {
      return {
        key: "global-error:" + lookupKey,
        type: "status",
        disabled: true,
        label: "Global lookup unavailable",
        meta: "Couldn't check " + query.display + " right now.",
        badge: "global"
      };
    }
    return null;
  }

  function firstSelectableIndex() {
    for (var i = 0; i < renderedResults.length; i++) {
      if (!renderedResults[i].disabled) return i;
    }
    return -1;
  }

  function stepHighlight(direction) {
    if (!renderedResults.length) return -1;
    var index = highlightIndex;
    if (index < 0 || index >= renderedResults.length) index = direction > 0 ? -1 : 0;
    for (var step = 0; step < renderedResults.length; step++) {
      index = (index + direction + renderedResults.length) % renderedResults.length;
      if (!renderedResults[index].disabled) return index;
    }
    return -1;
  }

  function renderResults(rawValue, options) {
    options = options || {};
    var queryText = normalizeSearchText(rawValue);
    if (!queryText) {
      clearRemoteLookup();
      closeSearchResults();
      return;
    }

    var localResults = buildLocalResults(rawValue);
    var exactQuery = normalizeFlightQuery(rawValue);
    var localExactMatch = exactQuery ? findAircraftByQuery(exactQuery) : null;
    var remoteResult = buildRemoteResult(exactQuery, localExactMatch);
    renderedResults = remoteResult ? localResults.concat(remoteResult) : localResults;
    assignSearchOptionIds();

    if (!options.preserveHighlight) highlightIndex = -1;
    if (highlightIndex < 0 || highlightIndex >= renderedResults.length || renderedResults[highlightIndex].disabled) {
      highlightIndex = firstSelectableIndex();
    }

    if (!renderedResults.length) {
      resultsEl.innerHTML = '<div class="search-empty">No loaded matches yet. Keep typing a full flight or hex for a wider live lookup.</div>';
      setSearchResultsVisible(true);
      syncSearchActiveDescendant();
      return;
    }

    var html = "";
    for (var i = 0; i < renderedResults.length; i++) {
      var result = renderedResults[i];
      var classes = "search-option";
      if (i === highlightIndex) classes += " active";
      html += '<button type="button" id="' + result.domId + '" class="' + classes + '" data-index="' + i + '" role="option" aria-selected="' + (i === highlightIndex ? "true" : "false") + '"' + (result.disabled ? " disabled" : "") + '>' +
        '<span class="search-option-main">' +
          '<span class="search-option-label">' + escapeHtml(result.label) + '</span>' +
          '<span class="search-option-meta">' + escapeHtml(result.meta) + '</span>' +
        '</span>' +
        '<span class="search-option-badge">' + escapeHtml(result.badge) + '</span>' +
      '</button>';
    }
    resultsEl.innerHTML = html;
    setSearchResultsVisible(true);
    syncSearchActiveDescendant();
  }

  function scheduleRemoteLookup(query, localExactMatch) {
    var lookupKey = searchLookupKey(query);
    if (!query || localExactMatch) {
      clearRemoteLookup();
      return;
    }
    if (remoteLookup.key === lookupKey && (remoteLookup.status === "loading" || remoteLookup.status === "ready" || remoteLookup.status === "empty" || remoteLookup.status === "error")) {
      return;
    }
    clearLookupTimer();
    remoteLookup = {
      key: lookupKey,
      query: query,
      status: "loading",
      result: null
    };
    var requestSeq = ++lookupSeq;
    lookupTimer = setTimeout(async function() {
      lookupTimer = 0;
      try {
        var found = await lookupAircraftQuery(query);
        if (requestSeq !== lookupSeq || !remoteLookup.query || remoteLookup.key !== lookupKey) return;
        remoteLookup.status = found ? "ready" : "empty";
        remoteLookup.result = found;
      } catch (_) {
        if (requestSeq !== lookupSeq || !remoteLookup.query || remoteLookup.key !== lookupKey) return;
        remoteLookup.status = "error";
        remoteLookup.result = null;
      }
      renderResults(input.value, { preserveHighlight: true });
    }, SEARCH_LOOKUP_DEBOUNCE_MS);
  }

  function refreshSearch(rawValue, options) {
    var exactQuery = normalizeFlightQuery(rawValue);
    var localExactMatch = exactQuery ? findAircraftByQuery(exactQuery) : null;
    scheduleRemoteLookup(exactQuery, localExactMatch);
    renderResults(rawValue, options);
  }

  function chooseResult(index) {
    var result = renderedResults[index];
    if (!result || result.disabled) return;
    if (result.type === "local") {
      focusAircraftById(result.aircraft.icao24, {
        center: true,
        minZoom: SEARCH_MIN_ZOOM,
        openPopup: true,
        reveal: true
      });
      input.value = result.label;
      input.blur();
      closeSearchResults();
      setControlsExpanded(false);
      setControlsFeedback("Centered on " + (result.aircraft.callsign || result.aircraft.icao24.toUpperCase()) + ".", "success", { timeoutMs: 3200 });
      return;
    }
    if (result.type === "global") {
      var found = result.result;
      setSelectedAircraft(null);
      queuePendingPlaneFocus(found.hex, {
        keepUrl: true,
        label: result.query.display,
        reason: "search"
      });
      if (map) closeMapPopup();
      input.value = result.query.display;
      input.blur();
      closeSearchResults();
      setControlsExpanded(false);
      setControlsFeedback("Centering on " + (found.callsign || found.hex.toUpperCase()) + "…", "info", { timeoutMs: 4500 });
      centerMapOnPlane(found.lat, found.lng, SEARCH_MIN_ZOOM);
    }
  }

  input.addEventListener("input", function() {
    refreshSearch(input.value);
  });
  input.addEventListener("search", function() {
    refreshSearch(input.value);
  });
  input.addEventListener("focus", function() {
    refreshSearch(input.value, { preserveHighlight: true });
  });
  input.addEventListener("keydown", function(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlightIndex = stepHighlight(1);
      renderResults(input.value, { preserveHighlight: true });
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightIndex = stepHighlight(-1);
      renderResults(input.value, { preserveHighlight: true });
      return;
    }
    if (e.key === "Enter") {
      if (highlightIndex >= 0) {
        e.preventDefault();
        chooseResult(highlightIndex);
      }
      return;
    }
    if (e.key === "Escape") {
      closeSearchResults();
      input.blur();
    }
  });
  resultsEl.addEventListener("mousedown", function(e) {
    if (e.target && e.target.closest && e.target.closest(".search-option")) e.preventDefault();
  });
  resultsEl.addEventListener("click", function(e) {
    var option = e.target && e.target.closest ? e.target.closest(".search-option") : null;
    if (!option) return;
    var index = parseInt(option.getAttribute("data-index"), 10);
    if (!isFinite(index)) return;
    chooseResult(index);
  });
  document.addEventListener("click", function(e) {
    if (shell.contains(e.target)) return;
    closeSearchResults();
  });

  refreshSearchUi = function() {
    if (!normalizeSearchText(input.value)) {
      closeSearchResults();
      return;
    }
    refreshSearch(input.value, { preserveHighlight: true });
  };
})();

// --- Filter toggles ---
(function() {
  var browseBtn = document.getElementById("loading-browse");
  var retryBtn = document.getElementById("loading-retry");
  var coordsForm = document.getElementById("loading-coordinates");
  var latInput = document.getElementById("loading-lat");
  var lngInput = document.getElementById("loading-lng");
  if (!browseBtn || !retryBtn || !coordsForm || !latInput || !lngInput) return;
  browseBtn.addEventListener("click", function() {
    boot(DEFAULT_BROWSE_LAT, DEFAULT_BROWSE_LNG, {
      watchPosition: false,
      referenceMode: "default",
      referenceMeta: { label: "the default browse area" }
    });
  });
  retryBtn.addEventListener("click", function() {
    requestInitialLocation();
  });
  coordsForm.addEventListener("submit", function(e) {
    e.preventDefault();
    var lat = parseCoordinate(latInput.value, -90, 90);
    var lng = parseCoordinate(lngInput.value, -180, 180);
    if (lat == null || lng == null) {
      showLocationFallback("Enter a valid latitude and longitude to continue.");
      return;
    }
    boot(lat, lng, {
      watchPosition: false,
      referenceMode: "manual",
      referenceMeta: { label: "your entered coordinates" }
    });
  });
})();

(function() {
  var btns = document.querySelectorAll("#visibility-controls .ftag");
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener("click", function() {
      var f = this.getAttribute("data-f");
      filters[f] = !filters[f];
      updateFilterButtons();
      saveFilters();
      renderMap();
      updateStatus();
      updateAlerts();
      updateViewHint(visibleAircraftCount());
      if (refreshSearchUi) refreshSearchUi();
    });
  }
  updateFilterButtons();
})();

// --- Feature toggles: weather, follow, saved places ---
(function() {
  var weatherBtn = document.getElementById("toggle-weather");
  if (weatherBtn) weatherBtn.addEventListener("click", function() { toggleWeather(); });

  var followBtn = document.getElementById("toggle-follow");
  if (followBtn) followBtn.addEventListener("click", function() { setFollowMode(!followMode); });

  var placesBtn = document.getElementById("toggle-places");
  if (placesBtn) placesBtn.addEventListener("click", function() { setPlacesPanel(!placesPanelOpen()); });

  var placesSave = document.getElementById("places-save");
  if (placesSave) placesSave.addEventListener("click", function() { saveCurrentPlace(); });

  var placesList = document.getElementById("places-list");
  if (placesList) {
    placesList.addEventListener("click", function(e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var del = t.getAttribute("data-del");
      if (del != null) { deletePlace(parseInt(del, 10)); return; }
      var go = t.getAttribute("data-idx");
      if (go != null) goToPlace(parseInt(go, 10));
    });
  }
})();
