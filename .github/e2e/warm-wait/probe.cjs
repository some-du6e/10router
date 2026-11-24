// Preloaded into the server (NODE_OPTIONS=--require). On SIGUSR2 it runs full
// GCs and writes process.memoryUsage() with a sequence number to PROBE_OUT.
const fs = require("node:fs");
const v8 = require("node:v8");
const vm = require("node:vm");

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");
let seq = 0;

process.on("SIGUSR2", () => {
  setImmediate(() => {
    for (let i = 0; i < 4; i++) gc();
    seq += 1;
    fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({ seq, at: Date.now(), ...process.memoryUsage() }));
  });
});
