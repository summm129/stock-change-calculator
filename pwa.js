(() => {
  "use strict";

  // Keep opening index.html directly usable, without file:// manifest errors.
  if (!/^https?:$/.test(location.protocol)) return;

  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "manifest.webmanifest";
  document.head.append(manifest);

  const installButton = document.getElementById("install-app");
  const standalone = matchMedia("(display-mode: standalone)");
  let installPrompt = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    if (standalone.matches) return;
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = false;
  });

  installButton.addEventListener("click", async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    installButton.hidden = true;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      // Installation is optional; the calculator remains usable in the tab.
    }
  });

  function hideInstallButton() {
    installPrompt = null;
    installButton.hidden = true;
  }

  window.addEventListener("appinstalled", hideInstallButton);
  standalone.addEventListener("change", () => {
    if (standalone.matches) hideInstallButton();
  });

  if (window.isSecureContext && "serviceWorker" in navigator) {
    const updateNotice = document.getElementById("app-update");
    const updateButton = document.getElementById("update-app");
    let registration = null;
    let wasControlled = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    let updating = false;

    function showWaitingUpdate() {
      updateNotice.hidden = !registration?.waiting || !navigator.serviceWorker.controller;
    }

    function watchInstallingWorker() {
      const worker = registration.installing;
      if (worker) worker.addEventListener("statechange", showWaitingUpdate);
      showWaitingUpdate();
    }

    function checkForUpdate() {
      if (!registration || registration.installing) return;
      registration.update().catch(() => {
        // Keep the cached calculator available when an update check is offline.
      });
    }

    updateButton.addEventListener("click", () => {
      const worker = registration?.waiting;
      if (!worker || updating) return;
      updating = true;
      updateButton.disabled = true;
      updateButton.textContent = "更新中…";
      worker.postMessage({ type: "SKIP_WAITING" });
    });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      const previouslyControlled = wasControlled;
      wasControlled = Boolean(navigator.serviceWorker.controller);
      // Initial installation claims the open page without an extra reload.
      // Every already-controlled tab reloads when a new worker takes over.
      if (!previouslyControlled || !wasControlled || reloading) return;
      reloading = true;
      location.reload();
    });

    window.addEventListener("online", checkForUpdate);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdate();
    });

    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").then((registered) => {
        registration = registered;
        registration.addEventListener("updatefound", watchInstallingWorker);
        watchInstallingWorker();
      }).catch(() => {
        // A failed offline setup must not interrupt calculations or saved input.
      });
    });
  }
})();
