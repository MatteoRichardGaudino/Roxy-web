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
    this.iconPause = document.getElementById('osd-icon-pause');
    this.iconPlay = document.getElementById('osd-icon-play');
    this.progressTrack = document.querySelector('.osd-progress-track');
    this.timeCurrentEl = document.getElementById('osd-time-current');
    this.timeDurationEl = document.getElementById('osd-time-duration');
    this.progressBar = document.getElementById('osd-progress-filled');
    this.timePreviewEl = document.getElementById('osd-time-preview');
    this.loadingCurtain = document.getElementById('player-loading-curtain');
    this.loadingTitle = document.getElementById('player-loading-title');

    this.bindEvents();

    // Listen to playback progress and status from iframe JWPlayer
    window.addEventListener('message', (e) => this.handleIframeMessage(e));

    // Listen to window navigation and close events to flush progress
    window.addEventListener('beforeunload', () => this.flushSessionProgress());
    window.addEventListener('pagehide', () => this.flushSessionProgress());
    window.addEventListener('popstate', () => {
      if (this.isActive) {
        this.close();
      }
    });
  },

  calculateCurrentPlaybackTime() {
    if (this.videoEl && this.videoEl.style.display !== 'none' && this.videoEl.currentTime > 0) {
      return Math.floor(this.videoEl.currentTime);
    }
    if (this.hasReceivedIframeEvent && this.currentSessionTime !== null && this.currentSessionTime !== undefined) {
      return this.currentSessionTime;
    }
    const elapsedSec = this.playStartTime ? Math.max(0, Math.floor((Date.now() - this.playStartTime) / 1000)) : 0;
    const computedSec = (this.initialResumeSec || 0) + elapsedSec;
    return Math.max(this.currentSessionTime || 0, computedSec);
  },

  flushSessionProgress() {
    if (this.isActive && this.currentItem) {
      const finalTime = this.calculateCurrentPlaybackTime();
      if (finalTime > 0) {
        StorageService.saveWatchProgress(this.currentItem, finalTime, this.estimatedDuration || 7200);
      }
    }
  },

  handleIframeMessage(e) {
    if (!this.isActive || !this.currentItem) return;
    
    let msgData = e.data;
    if (typeof msgData === 'string') {
      try {
        msgData = JSON.parse(msgData);
      } catch (err) {}
    }

    if (!msgData || typeof msgData !== 'object') return;

    if (msgData.type === 'ROXY_CLOSE_PLAYER') {
      this.close();
      return;
    }

    // Official VixSrc Player Event Tracking:
    // { type: "PLAYER_EVENT", data: { event: "play"|"pause"|"seeked"|"ended"|"timeupdate", currentTime, duration, video_id } }
    if (msgData.type === 'PLAYER_EVENT' && msgData.data) {
      const data = msgData.data;
      const eventName = data.event;
      const currTime = (typeof data.currentTime === 'number' && !isNaN(data.currentTime)) ? Math.floor(data.currentTime) : null;
      const dur = (typeof data.duration === 'number' && !isNaN(data.duration) && data.duration > 0) ? Math.floor(data.duration) : null;

      this.hasReceivedIframeEvent = true;
      this.hideLoadingCurtain();

      if (dur !== null && dur > 0) {
        this.estimatedDuration = dur;
      }

      if (currTime !== null && currTime >= 0) {
        this.currentSessionTime = currTime;
        this.updateProgressDisplay(this.currentSessionTime, this.estimatedDuration);
      }

      if (eventName === 'play') {
        this.isPlaying = true;
        this.updatePlayBtnIcon();
      } else if (eventName === 'pause') {
        this.isPlaying = false;
        this.updatePlayBtnIcon();
        if (this.currentSessionTime > 0) {
          StorageService.saveWatchProgress(this.currentItem, this.currentSessionTime, this.estimatedDuration);
        }
      } else if (eventName === 'seeked') {
        if (this.currentSessionTime >= 0) {
          console.log(`[Roxy Player] VixSrc seeked event received at: ${this.currentSessionTime}s`);
          StorageService.saveWatchProgress(this.currentItem, this.currentSessionTime, this.estimatedDuration);
        }
      } else if (eventName === 'ended') {
        this.isPlaying = false;
        this.onEnded();
        if (this.estimatedDuration > 0) {
          StorageService.saveWatchProgress(this.currentItem, this.estimatedDuration, this.estimatedDuration);
        }
      } else if (eventName === 'timeupdate') {
        const now = Date.now();
        if (!this.lastProgressSave || (now - this.lastProgressSave > 3500)) {
          this.lastProgressSave = now;
          if (this.currentSessionTime > 0) {
            StorageService.saveWatchProgress(this.currentItem, this.currentSessionTime, this.estimatedDuration);
          }
        }
      }
      return;
    }

    // Custom injected ROXY playback progress (e.g. clean webOS JWPlayer embed)
    if (msgData.type === 'ROXY_PLAYBACK_PROGRESS') {
      const currTime = Number(msgData.currentTime);
      const dur = Number(msgData.duration);
      this.hasReceivedIframeEvent = true;
      this.hideLoadingCurtain();

      if (!isNaN(currTime) && currTime >= 0) {
        this.currentSessionTime = Math.floor(currTime);
      }
      if (!isNaN(dur) && dur > 0) {
        this.estimatedDuration = Math.floor(dur);
      }
      StorageService.saveWatchProgress(this.currentItem, this.currentSessionTime, this.estimatedDuration);
      this.updateProgressDisplay(this.currentSessionTime, this.estimatedDuration);
    }
  },

  hideLoadingCurtain() {
    if (this.loadingCurtain && !this.loadingCurtain.classList.contains('fade-out')) {
      this.loadingCurtain.classList.add('fade-out');
      setTimeout(() => {
        if (this.loadingCurtain && this.loadingCurtain.classList.contains('fade-out')) {
          this.loadingCurtain.style.display = 'none';
        }
      }, 650);
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
      const remaining = Math.max(0, duration - currentTime);
      this.timeDurationEl.textContent = `-${this.formatTime(remaining)}`;
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

    const btnCurtainBack = document.getElementById('player-loading-btn-back');
    if (btnCurtainBack) {
      btnCurtainBack.addEventListener('click', () => this.close());
    }

    const btnRw = document.getElementById('osd-btn-rw');
    if (btnRw) {
      btnRw.addEventListener('click', () => this.seek(-10));
    }

    const btnFf = document.getElementById('osd-btn-ff');
    if (btnFf) {
      btnFf.addEventListener('click', () => this.seek(10));
    }

    const btnFullscreen = document.getElementById('osd-btn-fullscreen');
    if (btnFullscreen) {
      btnFullscreen.addEventListener('click', () => this.toggleFullscreen());
    }

    // Interactive timeline seeking on click or drag & hover time preview
    if (this.progressTrack) {
      const handleSeek = (e) => {
        if (!this.videoEl || !this.videoEl.duration) return;
        const rect = this.progressTrack.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const ratio = Math.max(0, Math.min(1, clickX / rect.width));
        this.videoEl.currentTime = ratio * this.videoEl.duration;
        this.onTimeUpdate();
        this.showOSD();
      };

      this.progressTrack.addEventListener('click', (e) => {
        e.stopPropagation();
        handleSeek(e);
      });

      this.progressTrack.addEventListener('mousemove', (e) => {
        if (!this.videoEl || !this.videoEl.duration || !this.timePreviewEl) return;
        const rect = this.progressTrack.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const hoverTime = ratio * this.videoEl.duration;
        this.timePreviewEl.textContent = this.formatTime(hoverTime);
        this.timePreviewEl.style.left = `${(ratio * 100).toFixed(1)}%`;
        this.timePreviewEl.style.display = 'block';
      });

      this.progressTrack.addEventListener('mouseleave', () => {
        if (this.timePreviewEl) {
          this.timePreviewEl.style.display = 'none';
        }
      });
    }

    // Video events
    if (this.videoEl) {
      this.videoEl.addEventListener('playing', () => this.hideLoadingCurtain());
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
    this.hasReceivedIframeEvent = false;
    this.lastProgressSave = 0;
    window.navigatorInstance.setPlayerActive(true);

    try {
      if (window.history && window.history.pushState) {
        window.history.pushState({ roxyPlayer: true }, '');
      }
    } catch (e) {}

    if (item.source === 'animesaturn') {
      this.playSaturn(item, explicitResumeTime);
      return;
    }

    const isTv = (item.media_type === 'tv' || !!item.name || (item.number_of_seasons !== undefined));
    let season = item.season;
    let episode = item.episode;

    // If TV show has no explicit season/episode, check saved progress to resume last watched episode
    if (isTv && (!season || !episode)) {
      const lastSaved = StorageService.getItemProgress(item.id);
      if (lastSaved && lastSaved.season && lastSaved.episode) {
        season = Number(lastSaved.season);
        episode = Number(lastSaved.episode);
      } else {
        season = season || 1;
        episode = episode || 1;
      }
      item.season = season;
      item.episode = episode;
    }

    // Check for saved resume position if not explicitly passed
    let resumeTime = explicitResumeTime;
    if (resumeTime === null) {
      const saved = StorageService.getItemProgress(item.id, isTv ? season : null, isTv ? episode : null);
      if (saved && saved.currentTime > 5 && saved.progress < 95) {
        if (!isTv || (Number(saved.season) === Number(season) && Number(saved.episode) === Number(episode))) {
          resumeTime = saved.currentTime;
          console.log(`[Roxy Player] Resuming ${item.title || item.name} from saved position: ${resumeTime}s`);
        }
      }
    }

    const resumeSec = Math.floor(resumeTime || 0);

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

    if (this.loadingCurtain) {
      this.loadingCurtain.classList.remove('fade-out');
      this.loadingCurtain.style.display = 'flex';
    }
    if (this.loadingTitle) {
      this.loadingTitle.textContent = displayTitle;
    }

    this.container.classList.add('active');

    // Build streaming URL with vixsrc parameters
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

    // Append startAt parameters so VixSrc embedded player seeks to the exact second
    if (resumeSec > 5) {
      const sep = streamUrl.includes('?') ? '&' : '?';
      streamUrl += `${sep}startAt=${resumeSec}&t=${resumeSec}`;
    }

    console.log(`[Roxy Player] Opening VixSrc stream for: ${item.title || item.name} (isTv: ${isTv}, resume: ${resumeSec}s)`);

    const osdBottom = this.osd ? this.osd.querySelector('.osd-bottom') : null;

    if (this.loadingTimeout) clearTimeout(this.loadingTimeout);
    this.loadingTimeout = setTimeout(() => {
      this.hideLoadingCurtain();
    }, 7000);

    // If stream URL is an iframe provider (vixsrc embed)
    if (streamUrl.startsWith('http') && !streamUrl.endsWith('.mp4') && !streamUrl.endsWith('.m3u8')) {
      this.videoEl.style.display = 'none';
      this.iframeEl.style.display = 'block';
      this.iframeEl.removeAttribute('sandbox');
      this.iframeEl.setAttribute('allow', 'fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write; display-capture');
      this.iframeEl.setAttribute('referrerpolicy', 'no-referrer');

      // Load direct JWPlayer embed via API on webOS, or direct no-referrer embed on Web browser
      this.loadDirectCleanEmbed(item, isTv, season, episode, streamUrl, resumeSec);
      
      // Configure non-blocking OSD in iframe mode
      if (this.osd) this.osd.classList.add('iframe-mode');
      if (osdBottom) osdBottom.style.display = 'none';
    } else {
      if (this.osd) this.osd.classList.remove('iframe-mode');
      this.iframeEl.style.display = 'none';
      this.videoEl.style.display = 'block';
      this.videoEl.src = streamUrl;

      if (resumeSec > 5) {
        const seekOnce = () => {
          try {
            this.videoEl.currentTime = resumeSec;
            console.log(`[Roxy Player] Native video resumed at: ${resumeSec}s`);
          } catch(e) {}
        };
        this.videoEl.addEventListener('loadedmetadata', seekOnce, { once: true });
        this.videoEl.addEventListener('canplay', seekOnce, { once: true });
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

    // Initialize session ticker for robust web & TV progress tracking
    this.playStartTime = Date.now();
    this.initialResumeSec = resumeSec;
    this.currentSessionTime = resumeSec;
    this.estimatedDuration = isTv ? 2700 : 7200;
    this.tickCount = 0;

    if (this.sessionTicker) {
      clearInterval(this.sessionTicker);
      this.sessionTicker = null;
    }

    this.sessionTicker = setInterval(() => {
      if (this.isActive && this.currentItem) {
        const currentPos = this.calculateCurrentPlaybackTime();
        this.currentSessionTime = currentPos;
        this.tickCount += 1;
        if (this.tickCount % 5 === 0) {
          StorageService.saveWatchProgress(this.currentItem, currentPos, this.estimatedDuration);
        }
      }
    }, 1000);

    // Save initial progress
    StorageService.saveWatchProgress({
      ...item,
      season: isTv ? season : undefined,
      episode: isTv ? episode : undefined
    }, resumeSec, this.estimatedDuration);
  },

  async playSaturn(item, explicitResumeTime = null) {
    const slug = item.slug || (item.id ? String(item.id).replace('saturn_', '') : '');
    const epNum = item.episode || 1;

    let resumeTime = explicitResumeTime;
    if (resumeTime === null) {
      const saved = StorageService.getItemProgress(item.id, 1, epNum);
      if (saved && saved.currentTime > 5 && saved.progress < 95 && Number(saved.episode) === Number(epNum)) {
        resumeTime = saved.currentTime;
        console.log(`[Roxy Player] Resuming Anime ${item.title || item.name} Ep ${epNum} from: ${resumeTime}s`);
      }
    }

    const resumeSec = Math.floor(resumeTime || 0);

    const cleanTitle = (item.title || item.name || 'Anime').replace(/\s*\((ITA|SUB|SUB ITA)\)\s*/gi, '').trim();
    const subLabel = item.isDub ? 'DUB ITA' : 'SUB ITA';
    const displayTitle = `🪐 ${cleanTitle} - Ep. ${epNum} (${subLabel})`;

    if (this.titleEl) this.titleEl.textContent = displayTitle;
    if (this.loadingCurtain) {
      this.loadingCurtain.classList.remove('fade-out');
      this.loadingCurtain.style.display = 'flex';
    }
    if (this.loadingTitle) this.loadingTitle.textContent = displayTitle;
    this.container.classList.add('active');

    const osdBottom = this.osd ? this.osd.querySelector('.osd-bottom') : null;

    try {
      console.log(`[Roxy Player] Resolving AnimeSaturn stream for: ${slug} ep ${epNum}`);
      const res = await AnimeSaturnService.resolveStream(slug, epNum);

      if (res && res.type === 'direct' && res.streamUrl) {
        console.log(`[Roxy Player] Playing direct Saturn stream: ${res.streamUrl}`);
        if (this.osd) this.osd.classList.remove('iframe-mode');
        this.iframeEl.style.display = 'none';
        this.videoEl.style.display = 'block';
        this.videoEl.src = res.streamUrl;

        if (resumeSec > 5) {
          const seekOnce = () => {
            try {
              this.videoEl.currentTime = resumeSec;
              console.log(`[Roxy Player] Saturn video element resumed at: ${resumeSec}s`);
            } catch(e) {}
          };
          this.videoEl.addEventListener('loadedmetadata', seekOnce, { once: true });
          this.videoEl.addEventListener('canplay', seekOnce, { once: true });
        }

        this.videoEl.play().catch(e => console.warn('Saturn direct autoplay notice:', e));
        if (osdBottom) osdBottom.style.display = 'flex';
      } else {
        throw new Error('No stream available from AnimeSaturn');
      }
    } catch (err) {
      console.error('[Roxy Player] AnimeSaturn playback failed:', err);
      this.hideLoadingCurtain();
      if (window.App) {
        window.App.showToast('Server Anime non raggiungibile al momento.');
      }
      setTimeout(() => this.close(), 2500);
      return;
    }

    this.isPlaying = true;
    this.updatePlayBtnIcon();
    this.showOSD();

    const btnBack = document.getElementById('osd-btn-back');
    if (btnBack) {
      window.navigatorInstance.setFocus(btnBack);
    } else if (this.playBtn) {
      window.navigatorInstance.setFocus(this.playBtn);
    }

    // Initialize session ticker for anime playback
    this.playStartTime = Date.now();
    this.initialResumeSec = resumeSec;
    this.currentSessionTime = resumeSec;
    this.estimatedDuration = 1440; // 24m standard anime
    this.tickCount = 0;

    if (this.sessionTicker) {
      clearInterval(this.sessionTicker);
      this.sessionTicker = null;
    }

    this.sessionTicker = setInterval(() => {
      if (this.isActive && this.currentItem) {
        const currentPos = this.calculateCurrentPlaybackTime();
        this.currentSessionTime = currentPos;
        this.tickCount += 1;
        if (this.tickCount % 5 === 0) {
          StorageService.saveWatchProgress(this.currentItem, currentPos, this.estimatedDuration);
        }
      }
    }, 1000);

    // Save initial progress
    StorageService.saveWatchProgress({
      ...item,
      source: 'animesaturn',
      slug: slug,
      media_type: 'anime',
      season: 1,
      episode: epNum
    }, resumeSec, this.estimatedDuration);
  },

  async loadDirectCleanSaturnEmbed(item, embedUrl, initialEmbedHtml = null, resumeTime = 0) {
    const resumeSec = Math.floor(resumeTime || 0);

    // In-Frame Anti-Ad Shield script
    const antiAdScript = `
      <script>
      (function() {
        const noop = function() {};

        // 1. Neutralize window.open
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
              if (name === 'src' && typeof val === 'string' && (val.includes('acscdn.com') || val.includes('spbgc.com') || val.includes('a-ads.com') || val.includes('zone') || val.includes('popunder') || val.includes('adcash'))) {
                console.warn('[Roxy AdBlocker] Blocked ad script attribute:', val);
                return;
              }
              return origSetAttr(name, val);
            };
          }
          return el;
        };

        // 3. Purge ad overlays
        function purgeAdOverlays() {
          try {
            document.querySelectorAll('div, a, span, iframe').forEach(function(el) {
              if (!el || el.id === 'embed-shell' || el.tagName === 'VIDEO' || el.closest('#embed-shell')) {
                return;
              }
              const id = (el.id || '').toLowerCase();
              const className = (el.className || '').toString().toLowerCase();

              if (id.startsWith('ad') || id.includes('pop') || id.includes('banner') || className.includes('overlay-ad') || id.includes('zone') || id.includes('aclib')) {
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

    const tvControllerScript = `
      <script>
      (function() {
        const startSec = ${resumeSec};
        let hasResumed = false;

        function attachVideoListeners() {
          const v = document.querySelector('video');
          if (!v) {
            setTimeout(attachVideoListeners, 250);
            return;
          }

          v.addEventListener('loadedmetadata', function() {
            if (startSec > 5 && !hasResumed) {
              hasResumed = true;
              v.currentTime = startSec;
              console.log('[Roxy Saturn] Resumed at:', startSec);
            }
          });

          v.addEventListener('play', function() {
            window.parent.postMessage({ type: 'PLAYER_EVENT', data: { event: 'play' } }, '*');
          });

          v.addEventListener('pause', function() {
            window.parent.postMessage({ type: 'PLAYER_EVENT', data: { event: 'pause' } }, '*');
          });

          v.addEventListener('timeupdate', function() {
            window.parent.postMessage({
              type: 'ROXY_PLAYBACK_PROGRESS',
              currentTime: Math.round(v.currentTime),
              duration: v.duration || 0
            }, '*');
          });

          v.addEventListener('ended', function() {
            window.parent.postMessage({ type: 'PLAYER_EVENT', data: { event: 'ended' } }, '*');
          });
        }

        document.addEventListener('keydown', function(e) {
          const v = document.querySelector('video');
          if (!v) return;

          if (e.key === 'ArrowLeft' || e.keyCode === 37) {
            e.preventDefault();
            v.currentTime = Math.max(0, v.currentTime - 10);
          } else if (e.key === 'ArrowRight' || e.keyCode === 39) {
            e.preventDefault();
            v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 10);
          } else if (e.key === ' ' || e.key === 'Enter' || e.keyCode === 13 || e.keyCode === 32) {
            e.preventDefault();
            if (v.paused) v.play(); else v.pause();
          } else if (e.key === 'ArrowUp' || e.keyCode === 38) {
            e.preventDefault();
            v.volume = Math.min(1, v.volume + 0.05);
          } else if (e.key === 'ArrowDown' || e.keyCode === 40) {
            e.preventDefault();
            v.volume = Math.max(0, v.volume - 0.05);
          } else if (e.key === 'Escape' || e.keyCode === 27 || e.keyCode === 461) {
            window.parent.postMessage({ type: 'ROXY_CLOSE_PLAYER' }, '*');
          }
        });

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', attachVideoListeners);
        } else {
          attachVideoListeners();
        }
      })();
      </script>
      <style>
        html, body {
          margin: 0 !important;
          padding: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          overflow: hidden !important;
          background: #000000 !important;
        }
        #embed-shell, video, iframe {
          width: 100vw !important;
          height: 100vh !important;
          border: none !important;
          outline: none !important;
          background: #000000 !important;
        }
      </style>
    `;

    try {
      let rawHtml = initialEmbedHtml;
      if (!rawHtml) {
        const res = await fetch(embedUrl, {
          headers: {
            'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
          }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        rawHtml = await res.text();
      }

      let cleanHtml = rawHtml;

      // Inject base tag, antiAdScript, and tvControllerScript
      if (cleanHtml.includes('<head>')) {
        cleanHtml = cleanHtml.replace('<head>', '<head><base href="https://play.saturncdn.net/">' + antiAdScript);
      } else {
        cleanHtml = '<head><base href="https://play.saturncdn.net/">' + antiAdScript + '</head>' + cleanHtml;
      }

      // Remove third party ad tags from HTML
      cleanHtml = cleanHtml
        .replace(/<script[^>]*acscdn\.com[^>]*><\/script>/gi, '')
        .replace(/<script[^>]*aclib\.runPop[^<]*<\/script>/gi, '')
        .replace(/<script[^>]*a-ads\.com[^>]*><\/script>/gi, '');

      // Append TV controller & custom styles before </body>
      if (cleanHtml.includes('</body>')) {
        cleanHtml = cleanHtml.replace('</body>', tvControllerScript + '</body>');
      } else {
        cleanHtml += tvControllerScript;
      }

      this.iframeEl.removeAttribute('sandbox');
      this.iframeEl.setAttribute('allow', 'fullscreen; autoplay; encrypted-media; picture-in-picture');
      this.iframeEl.srcdoc = cleanHtml;
      console.log('[Roxy Player] Successfully loaded custom clean Saturn embed into srcdoc.');
    } catch (err) {
      console.warn('[Roxy Player] Error loading Saturn embed via srcdoc, fallback direct src:', err);
      this.iframeEl.removeAttribute('srcdoc');
      this.iframeEl.src = embedUrl;
    }
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

    // If not running on webOS, browser CORS blocks fetch to vixsrc.to/api.
    // Directly embed the URL with startAt and no-referrer
    if (!window.WebOSBridge || !window.WebOSBridge.isWebOS) {
      let finalEmbedUrl = fallbackUrl;
      if (resumeSec > 5 && !finalEmbedUrl.includes('startAt=')) {
        const sep = finalEmbedUrl.includes('?') ? '&' : '?';
        finalEmbedUrl += `${sep}startAt=${resumeSec}&t=${resumeSec}`;
      }
      console.log('[Roxy Player] Web browser environment: loading direct no-referrer embed URL:', finalEmbedUrl);
      this.iframeEl.removeAttribute('srcdoc');
      this.iframeEl.setAttribute('referrerpolicy', 'no-referrer');
      this.iframeEl.src = finalEmbedUrl;
      this.iframeEl.onload = () => {
        setTimeout(() => this.hideLoadingCurtain(), 1200);
      };
      return;
    }

    try {
      // 1. Try to fetch direct embed URL from API (webOS only)
      let apiUrl = isTv 
        ? CONFIG.STREAM_PROVIDERS.VIXSRC_API_TV.replace('{id}', item.id).replace('{season}', season).replace('{episode}', episode)
        : CONFIG.STREAM_PROVIDERS.VIXSRC_API_MOVIE.replace('{id}', item.id);

      if (resumeSec > 5) {
        apiUrl += `&startAt=${resumeSec}&t=${resumeSec}`;
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
                const l = (t.language || t.label || t.name || '').toLowerCase();
                return l.includes('it') || l.includes('ita') || l.includes('italian');
              });
              if (itIdx >= 0) {
                n.setCurrentAudioTrack(itIdx);
                console.log("[Roxy Player] Set Italian audio track index:", itIdx);
              }
            }

            n.on("ready", function() {
              selectItalianAudio(n.getAudioTracks());
              selectMaxQuality(n.getQualityLevels());
              
              if (${resumeSec} > 0 && !hasResumed) {
                hasResumed = true;
                n.seek(${resumeSec});
              }

              // Send progress notification to parent Roxy UI
              try {
                window.parent.postMessage({
                  type: "ROXY_PLAYBACK_PROGRESS",
                  currentTime: n.getPosition(),
                  duration: n.getDuration()
                }, "*");
              } catch(e) {}
            });

            n.on("levels", function(e) {
              selectMaxQuality(e.levels);
            });

            n.on("audioTracks", function(e) {
              selectItalianAudio(e.tracks);
            });

            n.on("time", function(e) {
              const now = Date.now();
              if (now - w > 1000) {
                w = now;
                try {
                  window.parent.postMessage({
                    type: "ROXY_PLAYBACK_PROGRESS",
                    currentTime: e.position,
                    duration: e.duration
                  }, "*");
                } catch(err) {}
              }
            });

            n.on("seeked", function(e) {
              try {
                window.parent.postMessage({
                  type: "ROXY_PLAYBACK_PROGRESS",
                  currentTime: e.position,
                  duration: n.getDuration()
                }, "*");
              } catch(err) {}
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
      console.warn('[Roxy Player] Direct API pipeline notice, using fallback page:', err);
    }

    // Fallback: load directly into iframe with no-referrer
    console.log('[Roxy Player] Fallback to direct src:', fallbackUrl);
    this.iframeEl.removeAttribute('srcdoc');
    this.iframeEl.setAttribute('referrerpolicy', 'no-referrer');
    this.iframeEl.src = fallbackUrl;
    this.iframeEl.onload = () => {
      setTimeout(() => this.hideLoadingCurtain(), 1200);
    };
  },

  close() {
    if (!this.isActive) return;

    if (this.sessionTicker) {
      clearInterval(this.sessionTicker);
      this.sessionTicker = null;
    }

    if (this.loadingTimeout) {
      clearTimeout(this.loadingTimeout);
      this.loadingTimeout = null;
    }

    // Flush last progress before unmounting
    if (this.currentItem) {
      const finalTime = this.calculateCurrentPlaybackTime();
      if (finalTime > 0) {
        StorageService.saveWatchProgress(this.currentItem, finalTime, this.estimatedDuration || 7200);
      }
    }

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
    this.playStartTime = null;
    window.navigatorInstance.setPlayerActive(false);

    if (this.loadingCurtain) {
      this.loadingCurtain.classList.remove('fade-out');
      this.loadingCurtain.style.display = 'none';
    }

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
    this.currentSessionTime = Math.floor(current);
    this.estimatedDuration = Math.floor(duration);
    const percent = (current / duration) * 100;

    if (this.progressBar) {
      this.progressBar.style.width = `${percent}%`;
    }
    if (this.timeCurrentEl) {
      this.timeCurrentEl.textContent = this.formatTime(current);
    }
    if (this.timeDurationEl) {
      const remaining = Math.max(0, duration - current);
      this.timeDurationEl.textContent = `-${this.formatTime(remaining)}`;
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
    if (this.iconPause && this.iconPlay) {
      this.iconPause.style.display = this.isPlaying ? 'block' : 'none';
      this.iconPlay.style.display = this.isPlaying ? 'none' : 'block';
    } else if (this.playBtn) {
      this.playBtn.textContent = this.isPlaying ? '⏸' : '▶';
    }
  },

  formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const totalSecs = Math.floor(seconds);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hrs > 0) {
      return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  },

  toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        if (this.container && this.container.requestFullscreen) {
          this.container.requestFullscreen().catch(() => {});
        } else if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => {});
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        }
      }
    } catch (e) {
      console.warn('Fullscreen notice:', e);
    }
  },

  handleKey(code, e) {
    // If progress bar is focused, LEFT and RIGHT scrub the video
    if (this.progressTrack && this.progressTrack.classList.contains('focused')) {
      if (code === CONFIG.KEYS.LEFT) {
        this.seek(-10);
        return true;
      }
      if (code === CONFIG.KEYS.RIGHT) {
        this.seek(10);
        return true;
      }
    }

    // Toggle fullscreen on 'F' key (70)
    if (code === 70) {
      this.toggleFullscreen();
      return true;
    }

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
      this.seek(10);
      return true;
    }
    if (code === CONFIG.KEYS.REWIND) {
      this.seek(-10);
      return true;
    }
    if (code === CONFIG.KEYS.UP || code === CONFIG.KEYS.DOWN || code === CONFIG.KEYS.LEFT || code === CONFIG.KEYS.RIGHT) {
      this.showOSD();
      return false; // let spatial nav move inside OSD
    }
    return false;
  }
};

window.PlayerController = PlayerController;
