(() => {
  'use strict';
  let token = '';
  window.alishaCsrfReady = fetch('/api/csrf', { cache: 'no-store' }).then((response) => response.json()).then((data) => { token = data.csrfToken; return token; });
  window.alishaCsrfToken = () => token;
  const logout = document.querySelector('#logoutButton');
  if (logout) logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      await window.alishaCsrfReady;
      const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': token } });
      if (!response.ok) throw new Error('Logout failed. Please try again.');
      window.location.replace('/login');
    } catch (error) { logout.disabled = false; window.alert(error.message); }
  });
  const name = document.querySelector('#signedInUser');
  if (name) fetch('/api/auth/me', { cache: 'no-store' }).then((response) => response.ok ? response.json() : null).then((data) => { if (data?.user) name.textContent = data.user.fullName; }).catch(() => {});
})();
