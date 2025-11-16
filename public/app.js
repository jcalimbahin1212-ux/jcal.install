/**
 * Unidentified client script
 * Handles proxy selection, query normalization, and UX toggles.
 */

const services = {
  supersonic: {
    name: "SuperSonic Balanced",
    description: "Balanced rewrite mode for everyday browsing.",
    mode: "standard",
    compose(targetUrl, meta = {}) {
      return buildSuperSonicLink(targetUrl, {
        mode: this.mode,
        intent: meta?.intent,
        transport: meta?.transport,
        session: meta?.sessionId,
        cacheTag: meta?.cacheKey,
      });
    },
  },
  supersonic_headless: {
    name: "SuperSonic Headless",
    description: "Routes through the headless renderer for complex sites.",
    mode: "headless",
    render: "headless",
    compose(targetUrl, meta = {}) {
      return buildSuperSonicLink(targetUrl, {
        mode: this.mode,
        render: this.render,
        intent: meta?.intent,
        transport: meta?.transport,
        session: meta?.sessionId,
        cacheTag: meta?.cacheKey,
      });
    },
  },
  supersonic_lite: {
    name: "SuperSonic Lite",
    description: "Lightweight mode optimized for speed.",
    mode: "lite",
    compose(targetUrl, meta = {}) {
      return buildSuperSonicLink(targetUrl, {
        mode: this.mode,
        intent: meta?.intent,
        transport: meta?.transport,
        session: meta?.sessionId,
        cacheTag: meta?.cacheKey,
      });
    },
  },
};
const SERVICE_KEYS = Object.keys(services);
const SERVICE_PRIORITY_DEFAULT = ["supersonic", "supersonic_headless", "supersonic_lite"];
const SERVICE_PRIORITY_SEARCH = ["supersonic", "supersonic_lite", "supersonic_headless"];
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
const DEV_CACHE_REFRESH_MS = 30_000;
const DEV_USER_REFRESH_MS = 45_000;
const DEV_LOG_REFRESH_MS = 20_000;
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
  authOverlay: document.querySelector("#auth-overlay"),
  authForm: document.querySelector("#auth-form"),
  authInput: document.querySelector("#auth-code"),
  authError: document.querySelector("#auth-error"),
  bridgeOverlay: document.querySelector("#bridge-overlay"),
  bridgeForm: document.querySelector("#bridge-form"),
  bridgeInput: document.querySelector("#bridge-code"),
  bridgeError: document.querySelector("#bridge-error"),
  usernameOverlay: document.querySelector("#username-overlay"),
  usernameForm: document.querySelector("#username-form"),
  usernameInput: document.querySelector("#username-input"),
  usernameError: document.querySelector("#username-error"),
  devOverlay: document.querySelector("#dev-overlay"),
  devForm: document.querySelector("#dev-form"),
  devInput: document.querySelector("#dev-code"),
  devError: document.querySelector("#dev-error"),
  devDashboard: document.querySelector("#dev-dashboard"),
  devCacheList: document.querySelector("#dev-cache-list"),
  devCurrentCache: document.querySelector("#dev-current-cache"),
  devUserList: document.querySelector("#dev-user-list"),
  devLogList: document.querySelector("#dev-log-list"),
  devLauncher: document.querySelector("#dev-launcher"),
  transportChips: document.querySelectorAll(".transport-chip"),
  transportStateLabel: document.querySelector("#transport-state-label"),
  transportHint: document.querySelector("#transport-metrics-hint"),
  diagSafezone: document.querySelector("#diag-safezone"),
  diagCache: document.querySelector("#diag-cache"),
  diagRequests: document.querySelector("#diag-requests"),
  diagHeadless: document.querySelector("#diag-headless"),
  diagLatency: document.querySelector("#diag-latency"),
  diagRefresh: document.querySelector("#diag-refresh"),
  diagPing: document.querySelector("#diag-ping"),
  diagLog: document.querySelector("#diag-log"),
  diagRequestId: document.querySelector("#diag-request-id"),
  userScriptInput: document.querySelector("#userscript-input"),
  userScriptSave: document.querySelector("#userscript-save"),
  userScriptClear: document.querySelector("#userscript-clear"),
  userScriptStatus: document.querySelector("#userscript-status"),
};

const DEVICE_COOKIE_NAME = "supersonic_device";
const deviceFingerprint = readDeviceFingerprint();

const historyKey = "unidentified:last-query";
const historyPrefKey = "unidentified:history-pref";
const panicKeyPref = "unidentified:panic-key";
const autoBlankPref = "unidentified:auto-blank";
const autoBlankResetFlag = "supersonic:auto-blank-reset-v2";
const authStorageKey = "supersonic:auth";
const devStorageKey = "supersonic:dev-session";
const authCacheStorageKey = "supersonic:auth-cache";
const userIdentityKey = "supersonic:user-info";
const localBanStorageKey = "supersonic:ban-state";
const AUTH_PASSCODE = "12273164-JC";
const AUTH_PASSCODE_NORMALIZED = normalizeAuthInput(AUTH_PASSCODE);
const DEV_ENTRY_CODE = "uG45373098!";
const DEV_STAGE_TWO_CODE = "jamesem.2138826";
const DEV_PASSCODE = "F!ndYourJ0y!";
const DEV_STAGE_TWO_NORMALIZED = normalizeAuthInput(DEV_STAGE_TWO_CODE);
const DEV_ENTRY_CODE_NORMALIZED = normalizeAuthInput(DEV_ENTRY_CODE);
const DEV_PASSCODE_NORMALIZED = normalizeAuthInput(DEV_PASSCODE);
const DEV_ENTRY_WINDOW_MS = 180_000;
const USER_STATUS_INTERVAL_MS = 10_000;
const DEFAULT_LOCKOUT_MESSAGE =
  "you tried getting in, didnt you. why would you do that without my permission. i trusted that you would see the password screen and ask me for the password. you little rulebreaker.";
const transportPrefKey = "supersonic:transport-pref";
const userScriptPrefKey = "supersonic:user-script";
const realTitle = document.title;
const cloakTitleFallback = "Class Notes - Google Docs";
const cloakFavicon = "https://ssl.gstatic.com/docs/doclist/images/infinite_arrow_favicon_5.ico";
const faviconLink = ensureFaviconLink();
const realFaviconHref = faviconLink?.href || "";

const isCloakedContext = window.name === "unidentified-cloak";
const isAboutBlankContext = window.location.protocol === "about:";

let activeService = "supersonic";
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
let authUnlocked = localStorage.getItem(authStorageKey) === "yes";
let devUnlocked = sessionStorage.getItem(devStorageKey) === "yes";
let devEntryTimer = null;
let primedNavigationTokens = restorePrimedNavigationTokens();
let userIdentity = loadUserIdentity();
enforceDeviceUid();
let currentCacheTag = new URLSearchParams(window.location.search).get("cache");
let lastNavigation = null;
let devCacheRefreshTimer = null;
let devUserRefreshTimer = null;
let devLogRefreshTimer = null;
let transportPreference = normalizeTransportPref(localStorage.getItem(transportPrefKey) || "auto");
const DIAGNOSTICS_REFRESH_MS = 15_000;
const DIAGNOSTICS_LOG_LIMIT = 18;
let diagnosticsTimer = null;
const diagnosticsLogEntries = [];
let lastDiagnosticsStats = null;
let userStatusTimer = null;
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
bootstrapSession();

function bootstrapSession() {
  enforceLocalBanGate().then((blocked) => {
    if (blocked) {
      return;
    }
    continueSessionBootstrap();
  });
}

function continueSessionBootstrap() {
  updateCurrentCacheDisplay();
  if (devUnlocked) {
    document.body.classList.add("dev-mode");
  }
  if (userIdentity) {
    document.body.dataset.username = userIdentity.username;
    document.body.dataset.uid = userIdentity.uid;
    registerUserIdentity(userIdentity);
    startUserStatusMonitor(true);
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
  hydrateUserScriptSettings();
  startDiagnosticsPanel();
  initializeAuthGate();
}

async function enforceLocalBanGate() {
  const banState = readLocalBanState();
  if (!banState) {
    return false;
  }
  if (banState.uid) {
    try {
      const url = new URL(`/dev/users/status/${encodeURIComponent(banState.uid)}`, window.location.origin);
      if (banState.username) {
        url.searchParams.set("uname", banState.username);
      }
      const response = await fetch(url.toString(), {
        cache: "no-store",
      });
      if (response.ok) {
        const payload = await response.json();
        if (payload.allowed !== false) {
          clearLocalBanState();
          return false;
        }
      }
    } catch {
      // fail closed
    }
  }
  showAuthLockoutScreen(banState.message || "banned.");
  return true;
}

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
      const meta = {};
      const targetUrl = buildNavigationTarget(rawValue, meta);
      stampNavigationTokens(meta, { renew: true });
      const intent = meta.intent;
      meta.transport = resolveTransportForIntent(intent);
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
    setStatus("Page loaded inside SuperSonic.");
    injectUserScriptIntoFrame();
    lastNavigation = null;
    userSelectedService = activeService;
    renderProxyMetadataFromFrame();
  });

  selectors.frame?.addEventListener("error", () => {
    finalizeServiceAttempt(false);
    selectors.framePlaceholder?.classList.remove("is-hidden");
    setWorkspaceStatus("Could not load that page.");
    if (!tryServiceFallback()) {
      setStatus("Unable to load the requested page.", true);
    }
    logDiagnostics("Frame navigation errored; attempting fallback.", "warn");
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
      clearInjectedUserScript();
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
  selectors.bridgeForm?.addEventListener("submit", handleBridgeSubmit);
  selectors.devForm?.addEventListener("submit", handleDevAuthSubmit);
  selectors.devCacheList?.addEventListener("click", handleDevCacheActionClick);
  selectors.devUserList?.addEventListener("click", handleDevUserActionClick);
  selectors.usernameForm?.addEventListener("submit", handleUsernameSubmit);
  selectors.devLauncher?.addEventListener("click", () => {
    if (document.body.classList.contains("dev-mode")) {
      enableDevDashboard();
      return;
    }
    selectors.authOverlay?.classList.add("is-hidden");
    selectors.bridgeOverlay?.classList.remove("is-hidden");
    selectors.bridgeError?.classList.remove("is-visible");
    if (selectors.bridgeInput) {
      selectors.bridgeInput.value = "";
    }
    startDevEntryTimer();
    window.setTimeout(() => selectors.bridgeInput?.focus(), 100);
  });

  updateFullscreenButton();
  selectors.diagRefresh?.addEventListener("click", () => refreshDiagnostics({ userInitiated: true }));
  selectors.diagPing?.addEventListener("click", () => runHealthPing());
  window.addEventListener("beforeunload", () => {
    if (diagnosticsTimer) {
      clearInterval(diagnosticsTimer);
      diagnosticsTimer = null;
    }
  });
}

function initializeAuthGate() {
  if (userIdentity?.uid) {
    verifyUserStatus(userIdentity).then((allowed) => {
      if (!allowed) {
        handleUserBan();
      } else {
        clearLocalBanState();
        startAuthFlow();
      }
    });
    return;
  }
  startAuthFlow();
}

function startAuthFlow() {
  if (devUnlocked) {
    authUnlocked = true;
    selectors.authOverlay?.classList.add("is-hidden");
    selectors.bridgeOverlay?.classList.add("is-hidden");
    selectors.devOverlay?.classList.add("is-hidden");
    releaseAuthGate();
    return;
  }
  if (authUnlocked && !userIdentity) {
    selectors.authOverlay?.classList.add("is-hidden");
    promptUsernameCapture();
    return;
  }
  if (authUnlocked) {
    releaseAuthGate();
    primeAuthenticationCache();
    return;
  }
  document.body.classList.add("auth-locked");
  selectors.authOverlay?.classList.remove("is-hidden");
  selectors.authError && (selectors.authError.textContent = "");
  selectors.authError?.classList.remove("is-visible");
  selectors.authForm?.addEventListener("submit", handleAuthSubmit);
  window.setTimeout(() => selectors.authInput?.focus(), 100);
}

function handleAuthSubmit(event) {
  event.preventDefault();
  const provided = normalizeAuthInput(selectors.authInput?.value || "");
  if (provided === DEV_ENTRY_CODE_NORMALIZED) {
    triggerBridgeHandshake();
    return;
  }
  if (provided === AUTH_PASSCODE_NORMALIZED) {
    if (!userIdentity) {
      selectors.authOverlay?.classList.add("is-hidden");
      promptUsernameCapture();
      return;
    }
    authUnlocked = true;
    localStorage.setItem(authStorageKey, "yes");
    releaseAuthGate();
    return;
  }
  if (selectors.authError) {
    selectors.authError.textContent = "Incorrect access code.";
    selectors.authError.classList.add("is-visible");
  }
  showAuthLockoutScreen();
}

function releaseAuthGate() {
  selectors.authForm?.removeEventListener("submit", handleAuthSubmit);
  const overlayNode = selectors.authOverlay;
  if (overlayNode) {
    overlayNode.classList.add("is-hidden");
  }
  document.body.classList.remove("auth-locked");
  if (selectors.authInput) {
    selectors.authInput.value = "";
  }
  if (selectors.authError) {
    selectors.authError.textContent = "";
    selectors.authError.classList.remove("is-visible");
  }
  selectors.bridgeOverlay?.classList.add("is-hidden");
  selectors.bridgeError?.classList.remove("is-visible");
  selectors.devOverlay?.classList.add("is-hidden");
  selectors.devError?.classList.remove("is-visible");
  if (devUnlocked) {
    sessionStorage.setItem(devStorageKey, "yes");
    document.body.classList.add("dev-mode");
    enableDevDashboard();
  } else {
    document.body.classList.remove("dev-mode");
    disableDevDashboard();
  }
  clearLocalBanState();
  if (userIdentity?.uid) {
    startUserStatusMonitor();
  } else {
    cancelUserStatusMonitor();
  }
  if (autoBlankEnabled && !cloakLaunched) {
    attemptAutoBlank(true);
  }
  primeAuthenticationCache(true);
  setStatus("Access confirmed. Welcome back to SuperSonic.");
}

function triggerBridgeHandshake() {
  selectors.authOverlay?.classList.add("is-hidden");
  selectors.bridgeOverlay?.classList.remove("is-hidden");
  selectors.bridgeError?.classList.remove("is-visible");
  selectors.devOverlay?.classList.add("is-hidden");
  if (selectors.bridgeInput) {
    selectors.bridgeInput.value = "";
  }
  startDevEntryTimer();
  window.setTimeout(() => selectors.bridgeInput?.focus(), 100);
}

function handleBridgeSubmit(event) {
  event.preventDefault();
  const provided = normalizeAuthInput(selectors.bridgeInput?.value || "");
  if (provided === DEV_STAGE_TWO_NORMALIZED) {
    selectors.bridgeOverlay?.classList.add("is-hidden");
    triggerDevHandshake();
    return;
  }
  if (selectors.bridgeError) {
    selectors.bridgeError.textContent = "Stage-two code incorrect.";
    selectors.bridgeError.classList.add("is-visible");
  }
  resetDevProcess();
  showAuthLockoutScreen();
}

function triggerDevHandshake() {
  selectors.devOverlay?.classList.remove("is-hidden");
  if (selectors.devInput) {
    selectors.devInput.value = "";
  }
  selectors.devError && (selectors.devError.textContent = "");
  selectors.devError?.classList.remove("is-visible");
  window.setTimeout(() => selectors.devInput?.focus(), 100);
}

function handleDevAuthSubmit(event) {
  event.preventDefault();
  const provided = normalizeAuthInput(selectors.devInput?.value || "");
  if (provided === DEV_PASSCODE_NORMALIZED) {
    cancelDevEntryTimer();
    devUnlocked = true;
    authUnlocked = true;
    sessionStorage.setItem(devStorageKey, "yes");
    localStorage.setItem(authStorageKey, "yes");
    selectors.devOverlay?.classList.add("is-hidden");
    releaseAuthGate();
    setStatus("Developer workspace ready.");
    return;
  }
  if (selectors.devError) {
    selectors.devError.textContent = "Developer access denied.";
    selectors.devError.classList.add("is-visible");
  }
  resetDevProcess();
  showAuthLockoutScreen();
}

function showAuthLockoutScreen(message = DEFAULT_LOCKOUT_MESSAGE) {
  if (document.querySelector(".lockout-overlay")) {
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "lockout-overlay";
  overlay.innerHTML = `<div class="lockout-overlay__content">${message}</div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("is-active"));
  window.setTimeout(() => {
    try {
      window.close();
    } catch {
      window.location.replace("about:blank");
    }
  }, 5000);
}

function handleUsernameSubmit(event) {
  event.preventDefault();
  const entered = selectors.usernameInput?.value?.trim() || "";
  const sanitized = sanitizeUsername(entered);
  if (sanitized.length < 3) {
    if (selectors.usernameError) {
      selectors.usernameError.textContent = "Username must be at least 3 characters.";
      selectors.usernameError.classList.add("is-visible");
    }
    return;
  }
  const identity = {
    username: sanitized,
    uid: getDeviceUid() || userIdentity?.uid || generateUserUid(),
  };
  verifyUserStatus(identity).then((allowed) => {
    if (!allowed) {
      handleUserBan("banned.", identity);
      return;
    }
    saveUserIdentity(identity);
    selectors.usernameOverlay?.classList.add("is-hidden");
    authUnlocked = true;
    localStorage.setItem(authStorageKey, "yes");
    releaseAuthGate();
  });
}

function attachUserMetadataToUrl(urlString, meta = {}) {
  if (!meta?.user?.uid && !meta?.intent && !userIdentity?.uid) {
    return urlString;
  }
  const absolute = new URL(urlString, window.location.origin);
  const uidValue = meta?.user?.uid || userIdentity?.uid;
  const usernameValue = meta?.user?.username || userIdentity?.username;
  if (uidValue) {
    absolute.searchParams.set("uid", uidValue);
  }
  if (usernameValue) {
    absolute.searchParams.set("uname", usernameValue);
  }
  if (meta?.intent) {
    absolute.searchParams.set("intent", meta.intent);
  }
  if (absolute.origin === window.location.origin) {
    return `${absolute.pathname}${absolute.search}${absolute.hash}`;
  }
  return absolute.toString();
}

function updateHistoryParams() {
  if (typeof window === "undefined") return;
  try {
    const currentUrl = new URL(window.location.href);
    if (currentCacheTag) {
      currentUrl.searchParams.set("cache", currentCacheTag);
    }
    if (userIdentity?.uid) {
      currentUrl.searchParams.set("uid", userIdentity.uid);
    }
    window.history.replaceState(null, "", currentUrl.toString());
  } catch {
    /* ignore */
  }
}

function promptUsernameCapture() {
  selectors.usernameOverlay?.classList.remove("is-hidden");
  selectors.usernameError?.classList.remove("is-visible");
  selectors.usernameInput && (selectors.usernameInput.value = userIdentity?.username || "");
  window.setTimeout(() => selectors.usernameInput?.focus(), 100);
}

function loadUserIdentity() {
  try {
    const stored = localStorage.getItem(userIdentityKey);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (parsed && parsed.username && parsed.uid) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function getDeviceUid() {
  return deviceFingerprint || readDeviceFingerprint();
}

function readDeviceFingerprint() {
  if (typeof document === "undefined") {
    return null;
  }
  const cookies = document.cookie
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const target = cookies.find((entry) => entry.startsWith(`${DEVICE_COOKIE_NAME}=`));
  if (!target) {
    return null;
  }
  return target.split("=")[1] || null;
}

function enforceDeviceUid() {
  const deviceId = getDeviceUid();
  if (!deviceId) {
    return;
  }
  if (!userIdentity) {
    try {
      const stored = localStorage.getItem(userIdentityKey);
      if (stored) {
        userIdentity = JSON.parse(stored);
      }
    } catch {
      userIdentity = null;
    }
  }
  if (userIdentity?.uid !== deviceId) {
    userIdentity = userIdentity ? { ...userIdentity, uid: deviceId } : { username: "", uid: deviceId };
    try {
      localStorage.setItem(userIdentityKey, JSON.stringify(userIdentity));
    } catch {
      /* ignore */
    }
  }
}

function saveUserIdentity(identity) {
  if (!identity) return;
  identity.uid = getDeviceUid() || identity.uid;
  userIdentity = identity;
  try {
    localStorage.setItem(userIdentityKey, JSON.stringify(identity));
  } catch {
    /* ignore */
  }
  document.body.dataset.username = identity.username;
  document.body.dataset.uid = identity.uid;
  registerUserIdentity(identity);
  updateCurrentCacheDisplay();
  startUserStatusMonitor(true);
}

function resetUserIdentity() {
  userIdentity = null;
  document.body.dataset.username = "";
  document.body.dataset.uid = "";
  try {
    localStorage.removeItem(userIdentityKey);
  } catch {
    /* ignore */
  }
  cancelUserStatusMonitor();
}

async function verifyUserStatus(identity) {
  if (!identity?.uid) {
    return true;
  }
  try {
    const url = new URL(`/dev/users/status/${encodeURIComponent(identity.uid)}`, window.location.origin);
    if (identity.username) {
      url.searchParams.set("uname", identity.username);
    }
    const response = await fetch(url.toString(), {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      return true;
    }
    const payload = await response.json();
    return payload.allowed !== false;
  } catch {
    return true;
  }
}

function registerUserIdentity(identity) {
  if (!identity?.uid) return;
  fetch("/dev/users/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(identity),
  })
    .then((response) => {
      if (!response.ok && response.status === 451) {
        handleUserBan("banned.", identity);
      }
    })
    .catch(() => {});
}

function readLocalBanState() {
  try {
    const raw = localStorage.getItem(localBanStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        uid: parsed.uid || null,
        username: parsed.username || null,
        message: parsed.message || "banned.",
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function persistLocalBanState(identity, message = "banned.") {
  const payload = {
    uid: identity?.uid || null,
    username: identity?.username ? sanitizeUsername(identity.username) : null,
    message,
  };
  try {
    localStorage.setItem(localBanStorageKey, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function clearLocalBanState() {
  try {
    localStorage.removeItem(localBanStorageKey);
  } catch {
    /* ignore */
  }
}

function handleUserBan(message = "banned.", identity = userIdentity) {
  persistLocalBanState(identity, message);
  cancelUserStatusMonitor();
  resetUserIdentity();
  showAuthLockoutScreen(message);
}

function startUserStatusMonitor(immediate = false) {
  cancelUserStatusMonitor();
  if (!userIdentity?.uid) {
    return;
  }
  const checkStatus = async () => {
    const allowed = await verifyUserStatus(userIdentity);
    if (allowed) {
      return;
    }
    handleUserBan("banned.", userIdentity);
  };
  if (immediate) {
    checkStatus();
  }
  userStatusTimer = window.setInterval(checkStatus, USER_STATUS_INTERVAL_MS);
}

function cancelUserStatusMonitor() {
  if (!userStatusTimer) {
    return;
  }
  clearInterval(userStatusTimer);
  userStatusTimer = null;
}

function generateUserUid() {
  return `uid-${Math.random().toString(36).slice(2, 7)}${Date.now().toString(36).slice(-5)}`;
}

function sanitizeUsername(value) {
  return value.replace(/[^a-z0-9_\- ]/gi, "").trim().slice(0, 32);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTimestamp(value) {
  if (!value && value !== 0) {
    return "never";
  }
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) {
    return "never";
  }
  return date.toLocaleString();
}

function startDevEntryTimer() {
  cancelDevEntryTimer();
  devEntryTimer = window.setTimeout(() => {
    resetDevProcess();
    showAuthLockoutScreen("did you just.. make an attempt to access my dev server..? quit doing that.");
  }, DEV_ENTRY_WINDOW_MS);
}

function cancelDevEntryTimer() {
  if (devEntryTimer) {
    clearTimeout(devEntryTimer);
    devEntryTimer = null;
  }
}

function resetDevProcess() {
  cancelDevEntryTimer();
  selectors.bridgeOverlay?.classList.add("is-hidden");
  selectors.devOverlay?.classList.add("is-hidden");
  selectors.authOverlay?.classList.remove("is-hidden");
  selectors.bridgeInput && (selectors.bridgeInput.value = "");
  selectors.devInput && (selectors.devInput.value = "");
  selectors.bridgeError?.classList.remove("is-visible");
  selectors.devError?.classList.remove("is-visible");
  devUnlocked = false;
  sessionStorage.removeItem(devStorageKey);
  document.body.classList.remove("dev-mode");
  disableDevDashboard();
}

function enableDevDashboard() {
  if (!selectors.devDashboard) return;
  selectors.devDashboard.hidden = false;
  refreshDevCacheList();
  refreshDevUserList();
  refreshDevLogList();
  if (!devCacheRefreshTimer) {
    devCacheRefreshTimer = window.setInterval(refreshDevCacheList, DEV_CACHE_REFRESH_MS);
  }
  if (!devUserRefreshTimer) {
    devUserRefreshTimer = window.setInterval(refreshDevUserList, DEV_USER_REFRESH_MS);
  }
  if (!devLogRefreshTimer) {
    devLogRefreshTimer = window.setInterval(refreshDevLogList, DEV_LOG_REFRESH_MS);
  }
  updateCurrentCacheDisplay();
}

function disableDevDashboard() {
  selectors.devDashboard?.setAttribute("hidden", "true");
  if (selectors.devCacheList) {
    selectors.devCacheList.textContent = "Dev mode inactive.";
  }
  if (selectors.devUserList) {
    selectors.devUserList.textContent = "Dev mode inactive.";
  }
  if (selectors.devLogList) {
    selectors.devLogList.textContent = "Dev mode inactive.";
  }
  if (devCacheRefreshTimer) {
    clearInterval(devCacheRefreshTimer);
    devCacheRefreshTimer = null;
  }
  if (devUserRefreshTimer) {
    clearInterval(devUserRefreshTimer);
    devUserRefreshTimer = null;
  }
  if (devLogRefreshTimer) {
    clearInterval(devLogRefreshTimer);
    devLogRefreshTimer = null;
  }
}

async function refreshDevCacheList() {
  if (!document.body.classList.contains("dev-mode") || !selectors.devCacheList) return;
  try {
    const response = await fetch("/dev/cache", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    renderDevCacheEntries(payload);
  } catch (error) {
    selectors.devCacheList.textContent = `Failed to load cache list: ${error.message}`;
  }
}

function renderDevCacheEntries(entries = []) {
  if (!selectors.devCacheList) return;
  if (!entries.length) {
    selectors.devCacheList.textContent = "No cache entries available.";
    return;
  }
  const fragment = entries
    .map((entry) => {
      const expiresLabel =
        entry.expiresAt && Number.isFinite(entry.expiresAt) ? formatTimestamp(entry.expiresAt) : "session";
      const keyLabel = escapeHtml(entry.key || "unknown");
      const rendererLabel = escapeHtml(entry.renderer || "direct");
      const userLabel =
        entry.user && entry.user.uid
          ? `${escapeHtml(entry.user.username || "unknown")} (${escapeHtml(entry.user.uid)})`
          : "";
      const statusLabel = entry.banned ? " | status: banned" : "";
      const userSegment = userLabel ? ` | user: ${userLabel}` : "";
      return `<div class="dev-cache-entry" data-cache-key="${escapeHtml(entry.key || "")}">
        <div class="dev-cache-entry__meta">
          <strong>${keyLabel}</strong> | renderer ${rendererLabel} | expires ${escapeHtml(expiresLabel)}${userSegment}${statusLabel}
        </div>
        <div class="dev-cache-entry__actions">
          <button data-cache-action="kick">Lock once</button>
          <button data-cache-action="ban">Lock permanently</button>
          <button data-cache-action="rotate">Allow pass reset</button>
        </div>
      </div>`;
    })
    .join("");
  selectors.devCacheList.innerHTML = fragment;
}

async function sendDevCacheAction(key, action) {
  try {
    await fetch(`/dev/cache/${encodeURIComponent(key)}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    refreshDevCacheList();
  } catch (error) {
    console.error("[SuperSonic] dev cache action failed", error);
  }
}

function handleDevCacheActionClick(event) {
  const button = event.target.closest("[data-cache-action]");
  if (!button) return;
  const container = button.closest(".dev-cache-entry");
  const key = container?.dataset.cacheKey;
  const action = button.dataset.cacheAction;
  if (key && action) {
    sendDevCacheAction(key, action);
  }
}

async function refreshDevUserList() {
  if (!document.body.classList.contains("dev-mode") || !selectors.devUserList) return;
  try {
    const response = await fetch("/dev/users", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    renderDevUserEntries(payload);
  } catch (error) {
    selectors.devUserList.textContent = `Failed to load users: ${error.message}`;
  }
}

function renderDevUserEntries(users = []) {
  if (!selectors.devUserList) return;
  if (!users.length) {
    selectors.devUserList.textContent = "No users yet.";
    return;
  }
  const fragment = users
    .map((user) => {
      const uid = escapeHtml(user.uid || "unknown");
      const username = escapeHtml(user.username || "unknown");
      const statusLabel = user.banned ? "Status: banned" : "Status: active";
      const lastSeen = escapeHtml(formatTimestamp(user.lastSeen));
      const banAction = user.banned ? "unban" : "ban";
      const banLabel = user.banned ? "Lift ban" : "Lock permanently";
      return `<div class="dev-user-entry" data-uid="${uid}" data-username="${username}">
        <div class="dev-user-entry__meta">
          <strong>${username}</strong>
          <span class="dev-user-entry__uid">${uid}</span>
        </div>
        <div class="dev-user-entry__details">${statusLabel} | last seen ${lastSeen}</div>
        <div class="dev-user-entry__actions">
          <button data-user-action="${banAction}">${banLabel}</button>
          <button data-user-action="rename">Rename</button>
        </div>
      </div>`;
    })
    .join("");
  selectors.devUserList.innerHTML = fragment;
}

async function sendDevUserAction(uid, action, payload = {}) {
  try {
    await fetch(`/dev/users/${encodeURIComponent(uid)}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    refreshDevUserList();
  } catch (error) {
    console.error("[SuperSonic] dev user action failed", error);
  }
}

function handleDevUserActionClick(event) {
  const button = event.target.closest("[data-user-action]");
  if (!button) return;
  const container = button.closest(".dev-user-entry");
  const uid = container?.dataset.uid;
  const action = button.dataset.userAction;
  if (!uid || !action) {
    return;
  }
  if (action === "rename") {
    const currentName = container?.dataset.username || "";
    const proposed = window.prompt("Enter new username for this UID:", currentName);
    const sanitized = sanitizeUsername(proposed || "");
    if (!sanitized || sanitized.length < 3) {
      setStatus("Username must be at least 3 characters for rename.", true);
      return;
    }
    sendDevUserAction(uid, action, { username: sanitized });
    return;
  }
  sendDevUserAction(uid, action);
}

async function refreshDevLogList() {
  if (!document.body.classList.contains("dev-mode") || !selectors.devLogList) return;
  try {
    const response = await fetch("/dev/logs", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    renderDevLogEntries(payload);
  } catch (error) {
    selectors.devLogList.textContent = `Failed to load logs: ${error.message}`;
  }
}

function renderDevLogEntries(entries = []) {
  if (!selectors.devLogList) return;
  if (!entries.length) {
    selectors.devLogList.textContent = "No activity logged.";
    return;
  }
  const fragment = entries
    .map((entry) => {
      const username = escapeHtml(entry.username || "unknown");
      const uid = escapeHtml(entry.uid || "unknown");
      const when = escapeHtml(formatTimestamp(entry.timestamp));
      const intent = escapeHtml(normalizeIntent(entry.intent || "url"));
      const renderer = escapeHtml(entry.renderer || "direct");
      const status = escapeHtml(String(entry.status ?? "n/a"));
      const target = escapeHtml(describeTargetForLog(entry.target || "unknown"));
      return `<div class="dev-log-entry">
        <div><strong>${username}</strong> <span class="dev-log-entry__meta">${uid}</span></div>
        <div class="dev-log-entry__details">${when} | ${intent} via ${renderer} | status ${status}</div>
        <div class="dev-log-entry__target">${target}</div>
      </div>`;
    })
    .join("");
  selectors.devLogList.innerHTML = fragment;
}

function updateCurrentCacheDisplay() {
  if (selectors.devCurrentCache) {
    selectors.devCurrentCache.textContent = currentCacheTag || "n/a";
  }
}

function composeProxyUrl(targetUrl, serviceKey = activeService, meta) {
  const service = services[serviceKey];
  if (!service) {
    throw new Error("Pick a relay personality to continue.");
  }
  const enrichedMeta = {
    ...meta,
    user: userIdentity,
  };
  if (meta?.localProvider) {
    return attachUserMetadataToUrl(targetUrl, enrichedMeta);
  }
  const composed = service.compose(targetUrl, enrichedMeta);
  return attachUserMetadataToUrl(composed, enrichedMeta);
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
  meta.localProvider = provider.type === "local";
  const built = provider.buildUrl(input);
  if (provider.type === "local") {
    try {
      return new URL(built, window.location.origin).toString();
    } catch {
      return `${window.location.origin}${built.startsWith("/") ? built : `/${built}`}`;
    }
  }
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

function buildSuperSonicLink(targetUrl, config = {}, renderOverride) {
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
  const cacheTagValue = typeof config === "object" ? config.cacheTag : undefined;
  if (cacheTagValue) {
    params.set("cache", cacheTagValue);
  } else {
    params.set("cache", createSessionNonce());
  }
  const sessionValue =
    typeof config === "object" && config.session ? config.session : createSessionNonce();
  const basePath = `/proxy/${sessionValue}/${encoded}`;
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function inspectFrameForProxyError() {
  if (!selectors.frame || !selectors.frame.contentDocument) return null;
  try {
    const doc = selectors.frame.contentDocument;
    const body = doc.body;
    if (!body) return null;
    const textContent = body.textContent?.trim() ?? "";
    if (textContent && textContent.length <= 2000) {
      const firstChar = textContent[0];
      if (firstChar === "{" || firstChar === "[") {
        const parsed = JSON.parse(textContent);
        if (parsed && typeof parsed.error === "string") {
          return parsed;
        }
      }
    }
    const bodyLower = doc.body?.innerText?.trim().toLowerCase() ?? "";
    if (
      bodyLower.includes("refused to connect") ||
      bodyLower.includes("blocked this request") ||
      bodyLower.includes("this website has been blocked by your administrator") ||
      bodyLower.includes("blocked.com-default.ws")
    ) {
      const host = (() => {
        try {
          const url = new URL(lastNavigation?.targetUrl || "");
          return url.hostname;
        } catch {
          return "The site";
        }
      })();
      return {
        error: `${host} refused to render inside a frame.`,
        details: "Falling back to headless renderer.",
      };
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
    if (!text.trim()) {
      const hasVisibleNodes = body.querySelector("*");
      if (!hasVisibleNodes) {
        return `${providerLabel} refused to render inside the workspace. Switching providers.`;
      }
    }
    if (text.includes("ran into an error displaying these results")) {
      return `${providerLabel} blocked the embedded results. Switching relays.`;
    }
    if (text.includes("please try again later") && text.includes("duckduckgo")) {
      return `${providerLabel} returned an error page.`;
    }
    if (text.includes("bots use duckduckgo too") || text.includes("select all squares containing a duck")) {
      return `${providerLabel} presented a captcha challenge. Switching providers automatically.`;
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
    logDiagnostics(`Safezone → ${transportState.safezone}.`);
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
  updateDiagnosticsSafezone();
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

function createSessionNonce() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeAuthInput(value) {
  if (!value) return "";
  return value
    .normalize("NFKD")
    .replace(/[^0-9a-zA-Z]/g, "")
    .toUpperCase();
}

function restorePrimedNavigationTokens() {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(authCacheStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.sessionId && parsed.cacheKey) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function stampNavigationTokens(meta, { renew = false } = {}) {
  if (!meta) return;
  if (!renew && primedNavigationTokens) {
    meta.sessionId = primedNavigationTokens.sessionId;
    meta.cacheKey = primedNavigationTokens.cacheKey;
    primedNavigationTokens = null;
    try {
      localStorage.removeItem(authCacheStorageKey);
    } catch {
      /* ignore */
    }
    currentCacheTag = meta.cacheKey || null;
    updateCurrentCacheDisplay();
    return;
  }
  if (renew || !meta.sessionId) {
    meta.sessionId = createSessionNonce();
  }
  if (renew || !meta.cacheKey) {
    meta.cacheKey = createSessionNonce();
  }
  currentCacheTag = meta.cacheKey || null;
  updateCurrentCacheDisplay();
}

function primeAuthenticationCache(force = false) {
  if (!("fetch" in window)) return;
  if (!force && primedNavigationTokens) return;
  const tokens = {
    sessionId: createSessionNonce(),
    cacheKey: createSessionNonce(),
  };
  primedNavigationTokens = tokens;
  try {
    localStorage.setItem(authCacheStorageKey, JSON.stringify(tokens));
  } catch {
    /* ignore storage errors */
  }
  const warmUrl = buildSuperSonicLink("https://duckduckgo.com/?q=SuperSonic+Safezone", {
    session: tokens.sessionId,
    cacheTag: tokens.cacheKey,
    intent: "url",
    transport: transportPreference,
  });
  fetch(warmUrl, { credentials: "same-origin", cache: "reload" }).catch(() => {});
}

function resolveTransportForIntent(intent) {
  if (transportPreference === "auto") {
    return intent === "search" ? "direct" : "auto";
  }
  return transportPreference;
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

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw-supersonic.js", { scope: "/" })
      .then(() => {
        console.info("[SuperSonic] service worker registered");
      })
      .catch((error) => {
        console.warn("[SuperSonic] failed to register service worker", error);
      });
  });
}

function listenForSwMessages() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.addEventListener("message", (event) => {
    const payload = event.data;
    if (!payload || payload.source !== "supersonic-sw") return;
    if (payload.type === "safezone-state") {
      updateSafezoneState(payload);
      return;
    }
    const { event: eventName, payload: eventPayload } = payload;
    if (eventName === "proxy-fetch-error") {
      setStatus(`SW proxy error: ${eventPayload.message}`, true);
      logDiagnostics(`SW proxy error: ${eventPayload.message}`, "error");
    } else if (eventName === "network-fallback-cache") {
      setStatus("Loaded offline copy from cache.", false);
      logDiagnostics("Offline cache served network request.");
    } else if (eventName === "safezone-timeout") {
      setStatus("Safezone timed out, relaying directly.", true);
      logDiagnostics(`Safezone timeout for ${eventPayload?.target ?? "unknown"}.`, "warn");
    } else if (eventName === "safezone-fetch-error") {
      logDiagnostics(`Safezone fetch error: ${eventPayload?.message ?? "unknown"}.`, "warn");
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
  logDiagnostics(`Transport preference → ${transportPreference}.`);
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
  const enrichedMeta = { ...meta, intent, transport: transportPreference, user: userIdentity };
  beginServiceAttempt(serviceKey, intent);
  const outboundUrl = composeProxyUrl(targetUrl, serviceKey, enrichedMeta);
  logDiagnostics(`Routing ${describeTargetForLog(targetUrl)} via ${services[serviceKey].name} (${intent}).`);
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
    logDiagnostics("All relay fallbacks exhausted.", "error");
    return false;
  }
  setStatus(`Retrying via ${services[nextKey].name}...`, false);
  logDiagnostics(`Fallback → ${services[nextKey].name}.`, "warn");
  stampNavigationTokens(lastNavigation.meta, { renew: true });
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
  if (provider.type === "local") {
    lastNavigation.targetUrl = new URL(provider.buildUrl(lastNavigation.rawInput), window.location.origin).toString();
    lastNavigation.meta.localProvider = true;
  } else {
    lastNavigation.targetUrl = provider.buildUrl(lastNavigation.rawInput);
    lastNavigation.meta.localProvider = false;
  }
  lastNavigation.order = buildServiceOrder(userSelectedService, "search");
  lastNavigation.index = 0;
  const baseMessage = `Switching to ${provider.label} results...`;
  const message = reasonMessage ? `${reasonMessage} ${baseMessage}` : baseMessage;
  setStatus(message, true);
  logDiagnostics(message, "warn");
  cancelActiveServiceAttempt();
  stampNavigationTokens(lastNavigation.meta, { renew: true });
  launchWithService(lastNavigation.order[0], lastNavigation.targetUrl, { meta: lastNavigation.meta });
  return true;
}

function startDiagnosticsPanel() {
  if (!selectors.diagSafezone) {
    return;
  }
  refreshDiagnostics({ silent: true }).finally(() => {
    diagnosticsTimer = window.setInterval(() => refreshDiagnostics({ silent: true }), DIAGNOSTICS_REFRESH_MS);
  });
}

async function refreshDiagnostics(options = {}) {
  if (!selectors.diagSafezone) {
    return;
  }
  try {
    const response = await fetch("/metrics", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    lastDiagnosticsStats = payload;
    if (selectors.diagRequests) {
      const latency = Math.round(payload.avgLatencyMs || 0);
      selectors.diagRequests.textContent = `${payload.requests ?? 0} req · ${latency} ms avg`;
    }
    if (selectors.diagCache) {
      const hitRate = Math.round(((payload.cacheHitRate ?? 0) * 100) || 0);
      selectors.diagCache.textContent = `${hitRate}% · ${payload.cacheSize ?? 0}/${payload.cacheMaxEntries ?? "∞"}`;
    }
    if (selectors.diagHeadless) {
      selectors.diagHeadless.textContent = `${payload.headlessActive ?? 0} live · ${payload.headlessFailures ?? 0} fail`;
    }
    updateDiagnosticsSafezone();
    if (!options.silent) {
      logDiagnostics(`Diagnostics refreshed${options.userInitiated ? " (manual)" : ""}.`);
    }
  } catch (error) {
    logDiagnostics(`Diagnostics refresh failed: ${error.message}`, "warn");
  }
}

async function runHealthPing() {
  if (!selectors.diagLatency) {
    return;
  }
  const started = performance.now();
  try {
    const response = await fetch("/health", { cache: "no-store" });
    const latency = Math.round(performance.now() - started);
    selectors.diagLatency.textContent = `${latency} ms`;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    logDiagnostics(`Health ping ok (${latency} ms).`);
  } catch (error) {
    const latency = Math.round(performance.now() - started);
    selectors.diagLatency.textContent = `error (${latency} ms)`;
    logDiagnostics(`Health ping failed: ${error.message}`, "error");
  }
}

function logDiagnostics(message, level = "info") {
  if (!selectors.diagLog) {
    return;
  }
  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] ${message}`;
  diagnosticsLogEntries.push(entry);
  if (diagnosticsLogEntries.length > DIAGNOSTICS_LOG_LIMIT) {
    diagnosticsLogEntries.shift();
  }
  selectors.diagLog.textContent = diagnosticsLogEntries.join("\n");
  selectors.diagLog.dataset.state = level;
}

function renderProxyMetadataFromFrame() {
  if (!selectors.frame || !selectors.frame.contentDocument) {
    return;
  }
  const meta = readProxyMetadata(selectors.frame.contentDocument);
  if (!meta) {
    return;
  }
  if (selectors.diagRequestId) {
    const rendererLabel = meta.renderer ? ` · ${meta.renderer}` : "";
    selectors.diagRequestId.textContent = meta.requestId ? `${meta.requestId}${rendererLabel}` : meta.renderer || "–";
  }
  if (meta.target) {
    logDiagnostics(`Session ready for ${meta.target} (${meta.renderer || activeService}).`);
  } else {
    logDiagnostics(`Renderer confirmed: ${meta.renderer || "direct"}.`);
  }
}

function readProxyMetadata(doc) {
  try {
    const getMeta = (name) => doc.querySelector(`meta[name='${name}']`)?.getAttribute("content") || null;
    const requestId = getMeta("supersonic-request-id");
    const renderer = getMeta("supersonic-renderer");
    const target = getMeta("supersonic-target");
    if (!requestId && !renderer && !target) {
      return null;
    }
    return { requestId, renderer, target };
  } catch {
    return null;
  }
}

function updateDiagnosticsSafezone() {
  if (!selectors.diagSafezone) {
    return;
  }
  const errorCount = lastDiagnosticsStats?.safezoneErrors ?? 0;
  selectors.diagSafezone.textContent = `${transportState.safezone || "unknown"} · ${errorCount} errs`;
}

function describeTargetForLog(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.hostname || parsed.origin;
  } catch {
    return targetUrl;
  }
}
const SEARCH_PROVIDERS = [
  {
    label: "SuperSonic Lite",
    type: "local",
    buildUrl: (term) => `/search/lite?q=${encodeURIComponent(term)}`,
  },
  {
    label: "Bing Lite",
    buildUrl: (term) => `https://lite.bing.com/search?q=${encodeURIComponent(term)}`,
  },
  {
    label: "Brave Search",
    buildUrl: (term) => `https://search.brave.com/search?source=web&q=${encodeURIComponent(term)}`,
  },
  {
    label: "DuckDuckGo Lite",
    buildUrl: (term) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(term)}&ia=web`,
  },
  {
    label: "DuckDuckGo HTML",
    buildUrl: (term) => `https://duckduckgo.com/html/?q=${encodeURIComponent(term)}&ia=web`,
  },
];


function hydrateUserScriptSettings() {
  const stored = localStorage.getItem(userScriptPrefKey) || "";
  if (selectors.userScriptInput) {
    selectors.userScriptInput.value = stored;
  }
  updateUserScriptStatus(stored);
  selectors.userScriptSave?.addEventListener("click", () => {
    const value = selectors.userScriptInput?.value ?? "";
    localStorage.setItem(userScriptPrefKey, value);
    updateUserScriptStatus(value);
    injectUserScriptIntoFrame();
    setStatus("User script saved.");
  });
  selectors.userScriptClear?.addEventListener("click", () => {
    selectors.userScriptInput && (selectors.userScriptInput.value = "");
    localStorage.removeItem(userScriptPrefKey);
    updateUserScriptStatus("");
    clearInjectedUserScript();
    setStatus("User script cleared.");
  });
}

function updateUserScriptStatus(script) {
  if (!selectors.userScriptStatus) return;
  selectors.userScriptStatus.textContent = script?.trim()
    ? "Injected after each load"
    : "No script stored";
}

function injectUserScriptIntoFrame() {
  const script = localStorage.getItem(userScriptPrefKey);
  if (!script || !script.trim()) {
    clearInjectedUserScript();
    return;
  }
  if (!selectors.frame || !selectors.frame.contentDocument) return;
  try {
    const doc = selectors.frame.contentDocument;
    let node = doc.getElementById("supersonic-userscript");
    if (node) {
      node.remove();
    }
    node = doc.createElement("script");
    node.id = "supersonic-userscript";
    node.type = "text/javascript";
    node.textContent = script;
    (doc.head || doc.documentElement).appendChild(node);
  } catch (error) {
    console.warn("[SuperSonic] failed to inject user script", error);
  }
}

function clearInjectedUserScript() {
  if (!selectors.frame || !selectors.frame.contentDocument) return;
  const existing = selectors.frame.contentDocument.getElementById("supersonic-userscript");
  existing?.remove();
}
