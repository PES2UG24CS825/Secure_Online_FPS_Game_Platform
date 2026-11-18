const forgotForm = document.getElementById("forgotForm");
const resetForm = document.getElementById("resetForm");
const form = forgotForm || resetForm;
const message = document.getElementById("message");
const submitButton = form.querySelector('button[type="submit"]');
let token;

function showResetStatus(text, tone) {
  message.textContent = text;
  message.dataset.tone = tone;
}

if (resetForm) {
  const url = new URL(window.location.href);
  token = url.searchParams.get("token");
  if (token) {
    url.searchParams.delete("token");
    history.replaceState(null, "", url);
  } else {
    showResetStatus("Open the link from your reset email or request a new one.", "error");
    submitButton.disabled = true;
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (submitButton.disabled) return;
  const newPassword = document.getElementById("newPassword")?.value;
  const confirmation = document.getElementById("confirmPassword")?.value;
  if (resetForm && newPassword !== confirmation) {
    showResetStatus("Passwords do not match.", "error");
    document.getElementById("confirmPassword").focus();
    return;
  }

  submitButton.disabled = true;
  showResetStatus("Submitting…", "info");
  let resetComplete = false;
  try {
    const result = await api(resetForm ? "/auth/reset-password" : "/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify(resetForm
        ? { token, new_password: newPassword, confirm_password: confirmation }
        : { email: document.getElementById("email").value }),
    });
    resetComplete = Boolean(resetForm);
    if (resetComplete) token = null;
    form.reset();
    showResetStatus(result.message, "success");
  } catch (error) {
    showResetStatus(error.message || "The request failed. Please try again.", "error");
  } finally {
    submitButton.disabled = resetComplete;
  }
});
