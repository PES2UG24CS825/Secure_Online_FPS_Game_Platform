const form = document.getElementById("mfaForm");
const message = document.getElementById("message");
const requestedDestination = new URLSearchParams(window.location.search).get("next");
const nextDestination = ["game.html", "player.html", "admin.html"].includes(requestedDestination)
  ? requestedDestination
  : "";
if (new URLSearchParams(window.location.search).get("replace") === "1") {
  message.textContent = "Verify your code to sign in here; the other browser will be signed out.";
}

const toggleSyncBtn = document.getElementById("toggleSyncBtn");
const syncBox = document.getElementById("syncBox");
const mfaQrImg = document.getElementById("mfaQrImg");
const mfaSecretText = document.getElementById("mfaSecretText");

if (toggleSyncBtn && syncBox) {
  toggleSyncBtn.addEventListener("click", async () => {
    const isHidden = syncBox.style.display === "none";
    if (isHidden) {
      syncBox.style.display = "block";
      try {
        const qrData = await api("/auth/mfa-qr");
        if (mfaQrImg && qrData.qr_data_url) mfaQrImg.src = qrData.qr_data_url;
        if (mfaSecretText && qrData.secret) mfaSecretText.textContent = qrData.secret;
      } catch (e) {
        console.error("QR load failed:", e);
      }
    } else {
      syncBox.style.display = "none";
    }
  });
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
    const isAdmin = role === "admin" || role === "normal_admin" || role === "super_admin" || identity.user?.is_super_admin === true;
    const destination = nextDestination || (isAdmin ? "admin.html" : "player.html");
    window.location.replace(destination);
  } catch (error) {
    message.textContent = error.message;
    if (syncBox && syncBox.style.display === "none") {
      syncBox.style.display = "block";
      try {
        const qrData = await api("/auth/mfa-qr");
        if (mfaQrImg && qrData.qr_data_url) mfaQrImg.src = qrData.qr_data_url;
        if (mfaSecretText && qrData.secret) mfaSecretText.textContent = qrData.secret;
      } catch (e) {}
    }
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Verify & enter dashboard →";
    }
  }
});
