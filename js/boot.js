// Entry point: boot from shared coordinates or ask for location.

if (!isNaN(paramLat) && !isNaN(paramLng)) {
  boot(paramLat, paramLng, {
    watchPosition: false,
    referenceMode: "manual",
    referenceMeta: { label: "the shared map area" }
  });
  requestBackgroundDeviceLocation();
} else {
  requestInitialLocation();
}
