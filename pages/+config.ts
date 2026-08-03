import type { Config } from 'vike/types';

import vikeVue from 'vike-vue/config';

export default {
  prerender: true,

  title: 'Gerrymandle Puzzle Solver',
  description: 'Solver for gerrymandle.com puzzles.',
  // The viewport meta is emitted by +Head.vue; disable vike-vue's default.
  viewport: null,

  extends: [ vikeVue ],
} as Config;
