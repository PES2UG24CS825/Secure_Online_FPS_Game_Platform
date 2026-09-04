const forgotForm = document.getElementById("forgotForm");
const message = document.getElementById("message");

forgotForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  try {
    const data = await api("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("email").value,
        reset_code: document.getElementById("resetCode").value,
        new_password: document.getElementById("newPassword").value,
        confirm_password: document.getElementById("confirmPassword").value
      })
    });
    message.textContent = data.message;
  } catch (error) {
    message.textContent = error.message;
  }
});