const form = document.getElementById("mfaForm");
const message = document.getElementById("message");

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
    const destination = identity.user?.role === "admin"
      ? "admin.html?fresh=admin-mfa-route-1"
      : "player.html?fresh=player-fixed";
    window.location.replace(destination);
  } catch (error) {
    message.textContent = error.message;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Verify & enter dashboard →";
    }
  }
});
