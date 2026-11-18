const form = document.getElementById("signupForm");
const message = document.getElementById("message");
const setup = document.getElementById("mfaSetup");
const submitButton = form.querySelector('button[type="submit"]');

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitButton.disabled) return;
  message.textContent = "";
  message.dataset.tone = "error";

  const password = document.getElementById("password").value;
  const confirm = document.getElementById("confirmPassword").value;
  if (password !== confirm) {
    message.textContent = "Passwords do not match.";
    return;
  }
  if (!/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password) || password.length < 8) {
    message.textContent = "Password must be at least 8 characters and include an uppercase letter, a number, and a special character.";
    return;
  }

  submitButton.disabled = true;
  try {
    const data = await api("/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("name").value,
        email: document.getElementById("email").value,
        password
      })
    });

    document.getElementById("qrImage").src = data.mfa_setup.qr_data_url;
    document.getElementById("manualKey").textContent = data.mfa_setup.manual_key;
    const recoveryCodes = document.getElementById("signupRecoveryCodes");
    const codes = Array.isArray(data.recovery_codes) ? data.recovery_codes : [];
    recoveryCodes.replaceChildren(...codes.map(code => {
      const item = document.createElement("li");
      const text = document.createElement("code");
      text.textContent = code;
      item.append(text);
      return item;
    }));
    recoveryCodes.closest("details").hidden = !codes.length;
    form.reset();
    setup.classList.remove("hidden");
    form.classList.add("hidden");
    message.dataset.tone = "success";
    message.textContent = data.message;
    setup.querySelector("h3")?.focus();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});
