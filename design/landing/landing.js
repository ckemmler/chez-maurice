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

  // Download links. Fill these in as artifacts go live.
  // `mac` and `ios` use the SAME TestFlight public link — one multiplatform app
  // record serves iPhone, iPad and Mac.
  var TESTFLIGHT = ''; // e.g. 'https://testflight.apple.com/join/XXXXXXXX'
  var DOWNLOADS = {
    server: 'https://www.chezmaurice.eu/ChezMaurice.pkg', // clean notarized --public build (secrets excluded)
    mac: TESTFLIGHT,
    ios: TESTFLIGHT
  };

  document.querySelectorAll('[data-dl]').forEach(function (el) {
    // Only the download-card buttons (href="#"); footer links use href="#download"
    // and should keep scrolling to the section.
    if (el.getAttribute('href') !== '#') return;
    var what = el.getAttribute('data-dl');
    var url = DOWNLOADS[what];
    if (url) {
      el.setAttribute('href', url);
      if (what === 'server') {
        el.setAttribute('download', '');
      } else {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener');
      }
      return;
    }
    // Not live yet (e.g. TestFlight before Beta Review) — render a disabled
    // "Coming soon" state instead of a dead link. Flips to a real button
    // automatically once its URL is filled in above.
    el.classList.add('is-soon');
    el.setAttribute('aria-disabled', 'true');
    el.removeAttribute('href');
    // Relabel the button, preserving its icon.
    for (var i = el.childNodes.length - 1; i >= 0; i--) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.textContent.trim()) { n.textContent = ' Coming soon'; break; }
    }
    // Add a small "Soon" badge to the card.
    var card = el.closest('.dl-card');
    if (card && !card.querySelector('.dl-tag.soon')) {
      var tag = document.createElement('span');
      tag.className = 'dl-tag soon';
      tag.textContent = 'Soon';
      card.insertBefore(tag, card.firstChild);
    }
  });
})();
