/* Qibla Compass Offline — all calculations are local; no remote APIs are used. */
(() => {
  "use strict";

  const KAABA_LAT = 21.4225;
  const KAABA_LON = 39.8262;
  const LOCATION_KEY = "qiblaCompass.location.v1";
  const $ = (id) => document.getElementById(id);

  const els = {
    locationText: $("locationText"), accuracyText: $("accuracyText"),
    locationStatus: $("locationStatus"), permissionPanel: $("permissionPanel"),
    noticeTitle: $("noticeTitle"), noticeText: $("noticeText"), iosHelp: $("iosHelp"),
    enableBtn: $("enableBtn"), compass: $("compass"), dial: $("compass-dial"),
    ticks: $("ticks"), qiblaMarkerFixed: $("qiblaMarkerFixed"), guidanceArrow: $("guidance-arrow"), qiblaBearing: $("qiblaBearing"),
    qiblaCardinal: $("qiblaCardinal"), alignmentMessage: $("alignmentMessage"),
    headingValue: $("headingValue"), differenceValue: $("differenceValue"),
    sensorStatus: $("sensorStatus"), redetectBtn: $("redetectBtn"),
    calibrateBtn: $("calibrateBtn"), modal: $("calibrationModal"),
    closeModalBtn: $("closeModalBtn"), installBtn: $("installBtn")
  };

  let locationData = null;
  let QIBLA_BEARING = null;
  let smoothedHeading = null;
  let rawHeading = null;
  let orientationStarted = false;
  const requiresOrientationPermission = typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function";
  let alignedLast = false;
  let deferredInstallPrompt = null;
  let animationFrame = null;
  let latestOrientation = null;

  // Build the 12 major ticks plus smaller 10-degree ticks without image assets.
  for (let deg = 0; deg < 360; deg += 10) {
    const tick = document.createElement("span");
    tick.className = "tick" + (deg % 30 === 0 ? " major" : "");
    tick.style.transform = `translateX(-50%) rotate(${deg}deg)`;
    els.ticks.appendChild(tick);
  }

  function calculateQibla(lat, lon) {
    const kaabaLat = KAABA_LAT * Math.PI / 180;
    const kaabaLon = KAABA_LON * Math.PI / 180;
    const userLat = lat * Math.PI / 180;
    const userLon = lon * Math.PI / 180;
    const deltaLon = kaabaLon - userLon;
    const y = Math.sin(deltaLon);
    const x = Math.cos(userLat) * Math.tan(kaabaLat) - Math.sin(userLat) * Math.cos(deltaLon);
    let angle = Math.atan2(y, x) * 180 / Math.PI;
    return (angle + 360) % 360;
  }

  function cardinalDirection(degrees) {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(degrees / 45) % 8];
  }

  function angularDifference(a, b) {
    return Math.abs(((a - b + 540) % 360) - 180);
  }

  function showNotice(title, message, showIos = false) {
    els.permissionPanel.hidden = false;
    els.noticeTitle.textContent = title;
    els.noticeText.textContent = message;
    els.iosHelp.hidden = !showIos;
  }

  function hideNotice() { els.permissionPanel.hidden = true; }

  function renderLocation(data, cached = false) {
    locationData = data;
    QIBLA_BEARING = calculateQibla(data.latitude, data.longitude);
    els.locationText.textContent = `${data.latitude.toFixed(5)}°, ${data.longitude.toFixed(5)}°`;
    const accuracy = Number.isFinite(data.accuracy) ? `Accuracy ±${Math.round(data.accuracy)} m` : "Saved location";
    els.accuracyText.textContent = cached ? `${accuracy} · saved for offline use` : accuracy;
    els.locationStatus.classList.add("active");
    els.qiblaBearing.textContent = `${Math.round(QIBLA_BEARING)}°`;
    els.qiblaCardinal.textContent = cardinalDirection(QIBLA_BEARING);
    els.qiblaMarkerFixed.style.transform = `rotate(${QIBLA_BEARING}deg)`;
    els.sensorStatus.textContent = "Location ready · waiting for compass heading";
    updateReadout();
  }

  function loadCachedLocation() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCATION_KEY) || "null");
      if (saved && Number.isFinite(saved.latitude) && Number.isFinite(saved.longitude)) {
        renderLocation(saved, true);
        return true;
      }
    } catch (error) {
      console.warn("Could not read saved location:", error);
    }
    return false;
  }

  function requestLocation() {
    if (!("geolocation" in navigator)) {
      if (!locationData) showNotice("Location unavailable", "This browser does not support geolocation. Use a modern browser on a supported device.");
      return;
    }
    els.locationText.textContent = "Finding your location…";
    els.accuracyText.textContent = "Waiting for GPS permission";
    navigator.geolocation.getCurrentPosition((position) => {
      const data = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        savedAt: Date.now()
      };
      try { localStorage.setItem(LOCATION_KEY, JSON.stringify(data)); } catch (error) { console.warn("Location could not be saved.", error); }
      renderLocation(data, false);
      if (!requiresOrientationPermission || orientationStarted) hideNotice();
    }, (error) => {
      console.warn("Geolocation error:", error);
      if (locationData) {
        els.accuracyText.textContent += " · using saved location";
        showNotice("Could not refresh location", error.code === 1
          ? "Location permission was denied. Enable location access in your browser settings; the saved location is still being used."
          : "Could not get a fresh GPS fix. Your saved location is still being used.");
      } else {
        let message = "Please enable location once while online, then reopen the app.";
        if (error.code === 1) message = "Location permission was denied. Allow location access for this website in your browser settings.";
        else if (error.code === 2) message = "Your location is unavailable. Turn on device location services and try again.";
        else if (error.code === 3) message = "Location request timed out. Try again outdoors with location services enabled.";
        showNotice("Location permission needed", message, isIOS());
        els.locationText.textContent = "Location unavailable";
        els.accuracyText.textContent = "No saved location found";
      }
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function normalizeHeading(value) {
    if (!Number.isFinite(value)) return null;
    return ((value % 360) + 360) % 360;
  }

  function getHeading(event) {
    // iOS provides a true compass heading; alpha is the fallback on other devices.
    if (Number.isFinite(event.webkitCompassHeading)) return normalizeHeading(event.webkitCompassHeading);
    if (Number.isFinite(event.alpha)) {
      // For absolute orientation, alpha is a rotation relative to the Earth reference.
      // Many Android browsers report alpha clockwise from north when using the
      // absolute event. If the screen is landscape, account for screen rotation.
      let heading = 360 - event.alpha;
      const screenAngle = (screen.orientation && Number.isFinite(screen.orientation.angle))
        ? screen.orientation.angle
        : (Number.isFinite(window.orientation) ? window.orientation : 0);
      heading += screenAngle;
      return normalizeHeading(heading);
    }
    return null;
  }

  function onOrientation(event) {
    latestOrientation = event;
    const next = getHeading(event);
    if (next === null) {
      els.sensorStatus.textContent = "Your device does not have a compass sensor";
      return;
    }
    rawHeading = next;
    if (smoothedHeading === null) {
      smoothedHeading = next;
    } else {
      // Circular low-pass filter: handles the 359° -> 0° boundary correctly.
      const delta = ((next - smoothedHeading + 540) % 360) - 180;
      smoothedHeading = normalizeHeading(smoothedHeading + delta * 0.3);
    }
    if (animationFrame === null) {
      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        updateReadout();
      });
    }
  }

  function updateReadout() {
    if (smoothedHeading === null) {
      els.headingValue.textContent = "—°";
      els.differenceValue.textContent = "—°";
      if (QIBLA_BEARING !== null) els.alignmentMessage.textContent = "Move your phone to activate the compass";
      return;
    }
    els.headingValue.textContent = `${Math.round(smoothedHeading)}°`;
    // The dial turns opposite to the phone's heading, keeping north aligned to true north.
    els.dial.style.transform = `rotate(${-smoothedHeading}deg)`;
    els.ticks.style.transform = `rotate(${-smoothedHeading}deg)`;

    if (QIBLA_BEARING === null) {
      els.alignmentMessage.textContent = "Waiting for location to calculate Qibla";
      return;
    }

    const difference = angularDifference(smoothedHeading, QIBLA_BEARING);
    els.differenceValue.textContent = `${Math.round(difference)}°`;
    const relativeAngle = (QIBLA_BEARING - smoothedHeading + 360) % 360;
    els.guidanceArrow.style.transform = `rotate(${relativeAngle}deg)`;
    const aligned = difference < 5;
    els.compass.classList.toggle("aligned", aligned);
    if (aligned) {
      els.alignmentMessage.textContent = "You are facing Qibla — Alhamdulillah";
      els.alignmentMessage.classList.add("success");
      if (!alignedLast && "vibrate" in navigator) navigator.vibrate(200);
    } else {
      els.alignmentMessage.textContent = "Turn your phone until the arrow points to the top";
      els.alignmentMessage.classList.remove("success");
    }
    alignedLast = aligned;
    els.sensorStatus.textContent = "Compass active · keep away from magnets and metal";
  }

  async function startOrientation() {
    if (!("DeviceOrientationEvent" in window)) {
      els.sensorStatus.textContent = "Your device does not have a compass sensor";
      showNotice("Compass not supported", "Your device or browser does not provide the Device Orientation API.");
      return;
    }
    try {
      // iOS 13+ requires a user gesture and explicit permission.
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== "granted") {
          showNotice("Compass permission needed", "Motion and orientation access is blocked. Allow it in your browser settings, then tap Enable Compass.", isIOS());
          els.sensorStatus.textContent = "Compass permission denied";
          return;
        }
      }
      window.removeEventListener("deviceorientation", onOrientation);
      window.removeEventListener("deviceorientationabsolute", onOrientation);
      window.addEventListener("deviceorientation", onOrientation, true);
      window.addEventListener("deviceorientationabsolute", onOrientation, true);
      orientationStarted = true;
      els.sensorStatus.textContent = "Waiting for compass sensor…";
      // Some browsers expose absolute orientation only through deviceorientationabsolute.
      setTimeout(() => {
        if (rawHeading === null) {
          els.sensorStatus.textContent = "Your device does not have a compass sensor";
          showNotice("Compass sensor unavailable", "Your device does not have a compass sensor, or this browser cannot access it.", isIOS());
        } else {
          hideNotice();
        }
      }, 4000);
    } catch (error) {
      console.warn("Orientation permission error:", error);
      showNotice("Compass permission needed", "Compass access was not granted. Enable motion/orientation access and try again.", isIOS());
      els.sensorStatus.textContent = "Compass permission denied";
    }
  }

  // Install prompt is browser-controlled; this button invokes it after the user taps.
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    els.installBtn.hidden = false;
  });
  els.installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      showNotice("Install this app", "Use your browser menu and choose “Install app” or “Add to Home Screen”.");
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    els.installBtn.hidden = true;
  });
  window.addEventListener("appinstalled", () => { els.installBtn.hidden = true; });

  els.enableBtn.addEventListener("click", async () => {
    await startOrientation();
    if (!locationData) requestLocation();
  });
  els.redetectBtn.addEventListener("click", requestLocation);
  els.calibrateBtn.addEventListener("click", () => {
    if (typeof els.modal.showModal === "function") els.modal.showModal();
    else alert("Move your phone slowly in a figure-eight pattern to calibrate the compass.");
  });
  els.closeModalBtn.addEventListener("click", () => els.modal.close());

  // Register the offline cache. HTTPS or localhost is required for service workers.
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((error) => console.warn("Service worker registration failed:", error));
    });
  } else if (!("serviceWorker" in navigator)) {
    console.warn("Service workers are not supported in this browser.");
  }

  // First render from local storage so the app can work offline immediately.
  const hasCachedLocation = loadCachedLocation();
  if (!hasCachedLocation) {
    els.locationText.textContent = "Finding your location…";
    els.accuracyText.textContent = "Location permission may be needed";
  }
  requestLocation();
  // Try starting on browsers that don't require a gesture. iOS will prompt on button tap.
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission !== "function") {
    startOrientation();
  } else {
    showNotice("Enable your compass", "Tap below to allow motion and orientation access so the compass can show your direction.", isIOS());
  }
})();