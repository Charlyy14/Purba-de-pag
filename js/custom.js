(function ($) {

  "use strict";

  const THEME_KEY = 'educlass-theme';

  function applyTheme(theme) {
    const isDark = theme === 'dark';
    $('body').toggleClass('dark-mode', isDark);
    $('.color-mode-icon').toggleClass('active', isDark);
  }

  applyTheme(localStorage.getItem(THEME_KEY) || 'light');

  // MODO DE COLOR
  $('.color-mode').on('click keypress', function(event){
    if (event.type === 'keypress' && event.key !== 'Enter') return;
    const nextTheme = $('body').hasClass('dark-mode') ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, nextTheme);
    applyTheme(nextTheme);
  });

  // ENCABEZADO
  if ($.fn.headroom) {
    $('.navbar').headroom();
  }

  // CARRUSEL, si la plantilla lo usa en otra página
  if ($.fn.owlCarousel && $('.owl-carousel').length) {
    $('.owl-carousel').owlCarousel({
      items: 1,
      loop: true,
      margin: 10,
      nav: true
    });
  }

  // DESPLAZAMIENTO SUAVE
  $(function() {
    $('.nav-link, .custom-btn-link').on('click', function(event) {
      const href = $(this).attr('href');
      if (!href || !href.startsWith('#')) return;
      const target = $(href);
      if (!target.length) return;
      $('html, body').stop().animate({
        scrollTop: target.offset().top - 49
      }, 900);
      event.preventDefault();
    });
  });

  // INFORMACIÓN EMERGENTE
  if ($.fn.tooltip) {
    $('[data-toggle="tooltip"]').tooltip();
  }

})(jQuery);
