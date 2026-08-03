// Semantic theme preference -> daisyUI theme name (see styles/main.css:
// corporate is the light default, business the dark preference).
export type ThemeMode = 'light' | 'dark' | 'system';

export const DAISYUI_THEME: Record<'light' | 'dark', string> = {
  light: 'corporate',
  dark: 'business',
};
