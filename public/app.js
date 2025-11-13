/**
 * Unidentified client script
 * Handles proxy selection, query normalization, and UX toggles.
 */

const services = {
  powerthrough: {
    name: "Powerthrough",
    description: "Balanced rewrite mode for everyday browsing.",
    mode: "powerthrough",
    compose(targetUrl) {
      return buildPowerthroughLink(targetUrl, this.mode);
    },
  },
  prism: {
    name: "Prism Shift",
    description: "Aggressive asset rewriting for script-heavy sites.",
    mode: "prism",
    compose(targetUrl) {
      return buildPowerthroughLink(targetUrl, this.mode);
    },
  },
  phantom: {
    name: "Phantom Trace",
    description: "Legacy-friendly path with minimal transforms.",
    mode: "phantom",
    compose(targetUrl) {
      return buildPowerthroughLink(targetUrl, this.mode);
    },
  },
};

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
  pageBlankToggle: document.querySelector("#page-blank"),
  blankOverlay: document.querySelector("#blank-overlay"),
};

const historyKey = "unidentified:last-query";
const historyPrefKey = "unidentified:history-pref";
const realTitle = document.title;
const cloakTitleFallback = "Class Notes - Google Docs";
const cloakFavicon = "https://ssl.gstatic.com/docs/doclist/images/infinite_arrow_favicon_5.ico";
const blankFavicon = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const faviconLink = ensureFaviconLink();
const realFaviconHref = faviconLink?.href || "";

let activeService = "powerthrough";
let panicPrimed = false;
let panicTimer = null;
let persistHistory = false;

hydrateHistoryPreference();
registerEventHandlers();
watchMissionBox();
updateActiveService(activeService);

function registerEventHandlers() {
  selectors.chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const next = chip.dataset.service;
      if (!next || next === activeService) return;
      activeService = next;
      updateActiveService(activeService);
      selectors.chips.forEach((btn) => btn.classList.toggle("is-active", btn === chip));
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
      const outboundUrl = composeProxyUrl(targetUrl);

      if (selectors.frame) {
        selectors.framePlaceholder?.classList.add("is-hidden");
        selectors.frame.src = outboundUrl;
        setWorkspaceStatus(`Routing via ${services[activeService].name}.`);
      } else {
        const newTab = window.open(outboundUrl, "_blank", "noopener,noreferrer");
        if (!newTab) {
          window.location.href = outboundUrl;
        }
      }

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
    setStatus("Page loaded inside Powerthrough.");
  });

  selectors.frameReset?.addEventListener("click", () => {
    if (selectors.frame) {
      selectors.frame.removeAttribute("src");
      selectors.framePlaceholder?.classList.remove("is-hidden");
      setWorkspaceStatus("Workspace cleared.");
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
    if (event.key === "Escape" && document.body.classList.contains("page-blank")) {
      if (selectors.pageBlankToggle) {
        selectors.pageBlankToggle.checked = false;
      }
      togglePageBlank(false);
      event.preventDefault();
      return;
    }
    if (event.key !== "Escape" || !selectors.panicToggle?.checked) return;
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
    const cloakWin = window.open("about:blank", "_blank");
    if (!cloakWin) {
      setStatus("Allow pop-ups to open the about:blank cloak.", true);
      return;
    }
    const cloakLabel = selectors.cloakTitle?.value.trim() || cloakTitleFallback;
    cloakWin.document.write(`<title>${cloakLabel}</title><body style="font-family:Arial,sans-serif;background:#111;color:#f5f5f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><p>This tab is camouflaged. Keep it open alongside Unidentified.</p></body>`);
    cloakWin.document.close();
  });

  selectors.pageBlankToggle?.addEventListener("change", (event) => {
    togglePageBlank(event.target.checked);
  });

  selectors.blankOverlay?.addEventListener("click", () => {
    if (selectors.pageBlankToggle) {
      selectors.pageBlankToggle.checked = false;
    }
    togglePageBlank(false);
  });
}

function composeProxyUrl(targetUrl) {
  const service = services[activeService];
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

function updateActiveService(key) {
  const service = services[key];
  if (!service) return;
  selectors.serviceName.textContent = service.name;
  selectors.serviceDesc.textContent = service.description;
  setStatus(`Ready on ${service.name}.`);
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

function buildPowerthroughLink(targetUrl, mode) {
  const params = new URLSearchParams({ url: targetUrl });
  if (mode && mode !== "powerthrough") {
    params.set("mode", mode);
  }
  return `/powerthrough?${params.toString()}`;
}

function applyTabCloak(enabled) {
  if (document.body.classList.contains("page-blank")) {
    document.title = "about:blank";
    if (faviconLink) {
      faviconLink.href = blankFavicon;
    }
    return;
  }
  const active = typeof enabled === "boolean" ? enabled : !!selectors.tabCloakToggle?.checked;
  const targetTitle = selectors.cloakTitle?.value.trim() || cloakTitleFallback;
  document.title = active ? targetTitle : realTitle;
  if (faviconLink) {
    faviconLink.href = active ? cloakFavicon : realFaviconHref || cloakFavicon;
  }
}

function togglePageBlank(enabled) {
  document.body.classList.toggle("page-blank", enabled);
  if (enabled) {
    setStatus("Cloaked as about:blank. Click anywhere or press Esc to restore.");
  } else {
    setStatus("Unidentified restored.");
  }
  applyTabCloak(selectors.tabCloakToggle?.checked ?? false);
}

function ensureFaviconLink() {
  let link = document.querySelector("link[rel='icon']");
  if (link) return link;
  link = document.createElement("link");
  link.rel = "icon";
  document.head.appendChild(link);
  return link;
}
