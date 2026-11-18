const net = require("net");

// A hostname label: letters, digits and inner hyphens, at most 63 characters.
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// --host ends up in the server env, the autostart files (plist, .desktop,
// .vbs) and the openBrowser shell command, so only an IP address or a plain
// hostname is accepted.
function isValidHost(host) {
  if (typeof host !== "string" || !host) return false;
  return net.isIP(host) !== 0 || HOSTNAME.test(host);
}

// Arguments for a tray relaunch or an autostart entry, so the chosen bind
// address and port survive.
function getBackgroundArgs({ port, host }) {
  if (!port || !host) throw new Error("getBackgroundArgs needs port and host");
  return ["--tray", "--skip-update", "--port", String(port), "--host", host];
}

// stdout is piped so the launcher decides what reaches the terminal (see
// createServerOutput). --log streams everything.
function serverStdio(showLog) {
  return showLog ? "inherit" : ["ignore", "pipe", "pipe"];
}

// The server prints the first-run setup token between two rules of "─"
// (src/lib/auth/setupToken.js printSetupBanner). Lines inside that block go to
// show(); every other line goes to log() (the crash log).
function createServerOutput({ show, log }) {
  const RULE = /^─{16,}$/;
  let inBanner = false;
  let pending = "";
  const line = (text) => {
    if (RULE.test(text.trim())) {
      show(text);
      inBanner = !inBanner;
    } else if (inBanner) {
      show(text);
    } else if (text) {
      log(text);
    }
  };
  return {
    write(chunk) {
      const lines = (pending + chunk.toString()).split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(line);
    },
    end() {
      if (pending) line(pending);
      pending = "";
    },
  };
}

module.exports = { isValidHost, getBackgroundArgs, serverStdio, createServerOutput };
