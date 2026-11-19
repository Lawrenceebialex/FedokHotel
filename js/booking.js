/**
 * Fedokhotel Booking Form
 * Currently posts to a Cloudflare Worker endpoint (to be implemented).
 * Falls back to a local success message while the backend is being built.
 */

(function () {
  const form = document.getElementById('booking-form');
  const messageEl = document.getElementById('form-message');
  const submitBtn = document.getElementById('submit-btn');

  // Pre-select room from query string (?room=executive)
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    const select = document.getElementById('room');
    if (select) select.value = roomParam;
  }

  // Set min dates (today + tomorrow)
  const today = new Date().toISOString().split('T')[0];
  const checkIn = document.getElementById('check_in');
  const checkOut = document.getElementById('check_out');
  if (checkIn) checkIn.min = today;
  if (checkOut) checkOut.min = today;

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    messageEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    const data = Object.fromEntries(new FormData(form));

    try {
      // This will later point to your Cloudflare Worker:
      // const res = await fetch('/api/bookings', { method: 'POST', ... })
      // For now we just simulate success while the D1 backend is built.

      await new Promise((r) => setTimeout(r, 800)); // fake latency

      messageEl.style.color = 'var(--gold)';
      messageEl.textContent = 'Thank you! Your booking request has been received. We will confirm shortly.';
      form.reset();
    } catch (err) {
      messageEl.style.color = '#b00020';
      messageEl.textContent = 'Something went wrong. Please try again or call us directly.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Request Booking';
    }
  });
})();
