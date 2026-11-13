const form = document.getElementById("mfaForm");
const message = document.getElementById("message");
const requestedDestination = new URLSearchParams(window.location.search).get("next");
const nextDestination = ["game.html", "player.html", "admin.html"].includes(requestedDestination)
  ? requestedDestination
  : "";
if (new URLSearchParams(window.location.search).get("replace") === "1") {
  message.textContent = "Verify your code to sign in here; the other browser will be signed out.";
}

const devHint = sessionStorage.getItem("dev_totp_hint");
if (devHint) {
  const hintEl = document.getElementById("devMfaHint");
  const codeInput = document.getElementById("code");
  if (hintEl) {
    hintEl.innerHTML = `Dev MFA Code: <strong style="color:#f8fafc; font-size:1.05rem; letter-spacing:2px;">${devHint}</strong> <button type="button" id="autoFillMfaBtn" style="margin-left:8px; background:#7c3aed; color:#fff; border:none; padding:3px 8px; border-radius:4px; cursor:pointer; font-size:0.75rem;">Auto-Fill</button>`;
    hintEl.hidden = false;
    document.getElementById("autoFillMfaBtn")?.addEventListener("click", () => {
      if (codeInput) {
        codeInput.value = devHint;
        codeInput.focus();
      }
    });
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  const submitButton = form.querySelector("button[type=submit]");
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Verifying code...";
  }

  try {
    await api("/auth/verify-mfa", {
      method: "POST",
      body: JSON.stringify({ code: document.getElementById("code").value })
    });
    const identity = await api("/auth/me");
    const role = identity.user?.role;
    const isAdmin = role === "admin" || role === "super_admin" || identity.user?.is_super_admin === true;
    const destination = nextDestination || (isAdmin ? "admin.html" : "player.html");
    window.location.replace(destination);
  } catch (error) {
    message.textContent = error.message;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Verify & enter dashboard →";
    }
  }
});
