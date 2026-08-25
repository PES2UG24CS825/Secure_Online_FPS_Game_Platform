const form = document.getElementById("mfaForm");
const message = document.getElementById("message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";

  try {
    await api("/auth/verify-mfa", {
      method: "POST",
      body: JSON.stringify({ code: document.getElementById("code").value })
    });
    window.location.href = "dashboard.html";
  } catch (error) {
    message.textContent = error.message;
  }
});
