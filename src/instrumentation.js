export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Bare model ids route across providers from this list; build it before
    // the first request asks.
    const autoComboWarm = import("@/sse/services/autoCombo.js")
      .then(({ warmAutoComboCatalog }) => warmAutoComboCatalog())
      .catch(() => {});

    // Codex's catalog request gets 5 seconds in all; have its model list ready.
    // After the auto-combo build, so providers aren't asked for their models
    // twice at once.
    autoComboWarm
      .then(() => import("@/lib/codex/routedModels.js"))
      .then(({ warmRoutedModels }) => warmRoutedModels())
      .catch(() => {});
  }
}
