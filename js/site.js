/* Shared page behaviour for inner pages (copied from the homepage). */
// Navbar: glass effect once the page scrolls, and the phone menu.
(function(){
  var nb = document.querySelector('.nb'); if (!nb) return;
  var onScroll = function(){ nb.classList.toggle('scrolled', window.scrollY > 8); };
  onScroll(); window.addEventListener('scroll', onScroll, { passive: true });
  var btn = nb.querySelector('.nb-menu'), panel = document.getElementById('nb-panel');
  function setOpen(open){ btn.setAttribute('aria-expanded', open); btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); panel.hidden = !open; }
  btn.addEventListener('click', function(){ setOpen(panel.hidden); });
  panel.querySelectorAll('a').forEach(function(a){ a.addEventListener('click', function(){ setOpen(false); }); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && !panel.hidden) { setOpen(false); btn.focus(); } });
})();

// Logo: stretch "LIFE INSURANCE" to exactly the width of "Lifestone".
(function(){
  function fit(){
    document.querySelectorAll('.nb-word').forEach(function(w){
      var b = w.querySelector('b'), sm = w.querySelector('small');
      sm.style.letterSpacing = '0px';
      var n = sm.textContent.length, gap = b.getBoundingClientRect().width - sm.getBoundingClientRect().width;
      if (n > 1) { sm.style.letterSpacing = (gap / (n - 1)) + 'px'; sm.style.marginRight = (-gap / (n - 1)) + 'px'; }
    });
  }
  fit();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  window.addEventListener('resize', fit);
})();
