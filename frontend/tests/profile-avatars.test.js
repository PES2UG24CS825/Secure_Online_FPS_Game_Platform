const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("each avatar picker option updates every profile portrait and the selected state", () => {
  const html = fs.readFileSync(path.join(__dirname, "../player.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "../js/profile-avatars.js"), "utf8");
  const element = () => ({
    dataset: {}, style: {}, classList: { toggle() {} }, attributes: {},
    append(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
    replaceChildren(...children) { this.children = children; },
  });
  const picker = element();
  const slots = [...html.matchAll(/<div[^>]*data-profile-avatar[^>]*>/g)].map(element);
  const stickers = [...html.matchAll(/<img[^>]*data-avatar-sticker[^>]*>/g)].map(element);
  assert.equal(slots.length, 3, "sidebar, account security and profile");
  assert.ok(stickers.length);
  const document = {
    createElement: element,
    querySelectorAll(selector) {
      if (selector === "[data-profile-avatar]") return slots;
      if (selector === "[data-avatar-sticker]") return stickers;
      assert.equal(selector, "#avatarOptions [data-avatar], #ownedAvatarOptions [data-avatar]");
      return picker.children;
    },
  };
  const window = {};
  vm.runInNewContext(source, { window, document });

  const options = ["male-1", "male-2", "female-1", "female-2"].map((variant, index) => ({
    key: "chibi-" + variant, name: "Chibi Version " + (index + 1), src: "/public/avatars/chibi-" + variant + ".png",
  }));
  window.profileAvatars.renderPicker(picker, options, options[0].key);
  assert.equal(picker.children.length, 4);
  for (const [i, option] of options.entries()) {
    const button = picker.children[i];
    assert.equal(button.dataset.avatar, option.key);
    assert.equal(button.children[0].src, option.src);
    assert.equal(button.children[1].textContent, option.name);

    window.profileAvatars.show(option, "Player");
    assert.deepEqual(picker.children.filter(child => child.attributes["aria-pressed"] === "true"), [button]);
    for (const slot of slots) {
      assert.equal(slot.style.backgroundImage, 'url("' + option.src + '")');
      assert.equal(slot.attributes["aria-label"], option.name);
    }
    for (const sticker of stickers) {
      assert.equal(sticker.src, option.src);
      assert.equal(sticker.hidden, false);
    }
  }
});
