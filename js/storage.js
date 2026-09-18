/**
 * Roxy - Local Storage Manager for webOS
 * Manages Continue Watching history, Watchlist, and App State
 */
const StorageService = {
  KEYS: {
    CONTINUE_WATCHING: 'roxy_continue_watching',
    PLAYBACK_POSITIONS: 'roxy_playback_positions',
    WATCHLIST: 'roxy_watchlist',
    SETTINGS: 'roxy_settings'
  },

  getUserKey(baseKey) {
    const user = window.SupabaseService ? window.SupabaseService.getActiveUser() : null;
    return user ? `${baseKey}_${user.id}` : baseKey;
  },

  // Continue Watching
  getContinueWatching() {
    try {
      const data = localStorage.getItem(this.getUserKey(this.KEYS.CONTINUE_WATCHING));
      if (!data) return [];
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      
      // Strict deduplication by media id
      const seen = new Set();
      const cleanList = [];
      for (const item of parsed) {
        if (!item || !item.id) continue;
        const key = String(item.id);
        if (!seen.has(key)) {
          seen.add(key);
          cleanList.push(item);
        }
      }
      return cleanList;
    } catch (e) {
      console.error('Storage read error:', e);
      return [];
    }
  },

  getItemProgress(id, season = null, episode = null) {
    try {
      if (!id) return null;
      const mediaId = String(id);
      
      // 1. Check persistent playback positions cache
      const positionsData = localStorage.getItem(this.getUserKey(this.KEYS.PLAYBACK_POSITIONS));
      if (positionsData) {
        const positions = JSON.parse(positionsData);
        if (season !== null && episode !== null && positions[`${mediaId}_s${season}_e${episode}`]) {
          return positions[`${mediaId}_s${season}_e${episode}`];
        }
        if (positions[mediaId]) {
          const p = positions[mediaId];
          if (season === null && episode === null) return p;
          if (Number(p.season) === Number(season) && Number(p.episode) === Number(episode)) return p;
        }
      }

      // 2. Fallback to Continue Watching array
      const list = this.getContinueWatching();
      if (season !== null && episode !== null) {
        const epMatch = list.find(i => String(i.id) === mediaId && Number(i.season) === Number(season) && Number(i.episode) === Number(episode));
        if (epMatch) return epMatch;
      }
      return list.find(i => String(i.id) === mediaId) || null;
    } catch (e) {
      return null;
    }
  },

  saveWatchProgress(item, currentTime = 0, duration = 0) {
    try {
      if (!item || !item.id) return;
      const mediaId = String(item.id);
      const isSaturn = (item.source === 'animesaturn' || mediaId.startsWith('saturn_'));
      const isTv = (item.media_type === 'tv' || isSaturn || !!item.name || (item.number_of_seasons !== undefined));
      
      const finalDuration = (duration && duration > 0) ? Math.floor(duration) : (isTv ? 2700 : 7200);
      const finalCurrentTime = Math.max(0, Math.floor(currentTime || 0));
      const progressPercent = Math.min(100, Math.round((finalCurrentTime / finalDuration) * 100));

      const season = isTv ? (Number(item.season) || 1) : undefined;
      const episode = isTv ? (Number(item.episode) || 1) : undefined;

      const record = {
        id: item.id,
        source: item.source || (isSaturn ? 'animesaturn' : 'tmdb'),
        slug: item.slug || '',
        isDub: item.isDub || false,
        media_type: item.media_type || (isSaturn ? 'anime' : (isTv ? 'tv' : 'movie')),
        title: item.title || item.name || 'Streaming',
        backdrop_path: item.backdrop_path,
        poster_path: item.poster_path,
        season: season,
        episode: episode,
        episode_name: item.episode_name || '',
        currentTime: finalCurrentTime,
        duration: finalDuration,
        progress: progressPercent,
        updatedAt: Date.now()
      };

      // Always persist exact playback time in positions dictionary (both overall show & episode-specific)
      try {
        const positionsKey = this.getUserKey(this.KEYS.PLAYBACK_POSITIONS);
        const positions = JSON.parse(localStorage.getItem(positionsKey) || '{}');
        positions[mediaId] = record;
        if (isTv && season && episode) {
          positions[`${mediaId}_s${season}_e${episode}`] = record;
        }
        localStorage.setItem(positionsKey, JSON.stringify(positions));
      } catch (err) {}

      // Update Continue Watching Carousel list (filter out duplicates)
      const list = this.getContinueWatching().filter(i => String(i.id) !== mediaId);

      // Save to carousel if progress is not finished (>95%)
      if (progressPercent < 95) {
        list.unshift(record);
      }
      
      // Keep up to 30 items in local carousel
      localStorage.setItem(this.getUserKey(this.KEYS.CONTINUE_WATCHING), JSON.stringify(list.slice(0, 30)));

      // Sync to Supabase Cloud in background
      if (window.SupabaseService) {
        SupabaseService.syncWatchProgress(item, finalCurrentTime, finalDuration).catch(() => {});
      }
    } catch (e) {
      console.error('Storage save error:', e);
    }
  },

  removeContinueWatching(id) {
    try {
      if (!id) return false;
      const mediaId = String(id);
      const list = this.getContinueWatching().filter(i => String(i.id) !== mediaId);
      localStorage.setItem(this.getUserKey(this.KEYS.CONTINUE_WATCHING), JSON.stringify(list));

      // Update Supabase to set is_hidden = true while preserving minutaggio
      if (window.SupabaseService) {
        SupabaseService.hideWatchProgress(mediaId).catch(() => {});
      }
      return true;
    } catch (e) {
      console.error('Storage remove error:', e);
      return false;
    }
  },

  // Watchlist
  getWatchlist() {
    try {
      const data = localStorage.getItem(this.getUserKey(this.KEYS.WATCHLIST));
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  },

  isInWatchlist(id) {
    const list = this.getWatchlist();
    return list.some(item => String(item.id) === String(id));
  },

  toggleWatchlist(item) {
    try {
      let list = this.getWatchlist();
      const index = list.findIndex(i => String(i.id) === String(item.id));
      let added = false;
      if (index >= 0) {
        list.splice(index, 1);
        added = false;
        if (window.SupabaseService) {
          SupabaseService.syncWatchlistRemove(item.id).catch(() => {});
        }
      } else {
        list.unshift({
          id: item.id,
          source: item.source || 'tmdb',
          slug: item.slug || '',
          isDub: item.isDub || false,
          media_type: item.media_type || (item.name ? 'tv' : 'movie'),
          title: item.title || item.name,
          poster_path: item.poster_path,
          backdrop_path: item.backdrop_path,
          vote_average: item.vote_average,
          release_date: item.release_date || item.first_air_date
        });
        added = true;
        if (window.SupabaseService) {
          SupabaseService.syncWatchlistAdd(item).catch(() => {});
        }
      }
      localStorage.setItem(this.getUserKey(this.KEYS.WATCHLIST), JSON.stringify(list));
      return added;
    } catch (e) {
      console.error('Watchlist toggle error:', e);
      return false;
    }
  },

  // Sync cloud data into local storage on login
  async syncFromCloud() {
    if (!window.SupabaseService) return;
    const user = SupabaseService.getActiveUser();
    if (!user) return;

    try {
      const [cloudContinue, cloudWatchlist] = await Promise.all([
        SupabaseService.getCloudContinueWatching(),
        SupabaseService.getCloudWatchlist()
      ]);

      if (Array.isArray(cloudContinue) && cloudContinue.length > 0) {
        localStorage.setItem(this.getUserKey(this.KEYS.CONTINUE_WATCHING), JSON.stringify(cloudContinue));
        
        // Also populate positions cache
        try {
          const positionsKey = this.getUserKey(this.KEYS.PLAYBACK_POSITIONS);
          const positions = JSON.parse(localStorage.getItem(positionsKey) || '{}');
          for (const item of cloudContinue) {
            const mId = String(item.id);
            positions[mId] = item;
            if (item.season && item.episode) {
              positions[`${mId}_s${item.season}_e${item.episode}`] = item;
            }
          }
          localStorage.setItem(positionsKey, JSON.stringify(positions));
        } catch (err) {}
      }
      if (Array.isArray(cloudWatchlist) && cloudWatchlist.length > 0) {
        localStorage.setItem(this.getUserKey(this.KEYS.WATCHLIST), JSON.stringify(cloudWatchlist));
      }
    } catch (e) {
      console.warn('[StorageService] Cloud sync error:', e);
    }
  }
};

window.StorageService = StorageService;
