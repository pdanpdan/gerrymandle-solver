(function () {
  // Semantic preference -> daisyUI theme name (styles/main.css: corporate = light, business = dark).
  const THEMES = { light: 'corporate', dark: 'business' };
  const t = localStorage.getItem('gerry-theme');
  if (t === 'light' || t === 'dark') {
    document.documentElement.dataset.theme = THEMES[ t ];
  }
})();
