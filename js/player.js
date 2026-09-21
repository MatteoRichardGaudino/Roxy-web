/**
 * Roxy - Video Player Controller for webOS
 * Supports embedded stream iframes, HTML5 video and custom stream URLs
 */
const PlayerController = {
  isActive: false,
  currentItem: null,
  osdTimeout: null,
  isPlaying: true,
  prevEpisodeInfo: null,
  nextEpisodeInfo: null,
  isNextPromptDismissed: false,

  init() {
    this.container = document.getElementById('player-view');
    this.osd = document.getElementById('player-osd');
    this.titleEl = document.getElementById('player-title');
    this.videoEl = document.getElementById('native-video-player');
    this.iframeEl = document.getElementById('stream-iframe-player');
    this.playBtn = document.getElementById('osd-btn-play');
    this.iconPause = document.getElementById('osd-icon-pause');
    this.iconPlay = document.getElementById('osd-icon-play');
    this.btnPrevEp = document.getElementById('osd-btn-prev-ep');
    this.btnNextEp = document.getElementById('osd-btn-next-ep');
    this.nextEpPrompt = document.getElementById('player-next-ep-prompt');
    this.promptBtnNext = document.getElementById('prompt-btn-next-ep');
    this.promptBtnClose = document.getElementById('prompt-btn-close');
    this.promptNextLabel = document.getElementById('prompt-next-ep-label');
    this.progressTrack = document.querySelector('.osd-progress-track');
    this.timeCurrentEl = document.getElementById('osd-time-current');
    this.timeDurationEl = document.getElementById('osd-time-duration');
    this.progressBar = document.getElementById('osd-progress-filled');
    this.timePreviewEl = document.getElementById('osd-time-preview');
    this.loadingCurtain = document.getElementById('player-loading-curtain');
    this.loadingTitle = document.getElementById('player-loading-title');
    this.btnVolume = document.getElementById('osd-btn-volume');
    this.volumeSlider = document.getElementById('osd-volume-slider');
    this.iconVolHigh = document.getElementById('osd-icon-vol-high');
    this.iconVolMute = document.getElementById('osd-icon-vol-mute');
    this.currentVolume = 1;
    this.prevUnmutedVolume = 1;
    this.isMuted = false;

    this.bindEvents();

    // Listen to playback progress and status from iframe JWPlayer
    window.addEventListener('message', (e) => this.handleIframeMessage(e));

    // Listen to window navigation and close events to flush progress
    window.addEventListener('beforeunload', () => this.flushSessionProgress());
    window.addEventListener('pagehide', () => this.flushSessionProgress());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.flushSessionProgress();
      }
    });
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
    if (this.currentSessionTime !== null && this.currentSessionTime !== undefined && this.currentSessionTime > 0) {
      return this.currentSessionTime;
    }
    return 0;
  },

  flushSessionProgress() {
    if (this.isActive && this.currentItem) {
      const finalTime = this.calculateCurrentPlaybackTime();
      if (finalTime > 0) {
        const isNearEnd = (this.estimatedDuration > 300 && (this.estimatedDuration - finalTime) <= 180);
        StorageService.saveWatchProgress(
          this.currentItem,
          finalTime,
          this.estimatedDuration || 7200,
          {
            isLastEpisode: !this.nextEpisodeInfo,
            nextEpisode: (isNearEnd && this.nextEpisodeInfo) ? this.nextEpisodeInfo : null
          }
        );
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

    // Extract payload from either:
    // - VixSrc Web Next.js wrapper: { type: "PLAYER_EVENT", event: { event: "timeupdate", currentTime, duration, ... } }
    // - VixSrc direct embed: { type: "PLAYER_EVENT", data: { event: "timeupdate", currentTime, duration, ... } }
    // - Roxy webOS custom script: { type: "ROXY_PLAYBACK_PROGRESS", currentTime, duration }
    // - Flat event object: { event: "timeupdate", currentTime, duration }
    let payload = msgData;
    if (msgData.type === 'PLAYER_EVENT') {
      if (msgData.event && typeof msgData.event === 'object') {
        payload = msgData.event;
      } else if (msgData.data && typeof msgData.data === 'object') {
        payload = msgData.data;
      } else if (typeof msgData.event === 'string') {
        try {
          const parsed = JSON.parse(msgData.event);
          if (parsed && typeof parsed === 'object') payload = parsed;
        } catch (err) {}
      } else if (typeof msgData.data === 'string') {
        try {
          const parsed = JSON.parse(msgData.data);
          if (parsed && typeof parsed === 'object') payload = parsed;
        } catch (err) {}
      }
    } else if (msgData.data && typeof msgData.data === 'object') {
      payload = msgData.data;
    }

    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (err) {}
    }

    if (!payload || typeof payload !== 'object') return;

    // Safely determine eventName (must always be a string before .toLowerCase())
    let rawEventName = '';
    if (typeof payload.event === 'string') {
      rawEventName = payload.event;
    } else if (typeof msgData.event === 'string') {
      rawEventName = msgData.event;
    } else if (typeof payload.type === 'string') {
      rawEventName = payload.type;
    } else if (typeof msgData.type === 'string') {
      rawEventName = msgData.type;
    }
    const eventName = rawEventName.toLowerCase();

    // Safely extract currentTime and duration from all known locations
    let rawCurrTime = null;
    if (payload.currentTime !== undefined) rawCurrTime = payload.currentTime;
    else if (payload.position !== undefined) rawCurrTime = payload.position;
    else if (payload.time !== undefined) rawCurrTime = payload.time;
    else if (payload.data && payload.data.currentTime !== undefined) rawCurrTime = payload.data.currentTime;
    else if (payload.data && payload.data.position !== undefined) rawCurrTime = payload.data.position;
    else if (msgData.currentTime !== undefined) rawCurrTime = msgData.currentTime;
    else if (msgData.position !== undefined) rawCurrTime = msgData.position;
    else if (msgData.time !== undefined) rawCurrTime = msgData.time;
    else if (msgData.data && msgData.data.currentTime !== undefined) rawCurrTime = msgData.data.currentTime;

    let rawDur = null;
    if (payload.duration !== undefined) rawDur = payload.duration;
    else if (payload.data && payload.data.duration !== undefined) rawDur = payload.data.duration;
    else if (msgData.duration !== undefined) rawDur = msgData.duration;
    else if (msgData.data && msgData.data.duration !== undefined) rawDur = msgData.data.duration;

    const currTime = (rawCurrTime !== null && !isNaN(Number(rawCurrTime))) ? Math.floor(Number(rawCurrTime)) : null;
    const dur = (rawDur !== null && !isNaN(Number(rawDur)) && Number(rawDur) > 0) ? Math.floor(Number(rawDur)) : null;

    if (eventName || currTime !== null) {
      console.log(`[Roxy Player Message] Event: ${eventName || 'progress'}, Time: ${currTime}s, Dur: ${dur}s`);
    }

    if (currTime !== null && currTime >= 0) {
      this.hasReceivedIframeEvent = true;
      this.currentSessionTime = currTime;
      if (dur !== null && dur > 0) {
        this.estimatedDuration = dur;
      }
      this.hideLoadingCurtain();
      this.updateProgressDisplay(this.currentSessionTime, this.estimatedDuration);
      this.checkNextEpisodePrompt(this.currentSessionTime, this.estimatedDuration);
    }

    if (eventName === 'play') {
      this.isPlaying = true;
      this.hideLoadingCurtain();
      this.updatePlayBtnIcon();
    } else if (eventName === 'pause') {
      this.isPlaying = false;
      this.updatePlayBtnIcon();
      if (this.currentSessionTime > 0) {
        StorageService.saveWatchProgress(this.currentItem, this.currentSessionTime, this.estimatedDuration);
      }
    } else if (eventName === 'seeked' || eventName === 'seek') {
      if (this.currentSessionTime >= 0) {
        console.log(`[Roxy Player] Seeked event saved at: ${this.currentSessionTime}s`);
        StorageService.saveWatchProgress(this.currentItem, this.currentSessionTime, this.estimatedDuration);
      }
    } else if (eventName === 'ended') {
      this.isPlaying = false;
      this.onEnded();
    } else if (eventName === 'volumechange') {
      if (typeof payload.volume === 'number') {
        this.currentVolume = payload.volume;
        this.isMuted = !!payload.muted || (payload.volume === 0);
        this.updateVolumeUI();
      }
    } else if (eventName === 'timeupdate' || eventName === 'time' || eventName === 'roxy_playback_progress' || (currTime !== null && !['play', 'pause', 'seeked', 'seek', 'ended'].includes(eventName))) {
      const now = Date.now();
      if (!this.lastProgressSave || (now - this.lastProgressSave > 3000)) {
        this.lastProgressSave = now;
        if (this.currentSessionTime > 0) {
          StorageService.saveWatchProgress(this.currentItem, this.currentSessionTime, this.estimatedDuration);
        }
      }
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

    if (this.btnVolume) {
      this.btnVolume.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMute();
      });
    }

    if (this.volumeSlider) {
      this.volumeSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        this.setVolume(parseFloat(e.target.value));
      });
      this.volumeSlider.addEventListener('change', (e) => {
        e.stopPropagation();
        this.setVolume(parseFloat(e.target.value));
      });
    }

    if (this.btnPrevEp) {
      this.btnPrevEp.addEventListener('click', () => this.playPrevEpisode());
    }

    if (this.btnNextEp) {
      this.btnNextEp.addEventListener('click', () => this.playNextEpisode());
    }

    if (this.promptBtnNext) {
      this.promptBtnNext.addEventListener('click', () => this.playNextEpisode());
    }

    if (this.promptBtnClose) {
      this.promptBtnClose.addEventListener('click', () => this.dismissNextEpisodePrompt());
    }

    // Interactive timeline seeking on click, touch or drag & hover time preview
    if (this.progressTrack) {
      const handleSeek = (e) => {
        const rect = this.progressTrack.getBoundingClientRect();
        const clientX = (e.touches && e.touches[0]) ? e.touches[0].clientX : (e.clientX || 0);
        const clickX = clientX - rect.left;
        const ratio = Math.max(0, Math.min(1, clickX / rect.width));

        if (this.videoEl && this.videoEl.style.display !== 'none' && this.videoEl.duration) {
          this.videoEl.currentTime = ratio * this.videoEl.duration;
          this.onTimeUpdate();
        } else if (this.iframeEl && this.iframeEl.contentWindow && this.estimatedDuration > 0) {
          const targetTime = Math.round(ratio * this.estimatedDuration);
          this.currentSessionTime = targetTime;
          this.iframeEl.contentWindow.postMessage({ type: 'ROXY_CMD', action: 'set_time', time: targetTime }, '*');
          this.updateProgressDisplay(targetTime, this.estimatedDuration);
        }
        this.showOSD();
      };

      this.progressTrack.addEventListener('click', (e) => {
        e.stopPropagation();
        handleSeek(e);
      });

      this.progressTrack.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        handleSeek(e);
      }, { passive: true });

      this.progressTrack.addEventListener('touchmove', (e) => {
        e.stopPropagation();
        handleSeek(e);
      }, { passive: true });

      this.progressTrack.addEventListener('mousemove', (e) => {
        const duration = (this.videoEl && this.videoEl.style.display !== 'none' && this.videoEl.duration)
          ? this.videoEl.duration
          : (this.estimatedDuration || 0);
        if (!duration || !this.timePreviewEl) return;
        const rect = this.progressTrack.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const hoverTime = ratio * duration;
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
      this.videoEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.osd && this.osd.classList.contains('hidden')) {
          this.showOSD();
        } else if (this.isSaturnPlayback()) {
          this.hideOSD(true);
        } else {
          this.hideOSD();
        }
      });
    }

    // Reset OSD timer on mouse move or click/touch on background
    if (this.container) {
      this.container.addEventListener('mousemove', () => {
        if (this.lastHiddenAt && (Date.now() - this.lastHiddenAt < 400)) return;
        this.showOSD();
      });

      this.container.addEventListener('click', (e) => {
        const isControl = !!(e.target && e.target.closest && e.target.closest('button, .osd-btn-circle, .osd-play-btn-large, .osd-progress-track, .osd-progress-wrapper, #player-next-ep-prompt, [role="button"]'));
        if (isControl) return;

        if (this.isSaturnPlayback()) {
          if (this.osd && !this.osd.classList.contains('hidden')) {
            e.stopPropagation();
            this.hideOSD(true);
          } else if (this.osd && this.osd.classList.contains('hidden')) {
            this.showOSD();
          }
          return;
        }

        if (e.target === this.container || e.target === this.osd) {
          if (this.osd && this.osd.classList.contains('hidden')) {
            this.showOSD();
          } else {
            this.hideOSD();
          }
        }
      });
    }

    // Double click to toggle fullscreen on player background / video / OSD
    const handleDblClick = (e) => {
      const isControl = !!(e.target && e.target.closest && e.target.closest('button, .osd-btn-circle, .osd-play-btn-large, .osd-progress-track, .osd-progress-wrapper, #player-next-ep-prompt, [role="button"]'));
      if (!isControl) {
        this.toggleFullscreen();
      }
    };

    if (this.container) {
      this.container.addEventListener('dblclick', handleDblClick);
    }
    if (this.videoEl) {
      this.videoEl.addEventListener('dblclick', handleDblClick);
    }
    if (this.osd) {
      this.osd.addEventListener('dblclick', handleDblClick);
    }
  },

  play(item, customStreamUrl = null, explicitResumeTime = null) {
    this.currentItem = item;
    this.isActive = true;
    this.hasReceivedIframeEvent = false;
    this.lastProgressSave = 0;
    this.prevEpisodeInfo = null;
    this.nextEpisodeInfo = null;
    this.isNextPromptDismissed = false;
    this.currentSessionTime = 0;
    this.estimatedDuration = 0;
    this.hideNextEpisodePrompt();
    this.updateTopBarEpisodeButtons();
    window.navigatorInstance.setPlayerActive(true);

    // Completely unload previous video element and iframe to prevent stale timeupdate events
    if (this.videoEl) {
      try {
        this.videoEl.pause();
        this.videoEl.removeAttribute('src');
        this.videoEl.load();
      } catch (e) {}
    }
    if (this.iframeEl) {
      this.iframeEl.removeAttribute('srcdoc');
      this.iframeEl.src = 'about:blank';
    }

    try {
      if (window.history && window.history.pushState) {
        window.history.pushState({ roxyPlayer: true }, '');
      }
    } catch (e) {}

    const isSaturn = (item.source === 'animesaturn' || (item.id && String(item.id).startsWith('saturn_')));
    if (isSaturn) {
      this.playSaturn(item, explicitResumeTime);
      return;
    }

    const isTv = !isSaturn && (item.media_type === 'tv' || (item.media_type !== 'movie' && (item.number_of_seasons !== undefined || (!!item.name && !item.title))));
    let season = item.season;
    let episode = item.episode;

    // If TV show has no explicit season/episode, check saved progress to resume last watched episode
    if (isTv) {
      if (!season || !episode) {
        const lastSaved = StorageService.getItemProgress(item.id);
        if (lastSaved && lastSaved.season && lastSaved.episode) {
          season = Number(lastSaved.season);
          episode = Number(lastSaved.episode);
        } else {
          season = season || 1;
          episode = episode || 1;
        }
      }
      season = Number(season) || 1;
      episode = Number(episode) || 1;
      item.season = season;
      item.episode = episode;
      item.media_type = 'tv';
      this.resolveAdjacentEpisodes(item);
    } else {
      season = 0;
      episode = 0;
      item.season = undefined;
      item.episode = undefined;
      item.media_type = 'movie';
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

    const displayTitle = this.updatePlayerTitle(item);

    if (this.loadingCurtain) {
      this.loadingCurtain.classList.remove('fade-out');
      this.loadingCurtain.style.display = 'flex';
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

    // Initialize session state for real playback tracking
    this.currentSessionTime = resumeSec;
    this.estimatedDuration = isTv ? 2700 : 7200;

    // Save initial progress
    StorageService.saveWatchProgress({
      ...item,
      media_type: isTv ? 'tv' : 'movie',
      season: isTv ? season : undefined,
      episode: isTv ? episode : undefined
    }, resumeSec, this.estimatedDuration);
  },

  async playSaturn(item, explicitResumeTime = null) {
    this.currentItem = item;
    this.prevEpisodeInfo = null;
    this.nextEpisodeInfo = null;
    this.isNextPromptDismissed = false;
    this.hideNextEpisodePrompt();
    this.updateTopBarEpisodeButtons();
    this.resolveAdjacentEpisodes(item);

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

    this.updatePlayerTitle(item);
    if (this.loadingCurtain) {
      this.loadingCurtain.classList.remove('fade-out');
      this.loadingCurtain.style.display = 'flex';
    }
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

    // Initialize session state for anime playback
    this.currentSessionTime = resumeSec;
    this.estimatedDuration = 1440; // 24m standard anime

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

          v.addEventListener('volumechange', function() {
            window.parent.postMessage({
              type: 'PLAYER_EVENT',
              data: { event: 'volumechange', volume: v.muted ? 0 : v.volume, muted: v.muted }
            }, '*');
          });
        }

        window.addEventListener('message', function(e) {
          if (!e.data || e.data.type !== 'ROXY_CMD') return;
          const v = document.querySelector('video');
          if (!v) return;
          if (e.data.action === 'set_volume') {
            const vol = Math.max(0, Math.min(1, Number(e.data.volume)));
            v.volume = vol;
            v.muted = (vol === 0);
          } else if (e.data.action === 'toggle_mute') {
            v.muted = !v.muted;
          } else if (e.data.action === 'toggle_play') {
            if (v.paused) v.play(); else v.pause();
          } else if (e.data.action === 'play') {
            v.play();
          } else if (e.data.action === 'pause') {
            v.pause();
          } else if (e.data.action === 'seek') {
            v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + (e.data.seconds || 0)));
          } else if (e.data.action === 'set_time') {
            v.currentTime = Math.max(0, Math.min(v.duration || Infinity, Number(e.data.time || 0)));
          }
        });

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

              // Explicitly trigger play for both new and resumed content
              try {
                n.play();
              } catch(e) {}

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

    if (this.loadingTimeout) {
      clearTimeout(this.loadingTimeout);
      this.loadingTimeout = null;
    }

    this.hideNextEpisodePrompt();
    this.isNextPromptDismissed = false;

    // Flush last progress before unmounting
    if (this.currentItem) {
      const finalTime = this.calculateCurrentPlaybackTime();
      if (finalTime > 0) {
        const isNearEnd = (this.estimatedDuration > 300 && (this.estimatedDuration - finalTime) <= 180);
        StorageService.saveWatchProgress(
          this.currentItem,
          finalTime,
          this.estimatedDuration || 7200,
          {
            isLastEpisode: !this.nextEpisodeInfo,
            nextEpisode: (isNearEnd && this.nextEpisodeInfo) ? this.nextEpisodeInfo : null
          }
        );
      }
    }

    this.prevEpisodeInfo = null;
    this.nextEpisodeInfo = null;
    this.updateTopBarEpisodeButtons();

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

    // Refresh home community row asynchronously
    if (window.App && window.App.refreshCommunityRowAsync) {
      window.App.refreshCommunityRowAsync({ force: true });
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

  isSaturnPlayback() {
    if (!this.isActive || !this.currentItem) return false;
    return (this.currentItem.source === 'animesaturn' || String(this.currentItem.id || '').startsWith('saturn_'));
  },

  hideOSD(force = false) {
    if (!this.osd) return;
    if (this.osdTimeout) {
      clearTimeout(this.osdTimeout);
      this.osdTimeout = null;
    }
    if (this.isActive && (this.isPlaying || force)) {
      this.osd.classList.add('hidden');
      this.lastHiddenAt = Date.now();
      if (this.container) {
        this.container.classList.add('cursor-hidden');
      }
    }
  },

  showOSD() {
    if (!this.osd) return;
    this.osd.classList.remove('hidden');
    if (this.container) {
      this.container.classList.remove('cursor-hidden');
    }

    if (this.osdTimeout) {
      clearTimeout(this.osdTimeout);
    }

    // Snappy auto-hide timer for player controls & top bar (2200ms)
    this.osdTimeout = setTimeout(() => {
      this.hideOSD();
    }, 2200);
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

    this.checkNextEpisodePrompt(this.currentSessionTime, this.estimatedDuration);

    const now = Date.now();
    if (!this.lastProgressSave || (now - this.lastProgressSave > 3000)) {
      this.lastProgressSave = now;
      if (this.currentItem) {
        StorageService.saveWatchProgress(this.currentItem, this.currentSessionTime, this.estimatedDuration);
      }
    }
  },

  onEnded() {
    this.isPlaying = false;
    this.updatePlayBtnIcon();

    if (this.nextEpisodeInfo) {
      console.log('[Roxy Player] Stream ended, auto-advancing to next episode:', this.nextEpisodeInfo);
      this.isNextPromptDismissed = false;
      this.showNextEpisodePrompt();
      this.showOSD();
      if (window.App && window.App.showToast) {
        window.App.showToast('Avvio prossimo episodio in corso... 🍿');
      }
      setTimeout(() => {
        if (this.isActive && this.nextEpisodeInfo) {
          this.playNextEpisode();
        }
      }, 1800);
      return;
    }

    // No next episode available: mark as last episode finished
    if (this.currentItem) {
      StorageService.saveWatchProgress(
        this.currentItem,
        this.estimatedDuration || 7200,
        this.estimatedDuration || 7200,
        { isLastEpisode: true }
      );
    }
    this.showOSD();
  },

  setVolume(val) {
    const clamped = Math.max(0, Math.min(1, val));
    this.currentVolume = clamped;
    this.isMuted = (clamped === 0);

    if (this.videoEl && this.videoEl.style.display !== 'none') {
      this.videoEl.volume = clamped;
      this.videoEl.muted = this.isMuted;
    }

    if (this.iframeEl && this.iframeEl.contentWindow) {
      this.iframeEl.contentWindow.postMessage({
        type: 'ROXY_CMD',
        action: 'set_volume',
        volume: clamped
      }, '*');
    }

    this.updateVolumeUI();
  },

  toggleMute() {
    if (this.isMuted || this.currentVolume === 0) {
      const restored = (this.prevUnmutedVolume && this.prevUnmutedVolume > 0) ? this.prevUnmutedVolume : 0.8;
      this.setVolume(restored);
    } else {
      this.prevUnmutedVolume = this.currentVolume;
      this.setVolume(0);
    }
  },

  updateVolumeUI() {
    if (this.volumeSlider) {
      this.volumeSlider.value = this.currentVolume;
    }
    if (this.iconVolHigh && this.iconVolMute) {
      const isZero = (this.isMuted || this.currentVolume <= 0.01);
      this.iconVolHigh.style.display = isZero ? 'none' : 'block';
      this.iconVolMute.style.display = isZero ? 'block' : 'none';
    }
  },

  // =========================================================================
  // Episode Navigation & Next Episode Prompt
  // =========================================================================
  cleanBaseTitle(item) {
    if (!item) return 'Streaming';
    let raw = item.show_title || item.name || item.title || 'Streaming';
    if (typeof raw !== 'string') raw = String(raw);
    // 1. Remove leading emojis/symbols (e.g. 🪐)
    raw = raw.replace(/^[^\w\s\d\u00C0-\u017F]+/gi, '').trim();
    // 2. Remove any existing " - S\d+:E\d+.*" or " S\d+:E\d+.*"
    raw = raw.replace(/\s*-\s*S\d+\s*:\s*E\d+.*$/i, '');
    raw = raw.replace(/\s+S\d+\s*:\s*E\d+.*$/i, '');
    // 3. Remove any existing " - Ep\.?\s*\d+.*" or " Ep\.?\s*\d+.*"
    raw = raw.replace(/\s*-\s*Ep\.?\s*\d+.*$/i, '');
    raw = raw.replace(/\s+Ep\.?\s*\d+.*$/i, '');
    // 4. Remove language tags (ITA), (SUB ITA), (DUB ITA), etc.
    raw = raw.replace(/\s*\((ITA|SUB|SUB ITA|DUB|DUB ITA)\)\s*/gi, '');
    // 5. Remove quotes and trailing dashes
    raw = raw.replace(/["“”«»]/g, '').replace(/[-–—]\s*$/, '').trim();
    return raw || 'Streaming';
  },

  updatePlayerTitle(item) {
    if (!item) return '';
    const isSaturn = (item.source === 'animesaturn' || (item.id && String(item.id).startsWith('saturn_')));
    const isTv = !isSaturn && (item.media_type === 'tv' || (item.media_type !== 'movie' && (item.number_of_seasons !== undefined || (!!item.name && !item.title))));
    const baseTitle = this.cleanBaseTitle(item);

    let displayTitle = baseTitle;
    if (isSaturn) {
      const epNum = Number(item.episode) || 1;
      const isDub = item.isDub === true || (
        typeof AnimeSaturnService !== 'undefined' && typeof AnimeSaturnService.isDubAnime === 'function'
          ? AnimeSaturnService.isDubAnime(item.title || item.name, item.slug || item.id)
          : (String(item.id || '').includes('-ita-') || String(item.title || '').includes('(ITA)'))
      );
      const subLabel = isDub ? 'DUB ITA' : 'SUB ITA';
      displayTitle = `🪐 ${baseTitle} - Ep. ${epNum} (${subLabel})`;
      if (item.episode_name && item.episode_name.trim() && !item.episode_name.startsWith('Episodio')) {
        displayTitle += ` "${item.episode_name.trim()}"`;
      }
    } else if (isTv) {
      const season = Number(item.season) || 1;
      const episode = Number(item.episode) || 1;
      displayTitle = `${baseTitle} - S${season}:E${episode}`;
      if (item.episode_name && item.episode_name.trim()) {
        displayTitle += ` "${item.episode_name.trim()}"`;
      }
    }

    if (this.titleEl) {
      this.titleEl.textContent = displayTitle;
    }
    if (this.loadingTitle) {
      this.loadingTitle.textContent = displayTitle;
    }
    try {
      document.title = `${displayTitle} | ${CONFIG.APP_NAME || 'Roxy'}`;
    } catch (e) {}

    return displayTitle;
  },

  async resolveAdjacentEpisodes(item) {
    this.prevEpisodeInfo = null;
    this.nextEpisodeInfo = null;
    this.isNextPromptDismissed = false;
    this.hideNextEpisodePrompt();
    this.updateTopBarEpisodeButtons();

    if (!item) return;

    const isSaturn = (item.source === 'animesaturn' || (item.id && String(item.id).startsWith('saturn_')));
    const isTv = !isSaturn && (item.media_type === 'tv' || (item.media_type !== 'movie' && (item.number_of_seasons !== undefined || (!!item.name && !item.title))));
    if (!isTv && !isSaturn) return;

    const baseTitle = this.cleanBaseTitle(item);

    if (isSaturn) {
      const slug = item.slug || String(item.id).replace(/^saturn_/, '');
      const currentEp = Number(item.episode) || 1;

      // 1. Previous episode
      if (currentEp > 1) {
        this.prevEpisodeInfo = {
          ...item,
          source: 'animesaturn',
          title: baseTitle,
          season: 1,
          episode: currentEp - 1,
          episode_name: `Episodio ${currentEp - 1}`
        };
      }

      // Check if episode list already exists on item
      if (Array.isArray(item.episodes) && item.episodes.length > 0) {
        const currEpObj = item.episodes.find(e => Number(e.episode_number) === currentEp);
        if (currEpObj && currEpObj.name) {
          item.episode_name = currEpObj.name;
          this.updatePlayerTitle(item);
        }
        if (currentEp < item.episodes.length) {
          const nextEpNum = currentEp + 1;
          const nextEpObj = item.episodes.find(e => Number(e.episode_number) === nextEpNum);
          this.nextEpisodeInfo = {
            ...item,
            source: 'animesaturn',
            title: baseTitle,
            season: 1,
            episode: nextEpNum,
            episode_name: nextEpObj ? nextEpObj.name : `Episodio ${nextEpNum}`,
            isNextSeason: false
          };
        }
        this.updateTopBarEpisodeButtons();
      }

      // 2. Next episode: fetch details from AnimeSaturn addon to check total episode count
      try {
        const details = await AnimeSaturnService.getAnimeDetails(slug);
        const epCount = (details && Array.isArray(details.episodes)) ? details.episodes.length : 0;
        if (epCount > 0) {
          const currEpObj = details.episodes.find(e => Number(e.episode_number) === currentEp);
          if (currEpObj && currEpObj.name) {
            item.episode_name = currEpObj.name;
            this.updatePlayerTitle(item);
          }

          if (currentEp < epCount) {
            const nextEpNum = currentEp + 1;
            const nextEpObj = details.episodes.find(e => Number(e.episode_number) === nextEpNum);
            this.nextEpisodeInfo = {
              ...item,
              source: 'animesaturn',
              title: baseTitle,
              season: 1,
              episode: nextEpNum,
              episode_name: nextEpObj ? nextEpObj.name : `Episodio ${nextEpNum}`,
              isNextSeason: false
            };
          } else {
            this.nextEpisodeInfo = null;
          }
        }
      } catch (err) {
        console.warn('[Roxy Player] Error resolving Saturn adjacent episodes:', err);
      }
      this.updateTopBarEpisodeButtons();
    } else {
      // TMDB TV Series
      const tvId = item.id;
      const currentSeason = Number(item.season) || 1;
      const currentEp = Number(item.episode) || 1;

      try {
        const details = await TMDBService.getDetails(tvId, 'tv');
        if (!details || !Array.isArray(details.seasons)) return;

        const regularSeasons = details.seasons
          .filter(s => s.season_number > 0 && (s.episode_count === undefined || s.episode_count > 0))
          .sort((a, b) => a.season_number - b.season_number);

        const currSeasonObj = regularSeasons.find(s => s.season_number === currentSeason);
        const currSeasonEpCount = currSeasonObj ? (currSeasonObj.episode_count || 50) : 50;

        // Fetch current season details to get episode titles
        let currentSeasonEpisodes = [];
        try {
          const sData = await TMDBService.getSeasonDetails(tvId, currentSeason);
          if (sData && Array.isArray(sData.episodes)) {
            currentSeasonEpisodes = sData.episodes;
          }
        } catch (e) {}

        const currEpData = currentSeasonEpisodes.find(e => Number(e.episode_number) === currentEp);
        if (currEpData && currEpData.name) {
          item.episode_name = currEpData.name;
          this.updatePlayerTitle(item);
        }

        // 1. Previous Episode
        if (currentEp > 1) {
          const prevEpData = currentSeasonEpisodes.find(e => Number(e.episode_number) === currentEp - 1);
          this.prevEpisodeInfo = {
            ...item,
            media_type: 'tv',
            title: baseTitle,
            season: currentSeason,
            episode: currentEp - 1,
            episode_name: prevEpData ? prevEpData.name : ''
          };
        } else if (currentSeason > 1) {
          const prevSeasonObj = regularSeasons.find(s => s.season_number === currentSeason - 1);
          if (prevSeasonObj && prevSeasonObj.episode_count > 0) {
            this.prevEpisodeInfo = {
              ...item,
              media_type: 'tv',
              title: baseTitle,
              season: currentSeason - 1,
              episode: prevSeasonObj.episode_count,
              episode_name: ''
            };
          }
        }

        // 2. Next Episode
        if (currentEp < currSeasonEpCount) {
          const nextEpNum = currentEp + 1;
          const nextEpData = currentSeasonEpisodes.find(e => Number(e.episode_number) === nextEpNum);
          const isAvail = (window.CatalogService && CatalogService.episodes && CatalogService.episodes.size > 0)
            ? CatalogService.isEpisodeAvailable(tvId, currentSeason, nextEpNum)
            : true;

          if (isAvail) {
            this.nextEpisodeInfo = {
              ...item,
              media_type: 'tv',
              title: baseTitle,
              season: currentSeason,
              episode: nextEpNum,
              episode_name: nextEpData ? nextEpData.name : '',
              isNextSeason: false
            };
          }
        } else {
          // Last episode of current season: check for next season
          const nextSeasonObj = regularSeasons.find(s => s.season_number === currentSeason + 1);
          if (nextSeasonObj && nextSeasonObj.episode_count > 0) {
            const isAvail = (window.CatalogService && CatalogService.episodes && CatalogService.episodes.size > 0)
              ? CatalogService.isEpisodeAvailable(tvId, currentSeason + 1, 1)
              : true;

            if (isAvail) {
              this.nextEpisodeInfo = {
                ...item,
                media_type: 'tv',
                title: baseTitle,
                season: currentSeason + 1,
                episode: 1,
                episode_name: '',
                isNextSeason: true
              };
            }
          }
        }
      } catch (err) {
        console.warn('[Roxy Player] Error resolving TMDB adjacent episodes:', err);
      }
    }

    this.updateTopBarEpisodeButtons();
  },

  updateTopBarEpisodeButtons() {
    if (this.btnPrevEp) {
      if (this.prevEpisodeInfo) {
        this.btnPrevEp.style.display = 'flex';
        const s = this.prevEpisodeInfo.season;
        const e = this.prevEpisodeInfo.episode;
        this.btnPrevEp.title = (s !== undefined) ? `Episodio precedente (S${s}:E${e})` : `Episodio precedente (Ep. ${e})`;
      } else {
        this.btnPrevEp.style.display = 'none';
      }
    }

    if (this.btnNextEp) {
      if (this.nextEpisodeInfo) {
        this.btnNextEp.style.display = 'flex';
        const isNextS = this.nextEpisodeInfo.isNextSeason;
        const s = this.nextEpisodeInfo.season;
        const e = this.nextEpisodeInfo.episode;
        if (isNextS) {
          this.btnNextEp.title = `Prossima stagione (S${s}:E1)`;
        } else {
          this.btnNextEp.title = (s !== undefined) ? `Prossimo episodio (S${s}:E${e})` : `Prossimo episodio (Ep. ${e})`;
        }
      } else {
        this.btnNextEp.style.display = 'none';
      }
    }
  },

  checkNextEpisodePrompt(currentTime, duration) {
    if (!this.nextEpisodeInfo) return;
    if (!duration || duration <= 180 || !currentTime) return;
    if (currentTime < 60) {
      this.hideNextEpisodePrompt();
      return;
    }

    const remaining = duration - currentTime;
    // If dismissed early by user with 'X', suppress until the final 20 seconds / credits
    if (this.isNextPromptDismissed && remaining > 20) return;
    if (remaining <= 120 && remaining > 0) {
      this.showNextEpisodePrompt();
    }
  },

  showNextEpisodePrompt() {
    if (!this.nextEpPrompt || !this.nextEpisodeInfo) return;
    if (this.promptNextLabel) {
      this.promptNextLabel.textContent = (this.nextEpisodeInfo && this.nextEpisodeInfo.isNextSeason) ? 'Prossima Stagione' : 'Prossimo Episodio';
    }
    this.nextEpPrompt.style.display = 'flex';
  },

  hideNextEpisodePrompt() {
    if (this.nextEpPrompt) {
      this.nextEpPrompt.style.display = 'none';
    }
  },

  dismissNextEpisodePrompt() {
    this.isNextPromptDismissed = true;
    this.hideNextEpisodePrompt();
  },

  playNextEpisode() {
    if (!this.nextEpisodeInfo) return;
    const nextItem = { ...this.nextEpisodeInfo };
    this.isNextPromptDismissed = false;
    this.hideNextEpisodePrompt();

    // Immediately update title to show next episode number and title without delay
    this.updatePlayerTitle(nextItem);

    // Save current episode as completed with pointer to next episode
    if (this.currentItem) {
      StorageService.saveWatchProgress(
        this.currentItem,
        this.calculateCurrentPlaybackTime(),
        this.estimatedDuration || 2700,
        { nextEpisode: nextItem }
      );
    }

    console.log('[Roxy Player] Advancing to next episode:', nextItem);
    this.play(nextItem, null, 0);
  },

  playPrevEpisode() {
    if (!this.prevEpisodeInfo) return;
    const prevItem = { ...this.prevEpisodeInfo };
    this.isNextPromptDismissed = false;
    this.hideNextEpisodePrompt();

    // Immediately update title to show previous episode number and title without delay
    this.updatePlayerTitle(prevItem);

    // Save current episode position before leaving
    if (this.currentItem) {
      StorageService.saveWatchProgress(
        this.currentItem,
        this.calculateCurrentPlaybackTime(),
        this.estimatedDuration || 2700
      );
    }

    console.log('[Roxy Player] Going back to previous episode:', prevItem);
    this.play(prevItem, null, 0);
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
    // 1. Spacebar / Play-Pause / Key 'K'
    if (code === 32 || (e && (e.code === 'Space' || e.key === ' ')) || code === CONFIG.KEYS.PLAY_PAUSE || code === 75 || (e && (e.key === 'k' || e.key === 'K'))) {
      this.togglePlay();
      return true;
    }

    // 2. Play / Pause dedicated keys
    if (code === CONFIG.KEYS.PLAY) {
      if (!this.isPlaying) this.togglePlay();
      return true;
    }
    if (code === CONFIG.KEYS.PAUSE) {
      if (this.isPlaying) this.togglePlay();
      return true;
    }

    // 3. Left Arrow / Rewind / Key 'J' (Seek -10s)
    if (code === CONFIG.KEYS.REWIND || code === CONFIG.KEYS.LEFT || (e && (e.key === 'ArrowLeft' || e.key === 'j' || e.key === 'J'))) {
      this.seek(-10);
      return true;
    }

    // 4. Right Arrow / Fast-Forward / Key 'L' (Seek +10s)
    if (code === CONFIG.KEYS.FAST_FORWARD || code === CONFIG.KEYS.RIGHT || (e && (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'L'))) {
      this.seek(10);
      return true;
    }

    // 5. Up Arrow (Volume +10%)
    if (code === CONFIG.KEYS.UP || (e && e.key === 'ArrowUp')) {
      this.setVolume(this.currentVolume + 0.1);
      this.showOSD();
      return true;
    }

    // 6. Down Arrow (Volume -10%)
    if (code === CONFIG.KEYS.DOWN || (e && e.key === 'ArrowDown')) {
      this.setVolume(this.currentVolume - 0.1);
      this.showOSD();
      return true;
    }

    // 7. Toggle Mute on 'M' key (77)
    if (code === 77 || (e && (e.key === 'm' || e.key === 'M'))) {
      this.toggleMute();
      this.showOSD();
      return true;
    }

    // 8. Toggle fullscreen on 'F' key (70)
    if (code === 70 || (e && (e.key === 'f' || e.key === 'F'))) {
      this.toggleFullscreen();
      return true;
    }

    // 9. Next episode on 'N' key (78)
    if ((code === 78 || (e && (e.key === 'n' || e.key === 'N'))) && this.nextEpisodeInfo) {
      this.playNextEpisode();
      return true;
    }

    // 10. Previous episode on 'P' key (80)
    if ((code === 80 || (e && (e.key === 'p' || e.key === 'P'))) && this.prevEpisodeInfo) {
      this.playPrevEpisode();
      return true;
    }

    return false;
  }
};

window.PlayerController = PlayerController;
