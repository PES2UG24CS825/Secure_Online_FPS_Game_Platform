const loginForm = document.getElementById("loginForm");
const message = document.getElementById("message");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";

  try {
    const data = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("email").value,
        password: document.getElementById("password").value
      })
    });

    if (data.mfa_required) window.location.href = "mfa.html";
  } catch (error) {
    message.textContent = error.message;
  }
});
