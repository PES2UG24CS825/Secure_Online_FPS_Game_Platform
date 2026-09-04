const form = document.getElementById("signupForm");
const message = document.getElementById("message");
const setup = document.getElementById("mfaSetup");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";

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
    setup.classList.remove("hidden");
    form.classList.add("hidden");
    message.textContent = data.message;
  } catch (error) {
    message.textContent = error.message;
  }
});
