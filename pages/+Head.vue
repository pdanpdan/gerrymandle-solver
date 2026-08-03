<script lang="ts" setup>
const themeInitSrc = `${ import.meta.env.BASE_URL }theme-init.js`;
</script>

<template>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#1a1a1a" media="(prefers-color-scheme: dark)" />
  <meta http-equiv="content-language" content="en-us" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://pdanpdan.github.io/gerrymandle-solver/" />
  <script :src="themeInitSrc" />
</template>
