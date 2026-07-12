// ============================================================
// BACKEND URL
// ============================================================
// This is the only place the backend URL lives now — there's no in-app
// settings screen for it anymore. If you ever redeploy the Apps Script
// and get a new URL, update it here (and in client-scheduler.js).
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbzRZ3pYTYQmQnBa2fchcQtIKJ1E-42xFq2WomTBDGYAQhuzDZyI9oADBaQSWB6CMFYS/exec';

const AUTH_KEY = 'sessionbook-auth';

const statusMsg = document.getElementById('statusMsg');
function showStatus(text, type) {
  statusMsg.textContent = text;
  statusMsg.className = 'status ' + (type || '');
}

function backendUrl() { return BACKEND_URL; }

// If already signed in, skip straight to the app.
if (localStorage.getItem(AUTH_KEY)) {
  window.location.href = 'client-scheduler.html';
}

function requireBackend() {
  if (!backendUrl() || backendUrl().indexOf('PASTE_YOUR') === 0) {
    showStatus('Backend URL is not configured — see BACKEND_URL in login.js.', 'error');
    return false;
  }
  return true;
}

function completeLogin(token, email) {
  localStorage.setItem(AUTH_KEY, JSON.stringify({ token, email }));
  showStatus('Signed in — redirecting…', 'ok');
  setTimeout(() => { window.location.href = 'client-scheduler.html'; }, 400);
}

// ---------------- Sign in / Create account tabs ----------------
const providersView = document.getElementById('providersView');
const codeView = document.getElementById('codeView');
const signinForm = document.getElementById('signinForm');
const signupForm = document.getElementById('signupForm');
const authTabSignin = document.getElementById('authTabSignin');
const authTabSignup = document.getElementById('authTabSignup');
let pendingEmail = '';

authTabSignin.addEventListener('click', () => {
  authTabSignin.classList.add('active');
  authTabSignup.classList.remove('active');
  signinForm.classList.remove('hidden');
  signupForm.classList.add('hidden');
  showStatus('', '');
});
authTabSignup.addEventListener('click', () => {
  authTabSignup.classList.add('active');
  authTabSignin.classList.remove('active');
  signupForm.classList.remove('hidden');
  signinForm.classList.add('hidden');
  showStatus('', '');
});

// ---- Sign in with email + password ----
signinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!requireBackend()) return;
  const email = document.getElementById('signinEmail').value.trim();
  const password = document.getElementById('signinPassword').value;
  if (!email || !password) return;
  const btn = document.getElementById('signinBtn');
  btn.disabled = true;
  showStatus('Signing in…', 'info');
  try {
    const url = backendUrl() + '?action=passwordLogin&email=' + encodeURIComponent(email) + '&password=' + encodeURIComponent(password);
    const res = await fetch(url);
    const data = await res.json();
    if (data.success) {
      completeLogin(data.token, data.email);
    } else {
      showStatus(data.error || 'Could not sign in', 'error');
    }
  } catch (err) {
    showStatus('Network error — check your connection', 'error');
  }
  btn.disabled = false;
});

// ---- Create account with email + password ----
signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!requireBackend()) return;
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const confirm = document.getElementById('signupPasswordConfirm').value;
  if (!email || !password) return;
  if (password !== confirm) {
    showStatus('Passwords do not match', 'error');
    return;
  }
  const btn = document.getElementById('signupBtn');
  btn.disabled = true;
  showStatus('Creating account…', 'info');
  try {
    const url = backendUrl() + '?action=signup&email=' + encodeURIComponent(email) + '&password=' + encodeURIComponent(password);
    const res = await fetch(url);
    const data = await res.json();
    if (data.success) {
      pendingEmail = email;
      document.getElementById('codeSentTo').textContent = `Code sent to ${email}. It expires in 10 minutes.`;
      providersView.classList.add('hidden');
      codeView.classList.remove('hidden');
      showStatus('', '');
    } else {
      showStatus(data.error || 'Could not create account', 'error');
    }
  } catch (err) {
    showStatus('Network error — check your connection', 'error');
  }
  btn.disabled = false;
});

// ---- Verify the code sent during sign-up (auto-signs in on success) ----
document.getElementById('codeVerifyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('codeInput').value.trim();
  if (!code) return;
  const btn = document.getElementById('verifyCodeBtn');
  btn.disabled = true;
  showStatus('Verifying…', 'info');
  try {
    const url = backendUrl() + '?action=verifySignup&email=' + encodeURIComponent(pendingEmail) + '&code=' + encodeURIComponent(code);
    const res = await fetch(url);
    const data = await res.json();
    if (data.success) {
      completeLogin(data.token, data.email);
    } else {
      showStatus(data.error || 'Incorrect code', 'error');
    }
  } catch (err) {
    showStatus('Network error — check your connection', 'error');
  }
  btn.disabled = false;
});

document.getElementById('backToProviders').addEventListener('click', () => {
  codeView.classList.add('hidden');
  providersView.classList.remove('hidden');
  showStatus('', '');
});

// ---------------- Forgot password flow ----------------
const forgotRequestView = document.getElementById('forgotRequestView');
const forgotResetView = document.getElementById('forgotResetView');
let pendingResetEmail = '';

document.getElementById('forgotPasswordLink').addEventListener('click', () => {
  providersView.classList.add('hidden');
  forgotRequestView.classList.remove('hidden');
  showStatus('', '');
});

function backToSignin() {
  forgotRequestView.classList.add('hidden');
  forgotResetView.classList.add('hidden');
  providersView.classList.remove('hidden');
  showStatus('', '');
}
document.getElementById('backToSigninFromForgot').addEventListener('click', backToSignin);
document.getElementById('backToSigninFromReset').addEventListener('click', backToSignin);

document.getElementById('forgotRequestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!requireBackend()) return;
  const email = document.getElementById('forgotEmail').value.trim();
  if (!email) return;
  const btn = document.getElementById('forgotRequestBtn');
  btn.disabled = true;
  showStatus('Sending reset code…', 'info');
  try {
    const url = backendUrl() + '?action=requestPasswordReset&email=' + encodeURIComponent(email);
    const res = await fetch(url);
    const data = await res.json();
    if (data.success) {
      pendingResetEmail = email;
      document.getElementById('resetCodeSentTo').textContent = `Reset code sent to ${email}. It expires in 10 minutes.`;
      forgotRequestView.classList.add('hidden');
      forgotResetView.classList.remove('hidden');
      showStatus('', '');
    } else {
      showStatus(data.error || 'Could not send reset code', 'error');
    }
  } catch (err) {
    showStatus('Network error — check your connection', 'error');
  }
  btn.disabled = false;
});

document.getElementById('forgotResetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('resetCodeInput').value.trim();
  const newPassword = document.getElementById('resetNewPassword').value;
  const confirm = document.getElementById('resetNewPasswordConfirm').value;
  if (!code || !newPassword) return;
  if (newPassword !== confirm) {
    showStatus('Passwords do not match', 'error');
    return;
  }
  const btn = document.getElementById('resetPasswordBtn');
  btn.disabled = true;
  showStatus('Resetting password…', 'info');
  try {
    const url = backendUrl() + '?action=resetPassword&email=' + encodeURIComponent(pendingResetEmail)
      + '&code=' + encodeURIComponent(code) + '&newPassword=' + encodeURIComponent(newPassword);
    const res = await fetch(url);
    const data = await res.json();
    if (data.success) {
      completeLogin(data.token, data.email);
    } else {
      showStatus(data.error || 'Could not reset password', 'error');
    }
  } catch (err) {
    showStatus('Network error — check your connection', 'error');
  }
  btn.disabled = false;
});
