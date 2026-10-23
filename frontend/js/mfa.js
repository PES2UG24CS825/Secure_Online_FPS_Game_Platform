const form = document.getElementById("mfaForm");
const message = document.getElementById("message");
const requestedDestination = new URLSearchParams(window.location.search).get("next");
const nextDestination = ["game.html", "player.html", "admin.html"].includes(requestedDestination)
  ? requestedDestination
  : "";
if (new URLSearchParams(window.location.search).get("replace") === "1") {
  message.textContent = "Verify your code to sign in here; the other browser will be signed out.";
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
    const destination = nextDestination || (identity.user?.role === "admin" ? "admin.html" : "player.html");
    window.location.replace(destination);
  } catch (error) {
    message.textContent = error.message;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Verify & enter dashboard →";
    }
  }
});
