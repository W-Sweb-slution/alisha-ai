(() => {
  'use strict';
  const registerMode = window.location.pathname === '/register';
  const form = document.querySelector('#authForm');
  const errorBox = document.querySelector('#authError');
  const successBox = document.querySelector('#authSuccess');
  let csrfToken = '';

  const showError = (message) => { errorBox.textContent = message; errorBox.hidden = false; successBox.hidden = true; };
  const showSuccess = (message) => { successBox.textContent = message; successBox.hidden = false; errorBox.hidden = true; };
  const passwordRules = (password) => password.length >= 10 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);

  document.querySelector('#authHeading').textContent = registerMode ? 'Create your Alisha account' : 'Welcome back';
  document.querySelector('#authSubheading').textContent = registerMode ? 'Start managing your social content with Alisha.' : 'Sign in to continue to Alisha AI.';
  document.querySelector('#nameField').hidden = !registerMode;
  document.querySelector('#confirmField').hidden = !registerMode;
  document.querySelector('#authSubmit').textContent = registerMode ? 'Create account' : 'Sign in';
  document.querySelector('#authSwitch').innerHTML = registerMode ? 'Already have an account? <a href="/login">Sign in</a>' : 'New to Alisha? <a href="/register">Create an account</a>';
  document.querySelector('#password').autocomplete = registerMode ? 'new-password' : 'current-password';
  document.querySelector('#passwordHelp').hidden = !registerMode;

  document.querySelectorAll('[data-toggle-password]').forEach((button) => button.addEventListener('click', () => {
    const field = document.querySelector(`#${button.dataset.togglePassword}`);
    field.type = field.type === 'password' ? 'text' : 'password';
    button.setAttribute('aria-label', field.type === 'password' ? 'Show password' : 'Hide password');
    button.textContent = field.type === 'password' ? 'Show' : 'Hide';
  }));

  fetch('/api/csrf', { cache: 'no-store' }).then((response) => response.json()).then((data) => { csrfToken = data.csrfToken; }).catch(() => showError('The server is unavailable. Please refresh and try again.'));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    successBox.hidden = true;
    const fullName = document.querySelector('#fullName').value.trim();
    const email = document.querySelector('#email').value.trim();
    const password = document.querySelector('#password').value;
    const confirmPassword = document.querySelector('#confirmPassword').value;
    if (registerMode && fullName.length < 2) return showError('Enter your full name.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('Enter a valid email address.');
    if (registerMode && !passwordRules(password)) return showError('Use at least 10 characters with uppercase, lowercase, a number, and a symbol.');
    if (registerMode && password !== confirmPassword) return showError('Passwords do not match.');
    if (!csrfToken) return showError('A security token is still loading. Please try again in a moment.');

    const button = document.querySelector('#authSubmit');
    button.disabled = true;
    button.textContent = registerMode ? 'Creating account…' : 'Signing in…';
    try {
      const response = await fetch(registerMode ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(registerMode ? { fullName, email, password, confirmPassword } : { email, password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Authentication failed. Please try again.');
      csrfToken = data.csrfToken;
      showSuccess(registerMode ? 'Your account is ready. Redirecting…' : 'Signed in. Redirecting…');
      window.location.replace('/');
    } catch (error) {
      showError(error.message || 'Authentication failed. Please try again.');
      button.disabled = false;
      button.textContent = registerMode ? 'Create account' : 'Sign in';
    }
  });
})();
