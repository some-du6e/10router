// Keep the selected bind address and port across tray and login relaunches.
function getBackgroundArgs({ port = 20128, host = "0.0.0.0" } = {}) {
  return ["--tray", "--skip-update", "--port", String(port), "--host", host];
}

// The server prints the first-run setup token on stdout, so stdout stays
// visible even without --log. stderr is piped for the crash log.
function serverStdio(showLog) {
  return showLog ? "inherit" : ["ignore", "inherit", "pipe"];
}

module.exports = { getBackgroundArgs, serverStdio };
