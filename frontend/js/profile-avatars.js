window.profileAvatars = {
  renderPicker(container, options, selectedKey) {
    const buttons = options.map(({ key, name, src }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "appearance-option avatar-option avatar-portrait-option";
      button.dataset.avatar = key;
      button.setAttribute("aria-pressed", String(key === selectedKey));

      const image = document.createElement("img");
      image.src = src;
      image.alt = "";
      const label = document.createElement("span");
      label.textContent = name;
      button.append(image, label);
      return button;
    });
    container.replaceChildren(...buttons);
  },

  show(portrait, playerName) {
    const src = portrait?.src;
    for (const slot of document.querySelectorAll("[data-profile-avatar]")) {
      slot.textContent = src ? "" : playerName.charAt(0).toUpperCase();
      slot.style.backgroundImage = src ? `url(${JSON.stringify(src)})` : "";
      slot.classList.toggle("has-profile-image", Boolean(src));
      slot.setAttribute("aria-label", portrait?.name || "Profile avatar");
    }
    for (const image of document.querySelectorAll("[data-avatar-sticker]")) {
      image.hidden = !src;
      if (src) image.src = src;
    }
    for (const option of document.querySelectorAll("#avatarOptions [data-avatar]")) {
      option.setAttribute("aria-pressed", String(option.dataset.avatar === portrait?.key));
    }
  }
};
