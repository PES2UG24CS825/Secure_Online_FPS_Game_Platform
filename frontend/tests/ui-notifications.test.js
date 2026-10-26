const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class FakeElement {
  constructor(tagName, document) {
    this.tagName = tagName;
    this.document = document;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.parentElement = null;
    this.textContent = "";
  }

  get isConnected() {
    let element = this;
    while (element.parentElement) element = element.parentElement;
    return element === this.document.body;
  }

  get childElementCount() { return this.children.length; }

  setAttribute(name, value) { this.attributes[name] = value; }

  append(...elements) {
    for (const element of elements) {
      element.remove();
      element.parentElement = this;
      this.children.push(element);
    }
  }

  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
}

function loadToastApi() {
  const timers = [];
  const document = {
    body: null,
    createElement(tagName) { return new FakeElement(tagName, document); },
  };
  document.body = new FakeElement("body", document);
  const window = {
    APP_CONFIG: { apiBase: "http://localhost:5000/api" },
    location: { protocol: "http:", hostname: "localhost" },
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "api.js"), "utf8");
  vm.runInNewContext(source, { window, document });
  return { document, timers, showAppToast: window.showAppToast };
}

test("app notifications share one accessible stack instead of covering each other", () => {
  const { document, showAppToast } = loadToastApi();
  showAppToast("Saved", "success");
  showAppToast("Review needed", "warning");
  showAppToast("Request failed", "error");

  assert.equal(document.body.children.length, 1);
  const [region] = document.body.children;
  assert.equal(region.className, "app-toast-region");
  assert.equal(region.attributes.role, "status");
  assert.equal(region.attributes["aria-live"], "polite");
  assert.deepEqual(region.children.map((toast) => toast.dataset.tone), ["success", "warning", "error"]);
  assert.deepEqual(region.children.map((toast) => toast.textContent), ["Saved", "Review needed", "Request failed"]);
});

test("notification stack cleans itself up after the last toast expires", () => {
  const { document, timers, showAppToast } = loadToastApi();
  showAppToast("One", "info");
  showAppToast("Two", "info");
  assert.equal(document.body.children[0].childElementCount, 2);

  timers[0].callback();
  assert.equal(document.body.children[0].childElementCount, 1);
  timers[1].callback();
  assert.equal(document.body.children.length, 0);
});

test("toast text is inserted as text rather than interpreted as markup", () => {
  const { document, showAppToast } = loadToastApi();
  showAppToast("<img src=x onerror=alert(1)>");
  assert.equal(document.body.children[0].children[0].textContent, "<img src=x onerror=alert(1)>");
});
