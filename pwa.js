(() => {
  "use strict";

  // Keep opening index.html directly usable, without file:// manifest errors.
  if (!/^https?:$/.test(location.protocol)) return;

  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "manifest.webmanifest";
  document.head.append(manifest);

  // メイン画面のお知らせと設定画面の項目の、どちらからでも追加できるようにする
  const installTriggers = [...document.querySelectorAll(".install-trigger")];
  const installAreas = [document.getElementById("install-notice"), document.getElementById("install-app")];
  const showInstall = (visible) => { for (const area of installAreas) area.hidden = !visible; };
  const standalone = matchMedia("(display-mode: standalone)");
  let installPrompt = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    if (standalone.matches) return;
    event.preventDefault();
    installPrompt = event;
    showInstall(true);
  });

  for (const trigger of installTriggers) trigger.addEventListener("click", async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    showInstall(false);
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      // Installation is optional; the calculator remains usable in the tab.
    }
  });

  function hideInstallButton() {
    installPrompt = null;
    showInstall(false);
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
