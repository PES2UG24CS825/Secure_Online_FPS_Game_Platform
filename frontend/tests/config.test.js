const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const configSource = fs.readFileSync(
  path.join(__dirname, "..", "js", "config.js"),
  "utf8"
);

function loadApiBase(location) {
  const window = { location };
  vm.runInNewContext(configSource, { window });
  return window.APP_CONFIG.apiBase;
}

test("uses the Flask page origin when served from port 5000", () => {
  assert.equal(loadApiBase({
    protocol: "http:",
    port: "5000",
    hostname: "192.168.1.25",
    origin: "http://192.168.1.25:5000",
  }), "http://192.168.1.25:5000/api");
});

test("preserves the old local http.server workflow", () => {
  assert.equal(loadApiBase({
    protocol: "http:",
    port: "5500",
    hostname: "127.0.0.1",
    origin: "http://127.0.0.1:5500",
  }), "http://127.0.0.1:5000/api");
});

test("uses the same host for a frontend served on another LAN port", () => {
  assert.equal(loadApiBase({
    protocol: "http:",
    port: "5500",
    hostname: "192.168.1.25",
    origin: "http://192.168.1.25:5500",
  }), "http://192.168.1.25:5000/api");
});

test("uses localhost as the fallback for file URLs", () => {
  assert.equal(loadApiBase({
    protocol: "file:",
    port: "",
    hostname: "",
    origin: "null",
  }), "http://127.0.0.1:5000/api");
});
