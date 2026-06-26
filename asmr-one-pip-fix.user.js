// ==UserScript==
// @name         asmr.one PiP Subtitle Fix for Firefox
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Fix Picture-in-Picture subtitle display on asmr.one for Firefox-based browsers. Works by patching feature detection and providing an alternative popup subtitle window.
// @author       deepseek
// @match        https://asmr.one/*
// @icon         https://asmr.one/statics/app-logo-128x128.png
// @grant        none
// @license      unlicense
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    console.log('[asmr.one PiP Fix] Initializing Firefox compatibility patches');

    // ============================================================
    // FIX 1: Patch document.pictureInPictureEnabled
    //   Needed for: Firefox forks that disable dom.media-pip.enabled
    //   or older Firefox versions.
    //   This makes the site's supportPiPSubtitle() return true,
    //   allowing the PiPSubtitle component to render.
    // ============================================================
    try {
        Object.defineProperty(Document.prototype, 'pictureInPictureEnabled', {
            get: () => true,
            configurable: true
        });
    } catch(e) {
        // Already defined or not configurable - that's fine
    }

    // ============================================================
    // FIX 2: Monitor if PiP fails and show alternative popup
    //   The site's PiPSubtitle component tries Document PiP first,
    //   then falls back to video.requestPictureInPicture() which
    //   doesn't exist in Firefox, then throws an error.
    //   We intercept Vuex store changes and redirect to a popup.
    // ============================================================
    let pipPopupWindow = null;
    let pipActive = false;
    let currentSubtitleText = '';
    let pollTimer = null;

    // Watch Vuex store for subtitle display mode changes
    function watchVueStore() {
        const appEl = document.querySelector('#q-app');
        if (!appEl || !appEl.__vue_app__) {
            setTimeout(watchVueStore, 500);
            return;
        }

        const vm = appEl.__vue_app__;
        const store = vm.config.globalProperties.$store;

        if (!store) {
            setTimeout(watchVueStore, 500);
            return;
        }

        // Watch subtitleDisplayMode
        store.subscribe((mutation, state) => {
            if (mutation.type === 'AudioPlayer/SET_SUBTITLE_DISPLAY_MODE') {
                const mode = mutation.payload;
                if (mode === 'pip' && !pipActive) {
                    // The site is trying to enter PiP mode
                    // We need to check if it actually succeeded
                    setTimeout(() => {
                        // After a short delay, check if the site's PiP actually started
                        // If not, we launch our popup fallback
                        if (store.state.AudioPlayer.subtitleDisplayMode === 'pip' && !pipActive) {
                            openPopupFallback(store);
                        }
                    }, 1500);
                } else if (mode === 'in-app' && pipActive) {
                    closePopupFallback();
                }
            }

            // Watch currentLyric for subtitle text updates
            if (mutation.type === 'AudioPlayer/SET_CURRENT_LRC_LINE_INDEX') {
                const lines = state.AudioPlayer.lrcLines;
                const idx = state.AudioPlayer.currentLrcLineIndex;
                if (lines && lines[idx]) {
                    currentSubtitleText = lines[idx].text || lines[idx].content || '';
                    updatePopupSubtitle();
                }
            }
        });
    }

    function openPopupFallback(store) {
        if (pipPopupWindow && !pipPopupWindow.closed) return;

        try {
            pipPopupWindow = window.open(
                '',
                'asmr-pip-subtitle',
                'width=600,height=150,menubar=no,toolbar=no,location=no,status=no,resizable=yes,alwaysRaised=yes'
            );

            if (!pipPopupWindow || pipPopupWindow.closed) {
                console.warn('[asmr.one PiP Fix] Popup was blocked. Please allow popups for this site.');
                store.commit('AudioPlayer/SET_SUBTITLE_DISPLAY_MODE', 'in-app');
                return;
            }

            pipActive = true;

            // Write the subtitle display HTML
            pipPopupWindow.document.write(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: rgba(0,0,0,0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    overflow: hidden;
    font-family: "Noto Sans SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif;
  }
  #subtitle {
    color: #fff;
    text-align: center;
    padding: 12px 24px;
    line-height: 1.6;
    word-break: break-word;
    font-size: 24px;
    font-weight: 600;
    text-shadow: 0 0 10px rgba(0,0,0,0.9), 1px 1px 2px #000;
    max-width: 100%;
  }
</style></head>
<body><div id="subtitle">${currentSubtitleText || 'Waiting for subtitle...'}</div>
<script>
  // Resize handler
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const size = Math.max(18, Math.min(40, w / 14));
    document.getElementById('subtitle').style.fontSize = size + 'px';
  });
  // Notify opener when closed
  window.addEventListener('pagehide', () => {
    if (window.opener && !window.opener.closed) {
      window.opener.dispatchEvent(new CustomEvent('pip-popup-closed'));
    }
  });
<\/script></body></html>
            `);
            pipPopupWindow.document.close();

            // Listen for popup close
            window.addEventListener('pip-popup-closed', () => {
                pipActive = false;
                pipPopupWindow = null;
                if (store.state.AudioPlayer.subtitleDisplayMode === 'pip') {
                    store.commit('AudioPlayer/SET_SUBTITLE_DISPLAY_MODE', 'in-app');
                }
            });

            // Poll subtitle text
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = setInterval(() => {
                if (!pipPopupWindow || pipPopupWindow.closed) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                    pipActive = false;
                    pipPopupWindow = null;
                    if (store && store.state && store.state.AudioPlayer.subtitleDisplayMode === 'pip') {
                        store.commit('AudioPlayer/SET_SUBTITLE_DISPLAY_MODE', 'in-app');
                    }
                    return;
                }
                updatePopupSubtitle();
            }, 200);

            // Clean up on page unload
            window.addEventListener('beforeunload', () => {
                if (pipPopupWindow && !pipPopupWindow.closed) {
                    pipPopupWindow.close();
                }
            });

        } catch(e) {
            console.error('[asmr.one PiP Fix] Failed to open popup:', e);
            pipActive = false;
            store.commit('AudioPlayer/SET_SUBTITLE_DISPLAY_MODE', 'in-app');
        }
    }

    function updatePopupSubtitle() {
        if (!pipPopupWindow || pipPopupWindow.closed || !pipPopupWindow.document) return;
        const el = pipPopupWindow.document.getElementById('subtitle');
        if (el && el.textContent !== currentSubtitleText) {
            el.textContent = currentSubtitleText || '';
        }
    }

    function closePopupFallback() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        if (pipPopupWindow && !pipPopupWindow.closed) {
            pipPopupWindow.close();
        }
        pipPopupWindow = null;
        pipActive = false;
    }

    // Start watching after DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', watchVueStore);
    } else {
        watchVueStore();
    }

    // ============================================================
    // FIX 3: Also try to read subtitle from the canvas as fallback
    //   The site renders subtitles on a canvas then captures it
    //   as a video stream for PiP. We read the same canvas.
    // ============================================================
    setInterval(() => {
        const canvas = document.getElementById('canvas');
        if (!canvas) return;

        // Try to read subtitle text from the Vue app store directly
        const appEl = document.querySelector('#q-app');
        if (appEl && appEl.__vue_app__) {
            try {
                const store = appEl.__vue_app__.config.globalProperties.$store;
                const state = store.state;
                if (state && state.AudioPlayer) {
                    const lines = state.AudioPlayer.lrcLines;
                    const idx = state.AudioPlayer.currentLrcLineIndex;
                    if (lines && lines[idx]) {
                        const text = lines[idx].text || lines[idx].content || '';
                        if (text !== currentSubtitleText) {
                            currentSubtitleText = text;
                            updatePopupSubtitle();
                        }
                    }
                }
            } catch(e) {}
        }
    }, 200);

    console.log('[asmr.one PiP Fix] Patches applied successfully');
})();
