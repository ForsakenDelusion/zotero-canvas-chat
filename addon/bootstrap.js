var canvasChrome;

function startup({ id, rootURI }) {
  const registrar = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
  canvasChrome = registrar.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "zotero-canvas-chat", "content/"],
  ]);
  Services.scriptloader.loadSubScript(rootURI + "content/host.js", globalThis);
  CanvasPlugin.startup(id);
}

async function shutdown(_data, reason) {
  if (reason === APP_SHUTDOWN) return;
  try {
    await CanvasPlugin.shutdown();
  } finally {
    canvasChrome?.destruct();
  }
}
