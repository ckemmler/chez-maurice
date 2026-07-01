// Maurice landing — light interactions only.
(function () {
  // Nav border on scroll
  var nav = document.getElementById('nav');
  function onScroll() {
    if (window.scrollY > 12) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Scroll-reveal — progressive enhancement.
  // Hidden state only applies once we arm it, so content stays visible if anything fails.
  var reveals = [].slice.call(document.querySelectorAll('.reveal'));
  function revealAll() { reveals.forEach(function (el) { el.classList.add('in'); }); }

  if ('IntersectionObserver' in window) {
    document.documentElement.classList.add('reveal-ready');
    var delivered = false;
    var io = new IntersectionObserver(function (entries) {
      delivered = true;
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(function (el) { io.observe(el); });

    // Immediately reveal anything already in view at init (independent of the observer).
    requestAnimationFrame(function () {
      var h = window.innerHeight || document.documentElement.clientHeight;
      reveals.forEach(function (el) {
        if (el.getBoundingClientRect().top < h * 0.95) el.classList.add('in');
      });
    });

    // Safety net: if the observer never delivers, stop hiding everything.
    setTimeout(function () { if (!delivered) revealAll(); }, 1400);
  } else {
    revealAll();
  }

  // Download links are hardcoded in the markup (real .pkg + TestFlight URLs),
  // so they work with no JS. Nothing to wire up here.
})();
