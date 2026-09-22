const loginForm = document.getElementById("loginForm");
const message = document.getElementById("message");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  const submitButton = loginForm.querySelector("button[type=submit]");
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Checking credentials...";
  }

  try {
    const data = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("email").value,
        password: document.getElementById("password").value
      })
    });

    if (data.mfa_required) {
      message.textContent = "Password accepted. Enter your authenticator code.";
      window.location.href = "mfa.html";
      return;
    }
    message.textContent = data.message || "Unable to continue sign-in.";
  } catch (error) {
    message.textContent = error.message;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Continue to MFA →";
    }
  }
});
