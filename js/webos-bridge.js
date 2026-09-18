/**
 * Roxy - webOS TV Bridge
 * Handles webOS platform events, Magic Remote cursor status, and system APIs
 */
const WebOSBridge = {
  isWebOS: false,
  isCursorVisible: false,

  init() {
    this.detectPlatform();
    this.setupEventListeners();
    this.setupTimeUpdater();
    this.setupPopupShield();
  },

  setupPopupShield() {
    const noop = () => null;

    // 1. Override and freeze window.open so external scripts cannot open popup tabs/windows
    try {
      const fakeWindow = {
        focus: noop,
        blur: noop,
        close: noop,
        closed: true,
        document: {},
        location: { href: '', replace: noop, assign: noop },
        postMessage: noop,
        opener: null
      };

      const blockedOpen = function(...args) {
        console.warn('[Roxy Shield] Blocked external window.open call:', args[0]);
        return fakeWindow;
      };

      Object.defineProperty(window, 'open', {
        value: blockedOpen,
        writable: false,
        configurable: false
      });
    } catch (e) {
      window.open = function() { return null; };
    }

    // 2. Intercept and block rogue <a> tag clicks targeting external windows / popups
    document.addEventListener('click', (e) => {
      const anchor = e.target.closest('a');
      if (anchor) {
        const href = anchor.getAttribute('href') || '';
        const target = anchor.getAttribute('target') || '';
        if (target === '_blank' || href.startsWith('http://') || href.startsWith('https://')) {
          console.warn('[Roxy Shield] Blocked external link click:', href);
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          return false;
        }
      }
    }, true);

    // 3. Protect parent app from top-level window redirection using immediate window.stop()
    window.addEventListener('beforeunload', (e) => {
      if (window.PlayerController && window.PlayerController.isActive) {
        console.warn('[Roxy Shield] Intercepted top-level redirect attempt! Halting navigation with window.stop()');
        try {
          window.stop();
        } catch (err) {}
        e.preventDefault();
        e.returnValue = 'Roxy Active';
        setTimeout(() => {
          try { window.stop(); } catch (err) {}
        }, 0);
        return 'Roxy Active';
      }
    }, true);

    // 4. Modern Chromium Navigation API Interceptor (if available)
    try {
      if (window.navigation) {
        window.navigation.addEventListener('navigate', (e) => {
          if (window.PlayerController && window.PlayerController.isActive) {
            try {
              const targetUrl = new URL(e.destination.url);
              if (targetUrl.origin !== window.location.origin && !targetUrl.href.startsWith('about:')) {
                console.warn('[Roxy Shield] Navigation API blocked redirect to:', targetUrl.href);
                e.preventDefault();
              }
            } catch (err) {}
          }
        });
      }
    } catch (e) {}
  },

  detectPlatform() {
    this.isWebOS = !!(window.webOS || window.PalmSystem || navigator.userAgent.includes('Web0S') || navigator.userAgent.includes('webOS'));
    console.log(`Roxy webOS Bridge initialized. Running on webOS: ${this.isWebOS}`);
  },

  setupEventListeners() {
    // webOS Relaunch
    document.addEventListener('webOSRelaunch', (e) => {
      console.log('webOS Relaunch event received:', e.detail);
      if (window.App && window.App.handleRelaunch) {
        window.App.handleRelaunch(e.detail);
      }
    });

    // Cursor visibility change (Magic Remote)
    document.addEventListener('cursorStateChange', (e) => {
      this.isCursorVisible = e.detail && e.detail.visibility;
      document.body.classList.toggle('cursor-visible', this.isCursorVisible);
    });

    // App Visibility (background / foreground)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (window.PlayerController && window.PlayerController.isActive) {
          window.PlayerController.pause();
        }
      }
    });
  },

  setupTimeUpdater() {
    const updateTime = () => {
      const clockEl = document.getElementById('clock-display');
      if (clockEl) {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        clockEl.textContent = `${hours}:${minutes}`;
      }
    };
    updateTime();
    setInterval(updateTime, 10000);
  },

  exit() {
    if (window.PalmSystem && window.PalmSystem.platformBack) {
      window.PalmSystem.platformBack();
    } else if (window.webOS && window.webOS.platformBack) {
      window.webOS.platformBack();
    } else if (window.close) {
      window.close();
    }
  }
};

window.WebOSBridge = WebOSBridge;
