// Contrails medium widget for Scriptable.
// Run once in Scriptable to grant location permission, then add as a medium Home Screen widget.

const WORKER_URL = "https://contrails-api.therealgraj.workers.dev";
const PHOTO_CACHE_MINUTES = 5;
const WIDGET_REFRESH_MINUTES = 1;

const theme = {
  bgTop: "#07111f",
  bgBottom: "#101b2b",
  card: "#132238",
  cardMuted: "#0d1828",
  text: "#f4f8ff",
  muted: "#9aa9bb",
  dim: "#62738a",
  accent: "#8ecbff",
  green: "#8ff0c2",
  warning: "#ffd166",
};

async function main() {
  let payload;

  try {
    const location = await getLocation();
    payload = await fetchNearby(location.latitude, location.longitude);
  } catch (error) {
    const widget = renderMessageWidget("Contrails", "Location or aircraft data unavailable", String(error.message || error));
    await finish(widget);
    return;
  }

  const nearest = payload.planes?.[0] || null;
  prunePhotoCache();
  const photo = await fetchPlanePhoto(nearest);
  const widget = renderWidget(payload, nearest, photo);
  await finish(widget);
}

async function getLocation() {
  const fixed = parseFixedLocation(args.widgetParameter);
  if (fixed) return fixed;

  Location.setAccuracyToHundredMeters();
  return Location.current();
}

function parseFixedLocation(parameter) {
  if (!parameter) return null;
  const parts = String(parameter).split(",").map((part) => parseFloat(part.trim()));
  if (parts.length !== 2 || parts.some((part) => !isFinite(part))) return null;
  return { latitude: parts[0], longitude: parts[1] };
}

async function fetchNearby(lat, lng) {
  const url = `${WORKER_URL}/nearby?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}&format=json`;
  const req = new Request(url);
  req.timeoutInterval = 12;
  return req.loadJSON();
}

async function fetchPlanePhoto(plane) {
  const hex = plane?.icao24;
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return null;

  const cachePath = photoCachePath(hex);
  const cached = readFreshCachedImage(cachePath);
  if (cached) return cached;

  try {
    const metaReq = new Request(`${WORKER_URL}/photo/${hex}`);
    metaReq.timeoutInterval = 8;
    const meta = await metaReq.loadJSON();
    if (!meta?.src) return null;

    const imageReq = new Request(meta.src);
    imageReq.timeoutInterval = 10;
    const image = await imageReq.loadImage();
    FileManager.local().writeImage(cachePath, image);
    return image;
  } catch (_) {
    return null;
  }
}

function photoCachePath(hex) {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), `contrails-photo-${hex.toLowerCase()}.jpg`);
}

function readFreshCachedImage(path) {
  const fm = FileManager.local();
  if (!fm.fileExists(path)) return null;

  const modified = fm.modificationDate(path);
  const maxAgeMs = photoCacheMaxAgeMs();
  if (modified && Date.now() - modified.getTime() > maxAgeMs) {
    try { fm.remove(path); } catch (_) {}
    return null;
  }

  return Image.fromFile(path);
}

function prunePhotoCache() {
  const fm = FileManager.local();
  const directory = fm.documentsDirectory();
  const maxAgeMs = photoCacheMaxAgeMs();

  for (const filename of fm.listContents(directory)) {
    if (!filename.startsWith("contrails-photo-")) continue;

    const path = fm.joinPath(directory, filename);
    const modified = fm.modificationDate(path);
    if (modified && Date.now() - modified.getTime() > maxAgeMs) {
      try { fm.remove(path); } catch (_) {}
    }
  }
}

function photoCacheMaxAgeMs() {
  return PHOTO_CACHE_MINUTES * 60 * 1000;
}

function renderWidget(payload, plane, photo) {
  const widget = new ListWidget();
  widget.backgroundGradient = backgroundGradient();
  widget.setPadding(14, 14, 12, 14);
  widget.url = webAppUrl(payload.mapUrl);
  widget.refreshAfterDate = new Date(Date.now() + WIDGET_REFRESH_MINUTES * 60 * 1000);

  renderHeader(widget, payload);
  widget.addSpacer(10);

  if (!plane) {
    renderEmptyState(widget, payload);
    return widget;
  }

  const body = widget.addStack();
  body.layoutHorizontally();
  body.centerAlignContent();

  renderPhotoCard(body, photo, plane);
  body.addSpacer(12);
  renderPlaneDetails(body, plane);

  return widget;
}

function webAppUrl(url) {
  return url || "https://gauravdraj.github.io/contrails/";
}

function renderHeader(widget, payload) {
  const header = widget.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();

  const label = header.addText("CONTRAILS");
  label.font = Font.semiboldSystemFont(11);
  label.textColor = new Color(theme.accent);
  label.letterSpacing = 1.2;

  header.addSpacer();

  const count = payload.planes?.length || 0;
  const countText = header.addText(count ? `${count} nearby` : "No traffic");
  countText.font = Font.mediumSystemFont(11);
  countText.textColor = new Color(count ? theme.green : theme.dim);

  header.addSpacer(8);

  const refreshSymbol = SFSymbol.named("arrow.clockwise");
  refreshSymbol.applyFont(Font.systemFont(10));
  const refresh = header.addImage(refreshSymbol.image);
  refresh.imageSize = new Size(11, 11);
  refresh.tintColor = new Color(theme.dim);
  refresh.url = refreshScriptUrl();

  header.addSpacer(7);

  const updated = header.addText(shortTime(new Date()));
  updated.font = Font.systemFont(11);
  updated.textColor = new Color(theme.dim);
}

function refreshScriptUrl() {
  try {
    return URLScheme.forRunningScript();
  } catch (_) {
    return "scriptable://";
  }
}

function renderPhotoCard(parent, photo, plane) {
  const photoCard = parent.addStack();
  photoCard.size = new Size(126, 100);
  photoCard.cornerRadius = 18;
  photoCard.backgroundColor = new Color(theme.cardMuted);
  photoCard.layoutVertically();
  photoCard.setPadding(8, 8, 8, 8);

  if (photo) {
    photoCard.backgroundImage = photo;
    photoCard.addSpacer();
  } else {
    photoCard.backgroundGradient = photoFallbackGradient();
    photoCard.addSpacer();
    const symbol = SFSymbol.named("airplane");
    symbol.applyFont(Font.systemFont(28));
    const icon = photoCard.addImage(symbol.image);
    icon.tintColor = new Color(theme.accent);
    icon.imageSize = new Size(34, 34);
    icon.centerAlignImage();
    photoCard.addSpacer();
  }

  const pill = photoCard.addStack();
  pill.layoutHorizontally();
  pill.centerAlignContent();
  pill.backgroundColor = new Color("#07111f", 0.82);
  pill.cornerRadius = 9;
  pill.setPadding(3, 7, 3, 7);

  const type = pill.addText(plane.type || "AIRCRAFT");
  type.font = Font.semiboldSystemFont(10);
  type.textColor = new Color(theme.text);
  type.lineLimit = 1;
}

function renderPlaneDetails(parent, plane) {
  const details = parent.addStack();
  details.layoutVertically();
  details.size = new Size(160, 100);

  const name = details.addText(plane.name || plane.callsign || "Aircraft nearby");
  name.font = Font.boldSystemFont(20);
  name.textColor = new Color(theme.text);
  name.lineLimit = 1;
  name.minimumScaleFactor = 0.75;

  const metaParts = [plane.registration, plane.callsign].filter(Boolean);
  if (metaParts.length) {
    const meta = details.addText(metaParts.join(" / "));
    meta.font = Font.mediumSystemFont(11);
    meta.textColor = new Color(theme.muted);
    meta.lineLimit = 1;
  }

  details.addSpacer(8);

  const metrics = details.addText([plane.distance, plane.altitude].filter(Boolean).join("  "));
  metrics.font = Font.semiboldSystemFont(13);
  metrics.textColor = new Color(theme.accent);
  metrics.lineLimit = 1;
  metrics.minimumScaleFactor = 0.8;

  const route = details.addText(plane.routeLine || statusLine(plane));
  route.font = Font.systemFont(12);
  route.textColor = new Color(theme.muted);
  route.lineLimit = 2;

  details.addSpacer();

  const footer = details.addText(plane.contrailLikely ? "Contrail likely" : "Tap for live map");
  footer.font = Font.mediumSystemFont(11);
  footer.textColor = new Color(plane.contrailLikely ? theme.warning : theme.dim);
  footer.lineLimit = 1;
}

function renderEmptyState(widget, payload) {
  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  const iconBox = row.addStack();
  iconBox.size = new Size(72, 72);
  iconBox.cornerRadius = 20;
  iconBox.backgroundGradient = photoFallbackGradient();
  iconBox.layoutVertically();
  iconBox.addSpacer();
  const symbol = SFSymbol.named("scope");
  symbol.applyFont(Font.systemFont(26));
  const icon = iconBox.addImage(symbol.image);
  icon.tintColor = new Color(theme.accent);
  icon.imageSize = new Size(32, 32);
  icon.centerAlignImage();
  iconBox.addSpacer();

  row.addSpacer(14);

  const copy = row.addStack();
  copy.layoutVertically();
  const title = copy.addText("Quiet sky");
  title.font = Font.boldSystemFont(22);
  title.textColor = new Color(theme.text);
  const message = copy.addText(payload.text || "No aircraft detected nearby.");
  message.font = Font.systemFont(13);
  message.textColor = new Color(theme.muted);
  message.lineLimit = 2;
  copy.addSpacer(6);
  const hint = copy.addText("Tap to open Contrails");
  hint.font = Font.mediumSystemFont(11);
  hint.textColor = new Color(theme.dim);
}

function renderMessageWidget(title, message, detail) {
  const widget = new ListWidget();
  widget.backgroundGradient = backgroundGradient();
  widget.setPadding(16, 16, 14, 16);

  const heading = widget.addText(title.toUpperCase());
  heading.font = Font.semiboldSystemFont(11);
  heading.textColor = new Color(theme.accent);
  heading.letterSpacing = 1.2;

  widget.addSpacer(12);

  const body = widget.addText(message);
  body.font = Font.boldSystemFont(20);
  body.textColor = new Color(theme.text);
  body.lineLimit = 2;

  if (detail) {
    widget.addSpacer(8);
    const small = widget.addText(detail);
    small.font = Font.systemFont(11);
    small.textColor = new Color(theme.muted);
    small.lineLimit = 2;
  }

  return widget;
}

function backgroundGradient() {
  const gradient = new LinearGradient();
  gradient.colors = [new Color(theme.bgTop), new Color(theme.bgBottom)];
  gradient.locations = [0, 1];
  return gradient;
}

function photoFallbackGradient() {
  const gradient = new LinearGradient();
  gradient.colors = [new Color(theme.card), new Color(theme.cardMuted)];
  gradient.locations = [0, 1];
  return gradient;
}

function statusLine(plane) {
  const status = plane.vertical || "tracking";
  return plane.contrailLikely ? `${status}, contrail altitude` : status;
}

function shortTime(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function finish(widget) {
  Script.setWidget(widget);
  if (!config.runsInWidget) {
    await widget.presentMedium();
  }
  Script.complete();
}

await main();
