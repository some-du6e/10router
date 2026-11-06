// Keep the selected bind address and port across tray and login relaunches.
function getBackgroundArgs({ port = 20128, host = "0.0.0.0" } = {}) {
  return ["--tray", "--skip-update", "--port", String(port), "--host", host];
}

module.exports = { getBackgroundArgs };
