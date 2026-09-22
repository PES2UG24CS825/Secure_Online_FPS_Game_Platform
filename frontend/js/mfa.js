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
    const data = await api("/auth/verify-mfa", {
      method: "POST",
      body: JSON.stringify({ code: document.getElementById("code").value })
    });
    window.location.href = data.user?.role === "admin" ? "admin.html?v=admin-fix-2" : "player.html?v=player-fix-2";
  } catch (error) {
    message.textContent = error.message;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Verify & enter dashboard →";
    }
  }
});
