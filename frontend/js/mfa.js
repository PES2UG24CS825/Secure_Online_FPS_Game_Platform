const form = document.getElementById("mfaForm");
const message = document.getElementById("message");
const requestedDestination = new URLSearchParams(window.location.search).get("next");
const nextDestination = ["game.html", "player.html", "admin.html"].includes(requestedDestination)
  ? requestedDestination
  : "";
if (new URLSearchParams(window.location.search).get("replace") === "1") {
  message.textContent = "Verify your code to sign in here; the other browser will be signed out.";
}

function bindVerification(form, endpoint, input) {
  const submit = form.querySelector('button[type=submit]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (document.querySelector('#mfaForm button:disabled, #recoveryForm button:disabled')) return;
    submit.disabled = true;
    message.textContent = 'Verifying code…';

    try {
      await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({ code: input.value.trim() })
      });
      const identity = await api('/auth/me');
      const role = identity.user?.role;
      const isAdmin = ['admin', 'normal_admin', 'super_admin', 'demo_admin'].includes(role);
      window.location.replace(nextDestination || (isAdmin ? 'admin.html' : 'player.html'));
    } catch (error) {
      message.textContent = error.message;
      submit.disabled = false;
    }
  });
}

const recoveryForm = document.getElementById('recoveryForm');
bindVerification(form, '/auth/verify-mfa', document.getElementById('code'));
bindVerification(recoveryForm, '/auth/verify-recovery-code', recoveryForm.elements.code);
