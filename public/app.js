/**
 * Unidentified client script
 * Handles proxy selection, query normalization, and UX toggles.
 */

const services = {
  safetynet: {
    name: "SafetyNet Balanced",
    description: "Balanced rewrite mode for everyday browsing.",
    mode: "standard",
    compose(targetUrl) {
      return buildSafetyNetLink(targetUrl, this.mode);
    },
  },
  safetynet_headless: {
    name: "SafetyNet Headless",
    description: "Routes through the headless renderer for complex sites.",
    mode: "headless",
    render: "headless",
    compose(targetUrl) {
      return buildSafetyNetLink(targetUrl, this.mode, this.render);
    },
  },
  safetynet_lite: {
    name: "SafetyNet Lite",
    description: "Lightweight mode optimized for speed.",
    mode: "lite",
    compose(targetUrl) {
      return buildSafetyNetLink(targetUrl, this.mode);
    },
  },
};
const SERVICE_KEYS = Object.keys(services);

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
};

const historyKey = "unidentified:last-query";
const historyPrefKey = "unidentified:history-pref";
const panicKeyPref = "unidentified:panic-key";
const autoBlankPref = "unidentified:auto-blank";
const eduRestartKey = "safetynet:edu-restarts";
const realTitle = document.title;
const cloakTitleFallback = "Class Notes - Google Docs";
const cloakFavicon = "https://ssl.gstatic.com/docs/doclist/images/infinite_arrow_favicon_5.ico";
const faviconLink = ensureFaviconLink();
const realFaviconHref = faviconLink?.href || "";

const isCloakedContext = window.name === "unidentified-cloak";

let activeService = "safetynet";
let userSelectedService = activeService;
let panicPrimed = false;
let panicTimer = null;
let persistHistory = false;
let panicKey = localStorage.getItem(panicKeyPref) || "Escape";
let autoBlankEnabled = !isCloakedContext && localStorage.getItem(autoBlankPref) === "on";
let cloakLaunched = isCloakedContext;
let autoBlankArmed = false;
let autoBlankArmHandler = null;
const isAboutBlankContext = window.location.protocol === "about:";
const EDU_RESTART_THRESHOLD = 3;
let eduRestarts = Number(localStorage.getItem(eduRestartKey) || "0");
let eduUnlocked = eduRestarts >= EDU_RESTART_THRESHOLD || !document.body.classList.contains("edu-locked");
let lastNavigation = null;
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
      const targetUrl = normalizeQuery(rawValue);
      const order = buildServiceOrder(userSelectedService);
      lastNavigation = {
        targetUrl,
        order,
        index: 0,
      };
      launchWithService(order[0], targetUrl);

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
    setWorkspaceStatus("Secure session ready.");
    setStatus("Page loaded inside SafetyNet.");
    lastNavigation = null;
    userSelectedService = activeService;
  });

  selectors.frame?.addEventListener("error", () => {
    selectors.framePlaceholder?.classList.remove("is-hidden");
    setWorkspaceStatus("Could not load that page.");
    if (!tryServiceFallback()) {
      setStatus("Unable to load the requested page.", true);
    }
  });

  selectors.frameReset?.addEventListener("click", () => {
    if (selectors.frame) {
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

function composeProxyUrl(targetUrl, serviceKey = activeService) {
  const service = services[serviceKey];
  if (!service) {
    throw new Error("Pick a relay personality to continue.");
  }
  return service.compose(targetUrl);
}

function normalizeQuery(input) {
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(input);
  const looksLikeDomain = /^[^\s]+\.[a-z]{2,}$/i.test(input);

  if (hasScheme) {
    return new URL(input).toString();
  }

  if (looksLikeDomain) {
    return new URL(`https://${input}`).toString();
  }

  const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;
  return searchUrl;
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

function buildSafetyNetLink(targetUrl, mode, render) {
  const encoded = encodeURIComponent(targetUrl);
  const params = new URLSearchParams();
  if (mode && mode !== "standard") {
    params.set("mode", mode);
  }
  if (render) {
    params.set("render", render);
  }
  const query = params.toString();
  return query ? `/proxy/${encoded}?${query}` : `/proxy/${encoded}`;
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
    if (event.data?.source !== "safetynet-sw") return;
    const { event: eventName, payload } = event.data;
    if (eventName === "proxy-fetch-error") {
      setStatus(`SW proxy error: ${payload.message}`, true);
    } else if (eventName === "network-fallback-cache") {
      setStatus("Loaded offline copy from cache.", false);
    }
  });
}

function setActiveService(key, { userInitiated = false } = {}) {
  if (!services[key]) return;
  activeService = key;
  updateActiveService(key, userInitiated);
  if (userInitiated) {
    userSelectedService = key;
    lastNavigation = null;
  }
}

function buildServiceOrder(primaryKey) {
  const base = services[primaryKey] ? primaryKey : SERVICE_KEYS[0];
  const others = SERVICE_KEYS.filter((key) => key !== base);
  return [base, ...others];
}

function launchWithService(serviceKey, targetUrl, { fallback = false } = {}) {
  setActiveService(serviceKey, { userInitiated: !fallback && serviceKey === userSelectedService });
  const outboundUrl = composeProxyUrl(targetUrl, serviceKey);
  if (selectors.frame) {
    selectors.framePlaceholder?.classList.add("is-hidden");
    selectors.frame.src = outboundUrl;
    setWorkspaceStatus(`Routing via ${services[serviceKey].name}.`);
  } else {
    const newTab = window.open(outboundUrl, "_blank", "noopener,noreferrer");
    if (!newTab) {
      setStatus("Allow pop-ups or enable the embedded workspace to view pages.", true);
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
    lastNavigation = null;
    return false;
  }
  setStatus(`Retrying via ${services[nextKey].name}...`, false);
  launchWithService(nextKey, lastNavigation.targetUrl, { fallback: true });
  return true;
}
