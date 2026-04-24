// @ts-check
// Generic accordion toggle: clicking any .accordion-trigger toggles the 'open'
// class on its nearest .accordion ancestor. Feature HTML fragments are injected
// server-side before this script runs, so all triggers are in the DOM already.

(function () {
  document.querySelectorAll('.accordion-trigger').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const accordion = trigger.closest('.accordion');
      if (accordion) {
        accordion.classList.toggle('open');
        trigger.setAttribute(
          'aria-expanded',
          accordion.classList.contains('open') ? 'true' : 'false',
        );
      }
    });
  });
})();
