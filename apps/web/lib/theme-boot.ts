/**
 * Runs synchronously in <head> before the first paint, so the page never flashes the wrong theme.
 * Preference: 'light' | 'dark' | 'system' (default) in localStorage under `ld_theme`.
 * Kept in a plain module (not 'use client') so the server layout can inline the string.
 */
export const THEME_STORAGE_KEY = 'ld_theme';
/** Desktop sidebar collapsed to an icon rail ('rail') or full (absent). Applied as html[data-sidebar]. */
export const SIDEBAR_STORAGE_KEY = 'ld_sidebar';

export const THEME_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem('${THEME_STORAGE_KEY}');if(p!=='light'&&p!=='dark')p='system';var d=p==='system'?(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):p;document.documentElement.setAttribute('data-theme',d);if(localStorage.getItem('${SIDEBAR_STORAGE_KEY}')==='rail')document.documentElement.setAttribute('data-sidebar','rail');}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;
