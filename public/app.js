/**
 * Unidentified client script
 * Handles proxy selection, query normalization, and UX toggles.
 */

const services = {
  safetynet: {
    name: "SafetyNet Balanced",
    description: "Balanced rewrite mode for everyday browsing.",
    mode: "standard",
    compose(targetUrl, meta) {
      return buildSafetyNetLink(targetUrl, { mode: this.mode, intent: meta?.intent });
    },
  },
  safetynet_headless: {
    name: "SafetyNet Headless",
    description: "Routes through the headless renderer for complex sites.",
    mode: "headless",
    render: "headless",
    compose(targetUrl, meta) {
      return buildSafetyNetLink(targetUrl, { mode: this.mode, render: this.render, intent: meta?.intent });
    },
  },
  safetynet_lite: {
    name: "SafetyNet Lite",
    description: "Lightweight mode optimized for speed.",
    mode: "lite",
    compose(targetUrl, meta) {
      return buildSafetyNetLink(targetUrl, { mode: this.mode, intent: meta?.intent });
    },
  },
};
const SERVICE_KEYS = Object.keys(services);
const SERVICE_PRIORITY_DEFAULT = ["safetynet", "safetynet_headless", "safetynet_lite"];
const SERVICE_PRIORITY_SEARCH = ["safetynet", "safetynet_lite", "safetynet_headless"];
const SERVICE_METRICS = SERVICE_KEYS.reduce((acc, key) => {
  acc[key] = {
    url: createMetricBucket(),
    search: createMetricBucket(),
  };
  return acc;
}, {});
const METRIC_DEFAULT_SCORE = 0.85;
const METRIC_LATENCY_BASELINE = 1200;
const METRIC_LATENCY_MAX = 6000;
const METRIC_RECENT_FAILURE_WINDOW = 30_000;
let activeAttempt = null;
let transportState = { safezone: "unknown", lastUpdate: 0, info: null };

const selectors = {
  form: document.querySelector("#portal-form"),
  input: document.querySelector("#destination"),
  status: document.querySelector("#portal-status"),
  serviceName: document.querySelector("#active-service-name"),
  serviceDesc: document.querySelector("#active-service-desc"),
  chips: document.querySelectorAll(".relay-chip"),
  missionBox: document.querySelector(".mission"),
  focusToggle: document.querySelector("#focus-mode"),
  panicToggle: document.querySelector("#panic-shortcut"),
  historyToggle: document.querySelector("#history-off"),
  frame: document.querySelector("#proxy-frame"),
  framePlaceholder: document.querySelector("#frame-placeholder"),
  workspaceStatus: document.querySelector("#workspace-status"),
  frameReset: document.querySelector("#workspace-reset"),
  tabCloakToggle: document.querySelector("#tab-cloak"),
  cloakTitle: document.querySelector("#cloak-title"),
  cloakBlank: document.querySelector("#cloak-blank"),
  autoBlankToggle: document.querySelector("#auto-blank"),
  panicKeySelect: document.querySelector("#panic-key"),
  fullscreenToggle: document.querySelector("#fullscreen-toggle"),
  eduOverlay: document.querySelector("#edu-overlay"),
  eduScroll: document.querySelector("#edu-scroll"),
  eduButton: document.querySelector("#edu-continue"),
  eduRestart: document.querySelector("#edu-restart"),
  eduProgress: document.querySelector("#edu-progress"),
  transportChips: document.querySelectorAll(".transport-chip"),
  transportStateLabel: document.querySelector("#transport-state-label"),
  transportHint: document.querySelector("#transport-metrics-hint"),
};

const historyKey = "unidentified:last-query";
const historyPrefKey = "unidentified:history-pref";
const panicKeyPref = "unidentified:panic-key";
const autoBlankPref = "unidentified:auto-blank";
const autoBlankResetFlag = "safetynet:auto-blank-reset-v2";
const eduRestartKey = "safetynet:edu-restarts";
const transportPrefKey = "safetynet:transport-pref";
const realTitle = document.title;
const cloakTitleFallback = "Class Notes - Google Docs";
const cloakFavicon = "https://ssl.gstatic.com/docs/doclist/images/infinite_arrow_favicon_5.ico";
const faviconLink = ensureFaviconLink();
const realFaviconHref = faviconLink?.href || "";

const isCloakedContext = window.name === "unidentified-cloak";
const isAboutBlankContext = window.location.protocol === "about:";

let activeService = "safetynet";
let userSelectedService = activeService;
let panicPrimed = false;
let panicTimer = null;
let persistHistory = false;
let panicKey = localStorage.getItem(panicKeyPref) || "Escape";
if (!isAboutBlankContext && localStorage.getItem(autoBlankResetFlag) !== "1") {
  localStorage.setItem(autoBlankPref, "off");
  localStorage.setItem(autoBlankResetFlag, "1");
}

let autoBlankEnabled = !isCloakedContext && localStorage.getItem(autoBlankPref) === "on";
let cloakLaunched = isCloakedContext;
let autoBlankArmed = false;
let autoBlankArmHandler = null;
const EDU_RESTART_THRESHOLD = 3;
let eduRestarts = Number(localStorage.getItem(eduRestartKey) || "0");
let eduUnlocked = eduRestarts >= EDU_RESTART_THRESHOLD || !document.body.classList.contains("edu-locked");
let lastNavigation = null;
let transportPreference = normalizeTransportPref(localStorage.getItem(transportPrefKey) || "auto");
if (eduUnlocked) {
  document.body.classList.remove("edu-locked");
}
if (isAboutBlankContext) {
  autoBlankEnabled = false;
  cloakLaunched = true;
}
if (selectors.panicKeySelect) {
  selectors.panicKeySelect.value = panicKey;
}
if (selectors.autoBlankToggle) {
  selectors.autoBlankToggle.checked = autoBlankEnabled;
}

hydrateHistoryPreference();
registerEventHandlers();
watchMissionBox();
updateActiveService(activeService);
registerServiceWorker();
listenForSwMessages();
registerTransportControls();
renderTransportPreference();
renderTransportState(transportState);
renderTransportMetricsHint();

function registerEventHandlers() {
  selectors.chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const next = chip.dataset.service;
      if (!next || !services[next]) return;
      userSelectedService = next;
      setActiveService(next, { userInitiated: true });
    });
  });

  selectors.form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const rawValue = selectors.input?.value.trim() ?? "";
    if (!rawValue) {
      setStatus("Type something first.", true);
      return;
    }

    try {
      const meta = { transport: transportPreference };
      const targetUrl = buildNavigationTarget(rawValue, meta);
      const intent = meta.intent;
      const order = buildServiceOrder(userSelectedService, intent);
      lastNavigation = {
        targetUrl,
        rawInput: rawValue,
        order,
        index: 0,
        meta,
      };
      cancelActiveServiceAttempt();
      launchWithService(order[0], targetUrl, { meta });

      if (persistHistory) {
        localStorage.setItem(historyKey, rawValue);
      }
      setStatus(`Launching via ${services[activeService].name}...`);
      selectors.form.reset();
    } catch (error) {
      setStatus(error.message || "Unable to build that request.", true);
    }
  });

  selectors.frame?.addEventListener("load", () => {
    const proxyError = inspectFrameForProxyError();
    if (proxyError) {
      finalizeServiceAttempt(false);
      selectors.framePlaceholder?.classList.remove("is-hidden");
      const humanMessage = proxyError.details ? `${proxyError.error}: ${proxyError.details}` : proxyError.error;
      setWorkspaceStatus("Proxy reported an upstream error.");
      setStatus(humanMessage || "Proxy error received.", true);
      if (!tryServiceFallback()) {
        setStatus("Unable to load that request right now.", true);
      }
      return;
    }
    const searchFailure = inspectSearchRenderFailure();
    if (searchFailure) {
      finalizeServiceAttempt(false);
      selectors.framePlaceholder?.classList.remove("is-hidden");
      setWorkspaceStatus(searchFailure);
      if (advanceSearchProvider(searchFailure)) {
        return;
      }
      setStatus(searchFailure, true);
      if (!tryServiceFallback()) {
        setStatus("Search provider error persists across relays.", true);
      }
      return;
    }
    finalizeServiceAttempt(true);
    setWorkspaceStatus("Secure session ready.");
    setStatus("Page loaded inside SafetyNet.");
    lastNavigation = null;
    userSelectedService = activeService;
  });

  selectors.frame?.addEventListener("error", () => {
    finalizeServiceAttempt(false);
    selectors.framePlaceholder?.classList.remove("is-hidden");
    setWorkspaceStatus("Could not load that page.");
    if (!tryServiceFallback()) {
      setStatus("Unable to load the requested page.", true);
    }
  });

  selectors.frameReset?.addEventListener("click", () => {
    if (selectors.frame) {
      cancelActiveServiceAttempt();
      selectors.frame.src = "about:blank";
      selectors.framePlaceholder?.classList.remove("is-hidden");
      setWorkspaceStatus("Workspace cleared.");
      if (!autoBlankEnabled) {
        cloakLaunched = false;
      }
      lastNavigation = null;
    }
  });

  selectors.focusToggle?.addEventListener("change", (event) => {
    document.body.classList.toggle("focus-mode", event.target.checked);
    setStatus(event.target.checked ? "Focus mode on." : "Focus mode off.");
  });

  selectors.historyToggle?.addEventListener("change", (event) => {
    persistHistory = !event.target.checked;
    document.body.classList.toggle("history-track", persistHistory);
    if (!persistHistory) {
      localStorage.removeItem(historyKey);
      localStorage.setItem(historyPrefKey, "off");
      setStatus("Nothing gets stored.");
    } else {
      localStorage.setItem(historyPrefKey, "track");
      setStatus("History capture on for this session.");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.code !== panicKey || !selectors.panicToggle?.checked) return;
    if (panicPrimed) {
      setStatus("Panic shortcut engaged.");
      window.location.href = "https://www.wikipedia.org";
      return;
    }

    panicPrimed = true;
    setStatus("Press Esc again to bail out.", true);
    clearTimeout(panicTimer);
    panicTimer = setTimeout(() => {
      panicPrimed = false;
      setStatus("");
    }, 2000);
  });

  selectors.tabCloakToggle?.addEventListener("change", (event) => {
    applyTabCloak(event.target.checked);
  });

  selectors.cloakTitle?.addEventListener("input", () => {
    if (selectors.tabCloakToggle?.checked) {
      applyTabCloak(true);
    }
  });

  selectors.cloakBlank?.addEventListener("click", () => {
    launchAboutBlankCloak();
  });

  selectors.panicKeySelect?.addEventListener("change", (event) => {
    panicKey = event.target.value || "Escape";
    localStorage.setItem(panicKeyPref, panicKey);
    panicPrimed = false;
    setStatus(`Panic key set to ${panicKey}.`);
  });

  selectors.autoBlankToggle?.addEventListener("change", (event) => {
    autoBlankEnabled = event.target.checked;
    localStorage.setItem(autoBlankPref, autoBlankEnabled ? "on" : "off");
    if (autoBlankEnabled) {
      attemptAutoBlank();
    } else {
      disarmAutoBlank();
      setStatus("Auto about:blank disabled.");
    }
  });

  selectors.fullscreenToggle?.addEventListener("click", () => {
    toggleFullscreen();
  });

  updateFullscreenButton();

  prepareEducationGate();
}

function composeProxyUrl(targetUrl, serviceKey = activeService, meta) {
  const service = services[serviceKey];
  if (!service) {
    throw new Error("Pick a relay personality to continue.");
  }
  return service.compose(targetUrl, meta);
}

function buildNavigationTarget(input, meta = {}) {
  const intent = detectQueryIntent(input);
  meta.intent = intent;
  if (intent === "url") {
    meta.searchProviderIndex = undefined;
    meta.searchProviderLabel = undefined;
    return normalizeExplicitUrl(input);
  }
  const providerIndex = clampSearchProviderIndex(meta.searchProviderIndex ?? 0);
  meta.searchProviderIndex = providerIndex;
  const provider = SEARCH_PROVIDERS[providerIndex] || SEARCH_PROVIDERS[0];
  meta.searchProviderLabel = provider.label;
  return provider.buildUrl(input);
}

function normalizeExplicitUrl(input) {
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(input);
  const looksLikeDomain = /^[^\s]+\.[a-z]{2,}$/i.test(input);

  if (hasScheme) {
    return new URL(input).toString();
  }

  if (looksLikeDomain) {
    return new URL(`https://${input}`).toString();
  }

  return new URL(`https://${input}`).toString();
}

function detectQueryIntent(input) {
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(input);
  const looksLikeDomain = /^[^\s]+\.[a-z]{2,}$/i.test(input);
  if (hasScheme || looksLikeDomain) {
    return "url";
  }
  return "search";
}

function normalizeIntent(intent) {
  return intent === "search" ? "search" : "url";
}

function clampSearchProviderIndex(index) {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(SEARCH_PROVIDERS.length - 1, Math.floor(index)));
}

function updateActiveService(key, announce = true) {
  const service = services[key];
  if (!service) return;
  selectors.serviceName.textContent = service.name;
  selectors.serviceDesc.textContent = service.description;
  selectors.chips.forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset.service === key);
  });
  if (announce) {
    setStatus(`Ready on ${service.name}.`);
  }
}

function setStatus(message, isError = false) {
  if (!selectors.status) return;
  selectors.status.textContent = message;
  selectors.status.dataset.state = message ? (isError ? "error" : "ok") : "";
}

function setWorkspaceStatus(message) {
  if (!selectors.workspaceStatus) return;
  selectors.workspaceStatus.textContent = message;
}

function hydrateHistoryPreference() {
  const savedPref = localStorage.getItem(historyPrefKey);
  persistHistory = savedPref === "track" || !selectors.historyToggle?.checked;

  if (savedPref === "track") {
    selectors.historyToggle.checked = false;
  }

  document.body.classList.toggle("history-track", persistHistory);

  if (persistHistory) {
    const savedQuery = localStorage.getItem(historyKey);
    if (savedQuery) {
      selectors.input.value = savedQuery;
      setStatus("Restored last request.");
    }
  }
}

function watchMissionBox() {
  if (!selectors.missionBox) return;
  if (!("IntersectionObserver" in window)) {
    selectors.missionBox.classList.add("is-visible");
    return;
  }

  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          obs.disconnect();
        }
      });
    },
    { threshold: 0.4 }
  );

  observer.observe(selectors.missionBox);
}

function buildSafetyNetLink(targetUrl, config = {}, renderOverride) {
  const encoded = encodeURIComponent(targetUrl);
  const params = new URLSearchParams();
  const modeValue = typeof config === "string" ? config : config.mode;
  if (modeValue && modeValue !== "standard") {
    params.set("mode", modeValue);
  }
  const renderValue = typeof config === "object" ? config.render ?? renderOverride : renderOverride;
  if (renderValue) {
    params.set("render", renderValue);
  }
  const intentValue = typeof config === "object" ? config.intent : undefined;
  if (intentValue) {
    params.set("intent", intentValue);
  }
  const transportValue = typeof config === "object" ? config.transport : undefined;
  if (transportValue && transportValue !== "auto") {
    params.set("transport", transportValue);
  }
  const query = params.toString();
  return query ? `/proxy/${encoded}?${query}` : `/proxy/${encoded}`;
}

function inspectFrameForProxyError() {
  if (!selectors.frame || !selectors.frame.contentDocument) return null;
  try {
    const doc = selectors.frame.contentDocument;
    const body = doc.body;
    if (!body) return null;
    const text = body.textContent?.trim() ?? "";
    if (!text || text.length > 2000) {
      return null;
    }
    const firstChar = text[0];
    if (firstChar !== "{" && firstChar !== "[") {
      return null;
    }
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === "string") {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function inspectSearchRenderFailure() {
  const intent = activeAttempt?.intent || lastNavigation?.meta?.intent;
  if (intent !== "search") return null;
  if (!selectors.frame || !selectors.frame.contentDocument) return null;
  try {
    const doc = selectors.frame.contentDocument;
    const body = doc.body;
    if (!body) return null;
    const text = body.innerText?.toLowerCase() ?? "";
    const providerLabel = lastNavigation?.meta?.searchProviderLabel || "The search provider";
    if (text.includes("ran into an error displaying these results")) {
      return `${providerLabel} blocked the embedded results. Switching relays.`;
    }
    if (text.includes("please try again later") && text.includes("duckduckgo")) {
      return `${providerLabel} returned an error page.`;
    }
    const errorSelector =
      doc.querySelector(".msg-error, .error-page, [data-testid='error-message']") ||
      doc.querySelector("body[data-theme='dark'] .error__title");
    if (errorSelector) {
      return `${providerLabel} reported an error.`;
    }
  } catch {
    return null;
  }
  return null;
}

function updateSafezoneState(stateMessage) {
  const previous = transportState.safezone;
  transportState = {
    safezone: stateMessage.state || "unknown",
    info: stateMessage.info || null,
    lastUpdate: Date.now(),
  };
  if (previous !== transportState.safezone) {
    announceSafezoneState(transportState);
  }
  renderTransportState(transportState);
}

function announceSafezoneState(state) {
  if (state.safezone === "connected") {
    setWorkspaceStatus("Safezone channel active.");
  } else if (state.safezone === "disconnected") {
    setStatus("Safezone disconnected. Using direct relay fallback.", true);
  } else if (state.safezone === "error") {
    setStatus("Safezone instability detected, falling back.", true);
  }
}

function renderTransportState(state) {
  if (!selectors.transportStateLabel) return;
  const label =
    state.safezone === "connected"
      ? "Safezone: connected"
      : state.safezone === "disconnected"
      ? "Safezone: offline"
      : state.safezone === "error"
      ? "Safezone: unstable"
      : "Safezone: unknown";
  selectors.transportStateLabel.textContent = label;
}

function renderTransportMetricsHint() {
  if (!selectors.transportHint) return;
  const intent = normalizeIntent(lastNavigation?.meta?.intent || "url");
  const order = buildServiceOrder(userSelectedService, intent);
  const best = order.slice(0, 2).map((key) => `${services[key].name}: ${formatServiceScore(key, intent)}`);
  const prefLabel =
    transportPreference === "auto"
      ? "Auto-balancing"
      : transportPreference === "safezone"
      ? "Safezone forced"
      : "Direct path forced";
  selectors.transportHint.textContent = `${prefLabel} · ${best.join(" | ")}`;
}

function formatServiceScore(serviceKey, intent) {
  const score = getServiceScore(serviceKey, intent);
  return `${Math.round(score * 100)}%`;
}

function normalizeTransportPref(value) {
  if (value === "tunnel") return "safezone";
  if (value === "safezone" || value === "direct") {
    return value;
  }
  return "auto";
}

function createMetricBucket() {
  return {
    successes: 0,
    failures: 0,
    totalLatency: 0,
    samples: 0,
    lastFailureAt: 0,
  };
}

function getServiceMetricBucket(serviceKey, intent = "url") {
  const normalizedIntent = normalizeIntent(intent);
  const bucketHost = SERVICE_METRICS[serviceKey];
  if (!bucketHost) {
    return createMetricBucket();
  }
  return bucketHost[normalizedIntent] || bucketHost.url;
}

function beginServiceAttempt(serviceKey, intent = "url") {
  activeAttempt = {
    serviceKey,
    intent: normalizeIntent(intent),
    startedAt: performance.now(),
  };
}

function cancelActiveServiceAttempt() {
  activeAttempt = null;
}

function finalizeServiceAttempt(success) {
  if (!activeAttempt) return;
  const elapsed = Math.max(0, performance.now() - (activeAttempt.startedAt || performance.now()));
  updateServiceMetrics(activeAttempt.serviceKey, activeAttempt.intent, success, elapsed);
  activeAttempt = null;
  renderTransportMetricsHint();
}

function updateServiceMetrics(serviceKey, intent, success, elapsed) {
  const bucket = getServiceMetricBucket(serviceKey, intent);
  if (success) {
    bucket.successes += 1;
  } else {
    bucket.failures += 1;
    bucket.lastFailureAt = Date.now();
  }
  if (Number.isFinite(elapsed)) {
    bucket.totalLatency += elapsed;
    bucket.samples += 1;
  }
}

function getServiceScore(serviceKey, intent = "url") {
  const bucket = getServiceMetricBucket(serviceKey, intent);
  const attempts = bucket.successes + bucket.failures;
  const successRate = attempts > 0 ? bucket.successes / attempts : METRIC_DEFAULT_SCORE;
  const avgLatency = bucket.samples > 0 ? bucket.totalLatency / bucket.samples : METRIC_LATENCY_BASELINE;
  const latencyScore = Math.max(0, 1 - avgLatency / METRIC_LATENCY_MAX);
  const recentPenalty =
    bucket.lastFailureAt && Date.now() - bucket.lastFailureAt < METRIC_RECENT_FAILURE_WINDOW ? 0.15 : 0;
  return Math.max(0, successRate * 0.8 + latencyScore * 0.2 - recentPenalty);
}

function applyTabCloak(enabled) {
  const active = typeof enabled === "boolean" ? enabled : !!selectors.tabCloakToggle?.checked;
  const targetTitle = selectors.cloakTitle?.value.trim() || cloakTitleFallback;
  document.title = active ? targetTitle : realTitle;
  if (faviconLink) {
    faviconLink.href = active ? cloakFavicon : realFaviconHref || cloakFavicon;
  }
}

function ensureFaviconLink() {
  let link = document.querySelector("link[rel='icon']");
  if (link) return link;
  link = document.createElement("link");
  link.rel = "icon";
  document.head.appendChild(link);
  return link;
}

async function launchAboutBlankCloak(options = {}) {
  if (cloakLaunched) return true;
  cloakLaunched = true;
  disarmAutoBlank();
  const { silent = false } = options;
  if (!silent) {
    setStatus("Preparing about:blank cloak...");
  }
  const cloakWin = window.open("about:blank", "_blank");
  if (!cloakWin) {
    if (!silent) {
      setStatus("Allow pop-ups to open the about:blank cloak.", true);
    }
    cloakLaunched = false;
    if (autoBlankEnabled) {
      setTimeout(() => attemptAutoBlank(true), 800);
    }
    return false;
  }
  cloakWin.name = "unidentified-cloak";

  try {
    const response = await fetch(window.location.href, { credentials: "include" });
    const payload = await response.text();
    const baseTag = `<base href="${window.location.href}">`;
    const patched = payload.includes("<head>")
      ? payload.replace("<head>", `<head>${baseTag}`)
      : `<head>${baseTag}</head>` + payload;
    cloakWin.document.open();
    cloakWin.document.write(patched);
    cloakWin.document.close();
  } catch (error) {
    cloakWin.document.open();
    cloakWin.document.write(`
      <!DOCTYPE html>
      <title>about:blank</title>
      <style>html,body{margin:0;height:100%;background:#fff;}iframe{border:0;width:100%;height:100%;}</style>
      <iframe src="${window.location.href}" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>
    `);
    cloakWin.document.close();
  }

  if (!silent) {
    setStatus("Session moved to about:blank.");
  }
  setTimeout(closeOriginalWindow, 400);
  return true;
}

function closeOriginalWindow() {
  try {
    window.open("", "_self");
    window.close();
  } catch (error) {
    // ignore inability to close
  }
  document.body.innerHTML =
    "<main style='display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:Arial,sans-serif;background:#050505;color:#eee;'><p>Session transferred to cloaked tab.</p></main>";
}

function toggleFullscreen() {
  const target = selectors.frame || document.documentElement;
  if (!document.fullscreenElement) {
    target.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

function updateFullscreenButton() {
  if (!selectors.fullscreenToggle) return;
  selectors.fullscreenToggle.textContent = document.fullscreenElement ? "Exit fullscreen" : "Enter fullscreen";
}

document.addEventListener("fullscreenchange", updateFullscreenButton);

function attemptAutoBlank(delayFallback = false) {
  if (!autoBlankEnabled || cloakLaunched) return;
  setStatus("Auto about:blank active.");
  const launch = () =>
    launchAboutBlankCloak({ silent: true }).then((success) => {
      if (!success) {
        setStatus("Auto about:blank waiting for first interaction (allow pop-ups).");
        armAutoBlank();
      }
    });

  if (delayFallback) {
    setTimeout(() => {
      if (!cloakLaunched) {
        launch();
      }
    }, 500);
  } else {
    launch();
  }
}

function armAutoBlank() {
  if (!autoBlankEnabled || cloakLaunched || autoBlankArmed) return;
  autoBlankArmed = true;
  autoBlankArmHandler = () => {
    disarmAutoBlank();
    setTimeout(() => launchAboutBlankCloak({ silent: true }), 10);
  };
  document.addEventListener("pointerdown", autoBlankArmHandler, { once: true });
  document.addEventListener("keydown", autoBlankArmHandler, { once: true });
}

function disarmAutoBlank() {
  if (!autoBlankArmed) return;
  document.removeEventListener("pointerdown", autoBlankArmHandler);
  document.removeEventListener("keydown", autoBlankArmHandler);
  autoBlankArmHandler = null;
  autoBlankArmed = false;
}

function prepareEducationGate() {
  if (eduUnlocked || !selectors.eduOverlay) {
    document.body.classList.remove("edu-locked");
    if (autoBlankEnabled && !cloakLaunched) {
      attemptAutoBlank(true);
    }
    return;
  }
  updateEduProgress();
  selectors.eduRestart?.addEventListener("click", handleEduRestart);
  selectors.eduButton?.addEventListener("click", unlockSafetyNet);
}

function unlockSafetyNet() {
  if (!eduUnlocked && eduRestarts < EDU_RESTART_THRESHOLD) {
    setStatus(`Complete ${EDU_RESTART_THRESHOLD - eduRestarts} more restart(s).`, true);
    return;
  }
  if (eduUnlocked) return;
  eduUnlocked = true;
  localStorage.setItem(eduRestartKey, String(Math.max(eduRestarts, EDU_RESTART_THRESHOLD)));
  selectors.eduButton?.removeEventListener("click", unlockSafetyNet);
  document.body.classList.remove("edu-locked");
  selectors.eduOverlay?.classList.add("is-hidden");
  if (autoBlankEnabled && !cloakLaunched) {
    setTimeout(() => attemptAutoBlank(true), 250);
  }
  setStatus("SafetyNet ready. Stay safe.");
}

function handleEduRestart() {
  eduRestarts += 1;
  localStorage.setItem(eduRestartKey, String(eduRestarts));
  updateEduProgress();
  selectors.eduOverlay?.classList.add("is-reloading");
  setTimeout(() => selectors.eduOverlay?.classList.remove("is-reloading"), 350);
  if (eduRestarts >= EDU_RESTART_THRESHOLD && selectors.eduButton) {
    selectors.eduButton.disabled = false;
    selectors.eduButton.textContent = "Google";
  }
}

function updateEduProgress() {
  if (!selectors.eduProgress) return;
  const remaining = Math.max(0, EDU_RESTART_THRESHOLD - eduRestarts);
  if (remaining > 0) {
    selectors.eduProgress.textContent = `Reload the lesson ${remaining} more ${
      remaining === 1 ? "time" : "times"
    } to unlock SafetyNet.`;
    selectors.eduButton && (selectors.eduButton.disabled = true);
  } else {
    selectors.eduProgress.textContent = "Lesson verified. Select Google to continue to SafetyNet.";
    selectors.eduButton && (selectors.eduButton.disabled = false);
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw-safetynet.js", { scope: "/" })
      .then(() => {
        console.info("[SafetyNet] service worker registered");
      })
      .catch((error) => {
        console.warn("[SafetyNet] failed to register service worker", error);
      });
  });
}

function listenForSwMessages() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.addEventListener("message", (event) => {
    const payload = event.data;
    if (!payload || payload.source !== "safetynet-sw") return;
    if (payload.type === "safezone-state") {
      updateSafezoneState(payload);
      return;
    }
    const { event: eventName, payload: eventPayload } = payload;
    if (eventName === "proxy-fetch-error") {
      setStatus(`SW proxy error: ${eventPayload.message}`, true);
    } else if (eventName === "network-fallback-cache") {
      setStatus("Loaded offline copy from cache.", false);
    }
  });
}

function registerTransportControls() {
  selectors.transportChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const mode = chip.dataset.transport;
      setTransportPreference(mode);
    });
  });
}

function setTransportPreference(mode) {
  const normalized = normalizeTransportPref(mode);
  if (transportPreference === normalized) return;
  transportPreference = normalized;
  localStorage.setItem(transportPrefKey, transportPreference);
  renderTransportPreference();
  renderTransportMetricsHint();
  setStatus(`Transport mode set to ${transportPreference}.`);
}

function renderTransportPreference() {
  selectors.transportChips.forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset.transport === transportPreference);
  });
  renderTransportMetricsHint();
}

function setActiveService(key, { userInitiated = false } = {}) {
  if (!services[key]) return;
  activeService = key;
  updateActiveService(key, userInitiated);
  if (userInitiated) {
    userSelectedService = key;
    lastNavigation = null;
  }
  renderTransportMetricsHint();
}

function buildServiceOrder(primaryKey, intent = "url") {
  const normalizedIntent = normalizeIntent(intent);
  const priorityTemplate = normalizedIntent === "search" ? SERVICE_PRIORITY_SEARCH : SERVICE_PRIORITY_DEFAULT;
  const desiredOrder = [primaryKey, ...priorityTemplate, ...SERVICE_KEYS];
  const unique = [];
  desiredOrder.forEach((key) => {
    if (services[key] && !unique.includes(key)) {
      unique.push(key);
    }
  });
  if (unique.length <= 1) {
    return unique;
  }
  const [primary, ...rest] = unique;
  const sortedRest = rest.sort((a, b) => getServiceScore(b, normalizedIntent) - getServiceScore(a, normalizedIntent));
  return [primary, ...sortedRest];
}

function launchWithService(serviceKey, targetUrl, { fallback = false, meta } = {}) {
  setActiveService(serviceKey, { userInitiated: !fallback && serviceKey === userSelectedService });
  const intent = normalizeIntent(meta?.intent);
  const enrichedMeta = { ...meta, intent, transport: transportPreference };
  beginServiceAttempt(serviceKey, intent);
  const outboundUrl = composeProxyUrl(targetUrl, serviceKey, enrichedMeta);
  if (selectors.frame) {
    selectors.framePlaceholder?.classList.add("is-hidden");
    selectors.frame.src = outboundUrl;
    setWorkspaceStatus(`Routing via ${services[serviceKey].name}.`);
  } else {
    const newTab = window.open(outboundUrl, "_blank", "noopener,noreferrer");
    if (!newTab) {
      finalizeServiceAttempt(false);
      setStatus("Allow pop-ups or enable the embedded workspace to view pages.", true);
    } else {
      finalizeServiceAttempt(true);
      setStatus(`Opened ${services[serviceKey].name} in a new tab.`);
    }
  }
}

function tryServiceFallback() {
  if (!lastNavigation) {
    return false;
  }
  lastNavigation.index += 1;
  const nextKey = lastNavigation.order[lastNavigation.index];
  if (!nextKey) {
    if (advanceSearchProvider()) {
      return true;
    }
    lastNavigation = null;
    return false;
  }
  setStatus(`Retrying via ${services[nextKey].name}...`, false);
  launchWithService(nextKey, lastNavigation.targetUrl, { fallback: true, meta: lastNavigation.meta });
  return true;
}

function advanceSearchProvider(reasonMessage) {
  if (!lastNavigation || lastNavigation.meta.intent !== "search") {
    return false;
  }
  const currentIndex = lastNavigation.meta.searchProviderIndex ?? 0;
  if (currentIndex >= SEARCH_PROVIDERS.length - 1) {
    return false;
  }
  const nextIndex = currentIndex + 1;
  const provider = SEARCH_PROVIDERS[nextIndex] || SEARCH_PROVIDERS[0];
  if (!lastNavigation.rawInput) {
    return false;
  }
  lastNavigation.meta.searchProviderIndex = nextIndex;
  lastNavigation.meta.searchProviderLabel = provider.label;
  lastNavigation.targetUrl = provider.buildUrl(lastNavigation.rawInput);
  lastNavigation.order = buildServiceOrder(userSelectedService, "search");
  lastNavigation.index = 0;
  const baseMessage = `Switching to ${provider.label} results...`;
  const message = reasonMessage ? `${reasonMessage} ${baseMessage}` : baseMessage;
  setStatus(message, true);
  cancelActiveServiceAttempt();
  launchWithService(lastNavigation.order[0], lastNavigation.targetUrl, { meta: lastNavigation.meta });
  return true;
}
const SEARCH_PROVIDERS = [
  {
    label: "DuckDuckGo Lite",
    buildUrl: (term) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(term)}&ia=web`,
  },
  {
    label: "DuckDuckGo HTML",
    buildUrl: (term) => `https://duckduckgo.com/html/?q=${encodeURIComponent(term)}&ia=web`,
  },
  {
    label: "Brave Search",
    buildUrl: (term) => `https://search.brave.com/search?q=${encodeURIComponent(term)}`,
  },
];
