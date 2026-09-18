/**
 * Roxy - Video Player Controller for webOS
 * Supports embedded stream iframes, HTML5 video and custom stream URLs
 */
const PlayerController = {
  isActive: false,
  currentItem: null,
  osdTimeout: null,
  isPlaying: true,

  init() {
    this.container = document.getElementById('player-view');
    this.osd = document.getElementById('player-osd');
    this.titleEl = document.getElementById('player-title');
    this.videoEl = document.getElementById('native-video-player');
    this.iframeEl = document.getElementById('stream-iframe-player');
    this.playBtn = document.getElementById('osd-btn-play');
    this.timeCurrentEl = document.getElementById('osd-time-current');
    this.timeDurationEl = document.getElementById('osd-time-duration');
    this.progressBar = document.getElementById('osd-progress-filled');

    this.bindEvents();

    // Listen to playback progress and status from iframe JWPlayer
    window.addEventListener('message', (e) => this.handleIframeMessage(e));
  },

  handleIframeMessage(e) {
    if (!this.isActive || !this.currentItem) return;
    
    let currentTime = null;
    let duration = null;

    if (e.data && e.data.type === 'ROXY_PLAYBACK_PROGRESS') {
      currentTime = e.data.currentTime;
      duration = e.data.duration;
    } else if (e.data && e.data.type === 'PLAYER_EVENT') {
      const data = e.data.data;
      if (data && (data.event === 'timeupdate' || data.event === 'seeked' || data.event === 'pause')) {
        currentTime = data.currentTime;
        duration = data.duration;
      }
    }

    if (currentTime !== null && duration !== null && duration > 0) {
      StorageService.saveWatchProgress(this.currentItem, currentTime, duration);
      this.updateProgressDisplay(currentTime, duration);
    }
  },

  updateProgressDisplay(currentTime, duration) {
    if (!duration || duration <= 0) return;
    const percent = Math.min(100, Math.max(0, (currentTime / duration) * 100));
    if (this.progressBar) {
      this.progressBar.style.width = `${percent}%`;
    }
    if (this.timeCurrentEl) {
      this.timeCurrentEl.textContent = this.formatTime(currentTime);
    }
    if (this.timeDurationEl) {
      this.timeDurationEl.textContent = this.formatTime(duration);
    }
  },

  bindEvents() {
    if (this.playBtn) {
      this.playBtn.addEventListener('click', () => this.togglePlay());
    }

    const btnBack = document.getElementById('osd-btn-back');
    if (btnBack) {
      btnBack.addEventListener('click', () => this.close());
    }

    const btnRw = document.getElementById('osd-btn-rw');
    if (btnRw) {
      btnRw.addEventListener('click', () => this.seek(-10));
    }

    const btnFf = document.getElementById('osd-btn-ff');
    if (btnFf) {
      btnFf.addEventListener('click', () => this.seek(10));
    }

    // Video events
    if (this.videoEl) {
      this.videoEl.addEventListener('timeupdate', () => this.onTimeUpdate());
      this.videoEl.addEventListener('ended', () => this.onEnded());
    }

    // Reset OSD timer on mouse move
    if (this.container) {
      this.container.addEventListener('mousemove', () => this.showOSD());
    }
  },

  play(item, customStreamUrl = null, explicitResumeTime = null) {
    this.currentItem = item;
    this.isActive = true;
    window.navigatorInstance.setPlayerActive(true);

    const isTv = (item.media_type === 'tv' || !!item.name || (item.number_of_seasons !== undefined));
    const season = item.season || 1;
    const episode = item.episode || 1;

    // Check for saved resume position if not explicitly passed
    let resumeTime = explicitResumeTime;
    if (resumeTime === null) {
      const saved = StorageService.getItemProgress(item.id);
      if (saved && saved.currentTime > 5 && saved.progress < 95) {
        if (!isTv || (saved.season === season && saved.episode === episode)) {
          resumeTime = saved.currentTime;
          console.log(`[Roxy Player] Resuming ${item.title || item.name} from saved position: ${resumeTime}s`);
        }
      }
    }

    let displayTitle = item.title || item.name || 'Streaming';
    if (isTv) {
      displayTitle += ` - S${season}:E${episode}`;
      if (item.episode_name) {
        displayTitle += ` "${item.episode_name}"`;
      }
    }

    if (this.titleEl) {
      this.titleEl.textContent = displayTitle;
    }

    this.container.classList.add('active');

    // Build streaming URL with vixsrc parameters (primaryColor=6366f1, secondaryColor=1e1e2d, lang=it, autoplay=true, canPlayFHD=1)
    let streamUrl = customStreamUrl;
    if (!streamUrl) {
      if (isTv) {
        streamUrl = CONFIG.STREAM_PROVIDERS.VIXSRC_TV
          .replace('{id}', item.id)
          .replace('{season}', season)
          .replace('{episode}', episode);
      } else {
        streamUrl = CONFIG.STREAM_PROVIDERS.VIXSRC_MOVIE.replace('{id}', item.id);
      }
    }

    console.log(`[Roxy Player] Opening VixSrc stream for: ${item.title || item.name} (isTv: ${isTv}, resume: ${resumeTime || 0}s)`);

    const osdBottom = this.osd ? this.osd.querySelector('.osd-bottom') : null;

    // If stream URL is an iframe provider (vixsrc embed)
    if (streamUrl.startsWith('http') && !streamUrl.endsWith('.mp4') && !streamUrl.endsWith('.m3u8')) {
      this.videoEl.style.display = 'none';
      this.iframeEl.style.display = 'block';
      this.iframeEl.removeAttribute('sandbox');
      this.iframeEl.setAttribute('allow', 'fullscreen; autoplay; encrypted-media; picture-in-picture');
      this.iframeEl.setAttribute('referrerpolicy', 'origin');

      // Load direct JWPlayer embed via API (bypasses outer Next.js iframe, eliminates CSP errors, purges ad scripts, sets 1080p, Italian audio, and resume time)
      this.loadDirectCleanEmbed(item, isTv, season, episode, streamUrl, resumeTime);
      
      // Configure non-blocking OSD in iframe mode
      if (this.osd) this.osd.classList.add('iframe-mode');
      if (osdBottom) osdBottom.style.display = 'none';
    } else {
      if (this.osd) this.osd.classList.remove('iframe-mode');
      this.iframeEl.style.display = 'none';
      this.videoEl.style.display = 'block';
      this.videoEl.src = streamUrl;
      if (resumeTime && resumeTime > 0) {
        this.videoEl.currentTime = resumeTime;
      }
      this.videoEl.play().catch(e => console.warn('Autoplay prevented:', e));
      if (osdBottom) osdBottom.style.display = 'flex';
    }

    this.isPlaying = true;
    this.updatePlayBtnIcon();
    this.showOSD();

    // Focus on back button when iframe is loaded so remote back is immediate
    const btnBack = document.getElementById('osd-btn-back');
    if (btnBack) {
      window.navigatorInstance.setFocus(btnBack);
    } else if (this.playBtn) {
      window.navigatorInstance.setFocus(this.playBtn);
    }

    // Save initial progress
    StorageService.saveWatchProgress({
      ...item,
      season: isTv ? season : undefined,
      episode: isTv ? episode : undefined
    }, resumeTime || 0, 100);
  },

  async loadDirectCleanEmbed(item, isTv, season, episode, fallbackUrl, resumeTime = 0) {
    const resumeSec = Math.floor(resumeTime || 0);

    // In-Frame Anti-Ad Shield script
    const antiAdScript = `
      <script>
      (function() {
        const noop = function() {};

        // 1. Neutralize window.open inside the iframe
        try {
          const fakeWin = {
            focus: noop, blur: noop, close: noop, closed: true,
            document: {}, location: { href: '', replace: noop, assign: noop },
            postMessage: noop
          };
          Object.defineProperty(window, 'open', {
            value: function(url) {
              console.warn('[Roxy AdBlocker] Blocked popup to:', url);
              return fakeWin;
            },
            writable: false, configurable: false
          });
        } catch(e) {}

        // 2. Block ad script injection
        const origCreate = document.createElement.bind(document);
        document.createElement = function(tag, opts) {
          const el = origCreate(tag, opts);
          if (tag && tag.toLowerCase() === 'script') {
            const origSetAttr = el.setAttribute.bind(el);
            el.setAttribute = function(name, val) {
              if (name === 'src' && typeof val === 'string' && (val.includes('spbgc.com') || val.includes('zone') || val.includes('popunder') || val.includes('adcash'))) {
                console.warn('[Roxy AdBlocker] Blocked ad script attribute:', val);
                return;
              }
              return origSetAttr(name, val);
            };
          }
          return el;
        };

        // 3. MutationObserver to purge any transparent full-screen ad overlays
        function purgeAdOverlays() {
          try {
            document.querySelectorAll('div, a, span, iframe').forEach(function(el) {
              if (!el || el.id === 'player' || el.id === 'wrapper' || el.tagName === 'VIDEO' || el.closest('#player') || el.closest('.jwplayer') || el.closest('.jw-controls')) {
                return;
              }
              const id = (el.id || '').toLowerCase();
              const className = (el.className || '').toString().toLowerCase();

              if (id.startsWith('ad') || id.includes('pop') || id.includes('banner') || className.includes('overlay-ad') || id.includes('zone')) {
                el.remove();
                return;
              }
            });
          } catch(err) {}
        }

        const observer = new MutationObserver(purgeAdOverlays);
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
        setInterval(purgeAdOverlays, 300);
      })();
      </script>
    `;

    try {
      // 1. Try to fetch direct embed URL from API
      let apiUrl = isTv 
        ? CONFIG.STREAM_PROVIDERS.VIXSRC_API_TV.replace('{id}', item.id).replace('{season}', season).replace('{episode}', episode)
        : CONFIG.STREAM_PROVIDERS.VIXSRC_API_MOVIE.replace('{id}', item.id);

      if (resumeSec > 0) {
        apiUrl += `&startAt=${resumeSec}`;
      }

      console.log(`[Roxy Player] Resolving direct stream from API: ${apiUrl}`);
      const apiRes = await fetch(apiUrl);
      if (!apiRes.ok) throw new Error(`API HTTP ${apiRes.status}`);
      const apiData = await apiRes.json();

      if (apiData && apiData.src) {
        let fullEmbedUrl = CONFIG.STREAM_PROVIDERS.VIXSRC_BASE + apiData.src;
        if (resumeSec > 0 && !fullEmbedUrl.includes('startAt=')) {
          fullEmbedUrl += `&startAt=${resumeSec}`;
        }
        console.log(`[Roxy Player] Fetching pure JWPlayer HTML from: ${fullEmbedUrl}`);
        const embedRes = await fetch(fullEmbedUrl);
        if (!embedRes.ok) throw new Error(`Embed HTTP ${embedRes.status}`);
        const rawEmbedHtml = await embedRes.text();

        // Build parameters query string
        const srcQuery = apiData.src.split('?')[1] || '';
        const params = new URLSearchParams(srcQuery);
        params.set('lang', 'it');
        params.set('canPlayFHD', '1');
        params.set('primaryColor', '6366f1');
        params.set('secondaryColor', '1e1e2d');
        params.set('autoplay', 'true');
        if (resumeSec > 0) {
          params.set('startAt', String(resumeSec));
        }
        const fullQueryStr = params.toString();

        // Clean & inlined player script that forces 1080p, Italian language and exact resume time
        const cleanPlayerScript = `
          <script>
          function __initRoxyPlayer__() {
            if (!window.masterPlaylist || !window.masterPlaylist.url || typeof jwplayer !== 'function') {
              setTimeout(__initRoxyPlayer__, 40);
              return;
            }

            const queryStr = "${fullQueryStr}";
            const a = new URLSearchParams(queryStr);
            const i = new URL(window.masterPlaylist.url);

            for (const [e, t] of Object.entries(window.masterPlaylist.params || {})) {
              if (t) i.searchParams.append(e, t);
            }
            if (a.get("cdn")) i.searchParams.append("cdn", a.get("cdn"));
            i.searchParams.append("h", "1");
            i.searchParams.append("canPlayFHD", "1");
            i.searchParams.append("lang", "it");

            function m(e) {
              if (!e) return "";
              try {
                const base64 = atob(decodeURIComponent(e));
                const bytes = Uint8Array.from(base64, o => o.charCodeAt(0));
                return new TextDecoder().decode(bytes);
              } catch(err) { return ""; }
            }

            const b = m(a.get("t"));
            const j = m(a.get("d"));

            const playerConfig = {
              playlist: [{
                sources: [{
                  default: false,
                  type: "hls",
                  file: i.toString(),
                  label: "0",
                  preload: "metadata"
                }],
                title: b,
                description: j,
                tracks: window.thumbnailsUrl ? [{ file: window.thumbnailsUrl, kind: "thumbnails" }] : []
              }],
              skin: {
                timeslider: {
                  progress: "#6366f1",
                  rail: "#1e1e2d"
                }
              },
              primary: "html5",
              hlshtml: true,
              aspectratio: "16:9",
              width: "100vw",
              height: "100vh",
              autostart: true,
              displaytitle: false,
              displaydescription: false,
              allowFullscreen: true,
              playbackRateControls: true,
              mute: false,
              cast: {}
            };

            const n = jwplayer("player").setup(playerConfig);
            window.player = n;

            let w = 0;
            let hasResumed = false;

            function selectMaxQuality(levels) {
              if (!levels || levels.length === 0) return;
              let bestIdx = 0;
              let maxRes = 0;
              levels.forEach((lvl, idx) => {
                const num = parseInt(lvl.label || "0");
                if (num > maxRes) {
                  maxRes = num;
                  bestIdx = idx;
                }
              });
              n.setCurrentQuality(bestIdx);
              console.log("[Roxy Player] Set max quality level index:", bestIdx, levels[bestIdx]);
            }

            function selectItalianAudio(tracks) {
              if (!tracks || tracks.length === 0) return;
              const itIdx = tracks.findIndex(t => {
                const l = ((t.language || "") + " " + (t.label || "") + " " + (t.name || "")).toLowerCase();
                return l.includes("ita") || l.includes("italian") || l === "it";
              });
              if (itIdx !== -1) {
                n.setCurrentAudioTrack(itIdx);
                console.log("[Roxy Player] Set Italian audio track index:", itIdx, tracks[itIdx]);
              }
            }

            n.on("levels", e => {
              if (e && e.levels) selectMaxQuality(e.levels);
            });

            n.on("audioTracks", e => {
              if (e && e.tracks) selectItalianAudio(e.tracks);
            });

            n.on("play", e => {
              window.parent.postMessage({ type: "PLAYER_EVENT", data: { event: "play", data: e } }, "*");
            });

            n.on("pause", e => {
              window.parent.postMessage({ type: "PLAYER_EVENT", data: { event: "pause", data: e } }, "*");
            });

            n.on("seeked", e => {
              const t = Math.round(e.currentTime);
              window.parent.postMessage({ type: "PLAYER_EVENT", data: { event: "seeked", data: e, currentTime: t, duration: e.duration } }, "*");
            });

            n.on("complete", e => {
              window.parent.postMessage({ type: "PLAYER_EVENT", data: { event: "ended", data: e } }, "*");
            });

            n.on("time", e => {
              const t = Math.round(e.currentTime);
              if (t != w) {
                w = t;
                window.parent.postMessage({
                  type: "ROXY_PLAYBACK_PROGRESS",
                  currentTime: t,
                  duration: e.duration
                }, "*");
              }
            });

            n.on("ready", async () => {
              const startSec = ${resumeSec};
              if (startSec > 5 && !hasResumed) {
                hasResumed = true;
                n.seek(startSec);
                console.log("[Roxy Player] Resumed at exact second:", startSec);
              } else {
                n.play(true);
              }

              try {
                if (n.getQualityLevels) selectMaxQuality(n.getQualityLevels());
                if (n.getAudioTracks) selectItalianAudio(n.getAudioTracks());
              } catch(err) {}

              // Setup 10s forward button in JWPlayer controls bar
              let btnContainer = document.querySelector(".jw-button-container");
              for (btnContainer && setupExtraControls(); !btnContainer;) {
                await new Promise(r => setTimeout(r, 250));
                btnContainer = document.querySelector(".jw-button-container");
                if (btnContainer) setupExtraControls();
              }

              function setupExtraControls() {
                try {
                  const rwDisplay = document.querySelector(".jw-display-icon-rewind");
                  if (rwDisplay) {
                    const ffDisplay = rwDisplay.cloneNode(true);
                    const icon = ffDisplay.querySelector(".jw-icon-rewind");
                    if (icon) {
                      const svg = icon.querySelector("svg");
                      if (svg) svg.style.backgroundImage = "url('/jwplayer-8.36.4/icons/carbon_forward-10.svg')";
                      icon.ariaLabel = "Forward 10 Seconds";
                    }
                    const nextBtn = document.querySelector(".jw-display-icon-next");
                    if (nextBtn) {
                      nextBtn.parentNode.insertBefore(ffDisplay, nextBtn);
                      nextBtn.style.display = "none";
                    }
                    ffDisplay.onclick = () => n.seek(n.getPosition() + 10);
                  }
                } catch(err) {}
              }
            });
          }

          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', __initRoxyPlayer__);
          } else {
            __initRoxyPlayer__();
          }
          </script>
        `;

        // Inject <base href="https://vixsrc.to/"> and antiAdScript into <head>
        let cleanHtml = rawEmbedHtml.replace('<head>', '<head><base href="https://vixsrc.to/">' + antiAdScript);

        // Remove remote vixsrc script from <head>
        cleanHtml = cleanHtml.replace(/<script[^>]*vixsrc-[^>]*\.js[^>]*><\/script>/gi, '');

        // Strip spbgc.com and ad network scripts directly from the JWPlayer HTML
        cleanHtml = cleanHtml
          .replace(/<script[^>]*spbgc\.com[^>]*><\/script>/gi, '')
          .replace(/<script[^>]*>\s*\(function\(s\)\{s\.dataset\.zone[^<]+<\/script>/gi, '')
          .replace(/\(function\(s\)\{s\.dataset\.zone=['"][^'"]+['"],s\.src=['"]https:\/\/spbgc\.com\/tag\.min\.js['"]\}\)\([^\)]+\)/gi, '')
          .replace(/<script[^>]*data-domain="vixcloud\.co"[^>]*><\/script>/gi, '');

        // Insert cleanPlayerScript right before </body> so that window.masterPlaylist in body is already defined!
        cleanHtml = cleanHtml.replace('</body>', cleanPlayerScript + '</body>');

        this.iframeEl.srcdoc = cleanHtml;
        console.log('[Roxy Player] Loaded custom clean JWPlayer with 1080p, Italian audio & resume seeking.');
        return;
      }
    } catch (err) {
      console.warn('[Roxy Player] Direct API pipeline notice, using cleaned fallback page:', err);
    }

    // Fallback: Fetch the outer page and clean it
    try {
      const response = await fetch(fallbackUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rawHtml = await response.text();
      let cleanHtml = rawHtml.replace('<head>', '<head><base href="https://vixsrc.to/">' + antiAdScript);
      cleanHtml = cleanHtml
        .replace(/<script[^>]*spbgc\.com[^>]*><\/script>/gi, '')
        .replace(/\(function\(s\)\{s\.dataset\.zone=['"][^'"]+['"],s\.src=['"]https:\/\/spbgc\.com\/tag\.min\.js['"]\}\)\([^\)]+\)/gi, '');
      this.iframeEl.srcdoc = cleanHtml;
    } catch (fallbackErr) {
      console.warn('[Roxy Player] Fallback to direct src:', fallbackErr);
      this.iframeEl.removeAttribute('srcdoc');
      this.iframeEl.src = fallbackUrl;
    }
  },

  close() {
    if (!this.isActive) return;

    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.src = '';
    }
    if (this.iframeEl) {
      this.iframeEl.removeAttribute('srcdoc');
      this.iframeEl.src = 'about:blank';
    }

    this.container.classList.remove('active');
    this.isActive = false;
    window.navigatorInstance.setPlayerActive(false);

    if (this.osdTimeout) {
      clearTimeout(this.osdTimeout);
    }

    // Restore focus to last view
    if (window.App && window.App.lastFocusedElement) {
      window.navigatorInstance.setFocus(window.App.lastFocusedElement);
    }

    // Refresh continue watching row
    if (window.App && window.App.renderContinueWatchingRow) {
      window.App.renderContinueWatchingRow();
    }
  },

  pause() {
    if (this.videoEl && this.videoEl.style.display !== 'none' && !this.videoEl.paused) {
      this.videoEl.pause();
      this.isPlaying = false;
      this.updatePlayBtnIcon();
    }
  },

  togglePlay() {
    if (this.videoEl && this.videoEl.style.display !== 'none') {
      if (this.videoEl.paused) {
        this.videoEl.play();
        this.isPlaying = true;
      } else {
        this.videoEl.pause();
        this.isPlaying = false;
      }
    } else {
      this.isPlaying = !this.isPlaying;
    }
    this.updatePlayBtnIcon();
    this.showOSD();
  },

  seek(seconds) {
    if (this.videoEl && this.videoEl.style.display !== 'none') {
      this.videoEl.currentTime = Math.max(0, Math.min(this.videoEl.duration || 0, this.videoEl.currentTime + seconds));
    }
    this.showOSD();
  },

  showOSD() {
    if (!this.osd) return;
    this.osd.classList.remove('hidden');

    if (this.osdTimeout) {
      clearTimeout(this.osdTimeout);
    }

    this.osdTimeout = setTimeout(() => {
      if (this.isActive && this.isPlaying) {
        this.osd.classList.add('hidden');
      }
    }, 4500);
  },

  onTimeUpdate() {
    if (!this.videoEl || !this.videoEl.duration) return;
    const current = this.videoEl.currentTime;
    const duration = this.videoEl.duration;
    const percent = (current / duration) * 100;

    if (this.progressBar) {
      this.progressBar.style.width = `${percent}%`;
    }
    if (this.timeCurrentEl) {
      this.timeCurrentEl.textContent = this.formatTime(current);
    }
    if (this.timeDurationEl) {
      this.timeDurationEl.textContent = this.formatTime(duration);
    }

    if (this.currentItem) {
      StorageService.saveWatchProgress(this.currentItem, current, duration);
    }
  },

  onEnded() {
    this.isPlaying = false;
    this.updatePlayBtnIcon();
    this.showOSD();
  },

  updatePlayBtnIcon() {
    if (this.playBtn) {
      this.playBtn.innerHTML = this.isPlaying ? '⏸' : '▶';
    }
  },

  formatTime(seconds) {
    if (isNaN(seconds)) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  },

  handleKey(code, e) {
    // Return true if handled
    if (code === CONFIG.KEYS.PLAY) {
      if (!this.isPlaying) this.togglePlay();
      return true;
    }
    if (code === CONFIG.KEYS.PAUSE) {
      if (this.isPlaying) this.togglePlay();
      return true;
    }
    if (code === CONFIG.KEYS.PLAY_PAUSE) {
      this.togglePlay();
      return true;
    }
    if (code === CONFIG.KEYS.FAST_FORWARD) {
      this.seek(15);
      return true;
    }
    if (code === CONFIG.KEYS.REWIND) {
      this.seek(-15);
      return true;
    }
    if (code === CONFIG.KEYS.UP || code === CONFIG.KEYS.DOWN) {
      this.showOSD();
      return false; // let spatial nav move inside OSD
    }
    return false;
  }
};

window.PlayerController = PlayerController;
