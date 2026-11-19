const net = require("net");
const fs = require("fs");

// src/lib/auth/setupToken.js SETUP_WINDOW_MS: how long a setup token works.
const SETUP_WINDOW_MS = 5 * 60 * 1000;

// Whether the setup banner is still worth showing: the token file exists (it
// is deleted once setup uses it) and its token hasn't expired.
function setupTokenLive(file, { now = Date.now(), readFile = fs.readFileSync } = {}) {
  try {
    const createdAt = Number(JSON.parse(readFile(file, "utf8"))?.createdAt);
    return createdAt > 0 && now < createdAt + SETUP_WINDOW_MS;
  } catch {
    return false;
  }
}

// On Linux a tray or autostart launch writes stdout to the journal or
// ~/.xsession-errors, which other users can often read, so the token itself
// stays out of it there. The same goes for a macOS launch whose stdout is an
// old world-readable /tmp log (legacyLog).
function bannerToStdout({ platform = process.platform, trayMode, autostart, legacyLog = false }) {
  if (legacyLog) return false;
  return !(platform === "linux" && (trayMode || autostart));
}

// A hostname label: letters, digits and inner hyphens, at most 63 characters.
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// --host ends up in the server env, the autostart files (plist, .desktop,
// .vbs) and the openBrowser shell command, so only an IP address or a plain
// hostname is accepted. src/lib/appUpdater.js keeps a copy for HOSTNAME.
function isValidHost(host) {
  if (typeof host !== "string" || !host) return false;
  return net.isIP(host) !== 0 || HOSTNAME.test(host);
}

// An integer from 1 to 65535 written in plain digits, else null.
function parsePort(text) {
  if (typeof text !== "string" || !/^\d+$/.test(text)) return null;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

// Arguments for a tray relaunch or an autostart entry, so the chosen bind
// address and port survive.
function getBackgroundArgs({ port, host }) {
  if (!port || !host) throw new Error("getBackgroundArgs needs port and host");
  return ["--tray", "--skip-update", "--port", String(port), "--host", host];
}

// stdout is piped so the launcher decides what reaches the terminal (see
// attachServerOutput). --log streams everything.
function serverStdio(showLog) {
  return showLog ? "inherit" : ["ignore", "pipe", "pipe"];
}

// Turns string chunks into whole lines.
function lineSplitter(onLine) {
  let pending = "";
  return {
    write(chunk) {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(onLine);
    },
    end() {
      if (pending) onLine(pending);
      pending = "";
    },
  };
}

// The server prints the first-run setup token between two rules of "─"
// (src/lib/auth/setupToken.js printSetupBanner). Lines inside that block go to
// show(), and the whole block to onBanner() once it closes; every other line
// goes to log() (the crash log).
function createServerOutput({ show, log, onBanner = () => {} }) {
  const RULE = /^─{16,}$/;
  let banner = null;
  return lineSplitter((text) => {
    if (RULE.test(text.trim())) {
      show(text);
      if (banner) {
        banner.push(text);
        onBanner(banner.join("\n"));
        banner = null;
      } else {
        banner = [text];
      }
    } else if (banner) {
      show(text);
      banner.push(text);
    } else if (text) {
      log(text);
    }
  });
}

// Reads a piped server's stdout and stderr. Both are decoded as UTF-8 streams,
// so a character split across two chunks (the banner's "─" is 3 bytes) stays
// whole.
function attachServerOutput(child, { show, log, onBanner }) {
  if (child.stdout) {
    const out = createServerOutput({ show, log, onBanner });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => out.write(text));
    child.stdout.on("end", () => out.end());
  }
  if (child.stderr) {
    const err = lineSplitter((text) => { if (text) log(text); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => err.write(text));
    child.stderr.on("end", () => err.end());
  }
}

module.exports = {
  isValidHost, parsePort, getBackgroundArgs, serverStdio, createServerOutput, attachServerOutput,
  setupTokenLive, bannerToStdout, SETUP_WINDOW_MS,
};
