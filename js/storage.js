/**
 * Roxy - Local Storage Manager for webOS
 * Manages Continue Watching history, Watchlist, and App State
 */
const StorageService = {
  KEYS: {
    CONTINUE_WATCHING: 'roxy_continue_watching',
    PLAYBACK_POSITIONS: 'roxy_playback_positions',
    WATCHLIST: 'roxy_watchlist',
    SETTINGS: 'roxy_settings',
    COMMUNITY_HIDDEN: 'roxy_community_hidden',
    DROPPED: 'roxy_dropped'
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
      
      // Strict deduplication by media id and filter out finished movies / finished last episodes / dropped items
      const seen = new Set();
      const cleanList = [];
      for (const item of parsed) {
        if (!item || !item.id) continue;
        if (this.isDropped(item.id)) continue;
        const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
        const isTv = !isSaturn && (item.media_type === 'tv' || (item.media_type !== 'movie' && (item.number_of_seasons !== undefined || (!!item.name && !item.title))));
        const rem = (item.duration && item.currentTime !== undefined) ? (item.duration - item.currentTime) : 999;
        const isNearEnd = (item.progress >= 95) || (item.duration > 300 && rem <= 180);
        
        // Exclude completed movies
        if (!isTv && isNearEnd) continue;
        // Exclude completed last episode of series
        if (isTv && isNearEnd && item.isLastEpisode) continue;

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

  saveWatchProgress(item, currentTime = 0, duration = 0, options = {}) {
    try {
      if (!item || !item.id) return;
      const mediaId = String(item.id);
      const isSaturn = (item.source === 'animesaturn' || mediaId.startsWith('saturn_'));
      const isTv = !isSaturn && (item.media_type === 'tv' || (item.media_type !== 'movie' && (item.number_of_seasons !== undefined || (!!item.name && !item.title))));
      
      const finalDuration = (duration && duration > 0) ? Math.floor(duration) : (isTv ? 2700 : 7200);
      const finalCurrentTime = Math.max(0, Math.floor(currentTime || 0));
      const progressPercent = Math.min(100, Math.round((finalCurrentTime / finalDuration) * 100));
      const remainingSeconds = Math.max(0, finalDuration - finalCurrentTime);
      const isNearEnd = (progressPercent >= 95) || (finalDuration > 300 && remainingSeconds <= 180);

      const season = isTv ? (Number(item.season) || 1) : undefined;
      const episode = isTv ? (Number(item.episode) || 1) : undefined;

      const record = {
        id: item.id,
        source: item.source || (isSaturn ? 'animesaturn' : 'tmdb'),
        slug: item.slug || '',
        isDub: item.isDub || false,
        media_type: isSaturn ? 'anime' : (isTv ? 'tv' : 'movie'),
        title: item.title || item.name || 'Streaming',
        backdrop_path: item.backdrop_path,
        poster_path: item.poster_path,
        season: season,
        episode: episode,
        episode_name: item.episode_name || '',
        currentTime: finalCurrentTime,
        duration: finalDuration,
        progress: progressPercent,
        isLastEpisode: !!(options.isLastEpisode || item.isLastEpisode),
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

      if (!isTv) {
        // Movies: DO NOT show if finished or near end (<3 min left)
        if (!isNearEnd) {
          list.unshift(record);
        } else if (window.SupabaseService) {
          SupabaseService.hideWatchProgress(mediaId).catch(() => {});
        }
      } else {
        // TV Series / Anime:
        if (isNearEnd && (options.isLastEpisode || item.isLastEpisode)) {
          // Last episode of entire series is finished: remove from Continue Watching
          if (window.SupabaseService) {
            SupabaseService.hideWatchProgress(mediaId).catch(() => {});
          }
        } else if (options.nextEpisode) {
          // Advance Continue Watching to next episode ready to play!
          const nextEp = options.nextEpisode;
          const nextRecord = {
            ...record,
            season: isTv ? (Number(nextEp.season) || 1) : undefined,
            episode: isTv ? (Number(nextEp.episode) || 1) : undefined,
            episode_name: nextEp.episode_name || '',
            currentTime: 0,
            progress: 0,
            isLastEpisode: !!nextEp.isLastEpisode,
            updatedAt: Date.now()
          };
          list.unshift(nextRecord);
          if (window.SupabaseService) {
            SupabaseService.syncWatchProgress(nextEp, 0, finalDuration).catch(() => {});
          }
        } else {
          // Normal TV progress update (even near end, keeps series in list until next episode advances)
          list.unshift(record);
        }
      }
      
      // Keep up to 30 items in local carousel
      localStorage.setItem(this.getUserKey(this.KEYS.CONTINUE_WATCHING), JSON.stringify(list.slice(0, 30)));

      // Sync to Supabase Cloud in background
      if (window.SupabaseService && (!options.nextEpisode)) {
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
          media_type: item.media_type || (item.name && !item.title ? 'tv' : 'movie'),
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

  // Community Privacy (Hide watch activity from other friends)
  isCommunityHidden(id) {
    try {
      if (!id) return false;
      const data = localStorage.getItem(this.getUserKey(this.KEYS.COMMUNITY_HIDDEN));
      if (!data) return false;
      const list = JSON.parse(data);
      return Array.isArray(list) && list.includes(String(id));
    } catch (e) {
      return false;
    }
  },

  setCommunityHidden(id, isHidden) {
    try {
      if (!id) return false;
      const mediaId = String(id);
      const data = localStorage.getItem(this.getUserKey(this.KEYS.COMMUNITY_HIDDEN));
      let list = [];
      try {
        list = data ? JSON.parse(data) : [];
        if (!Array.isArray(list)) list = [];
      } catch (err) {
        list = [];
      }

      if (isHidden) {
        if (!list.includes(mediaId)) {
          list.push(mediaId);
        }
      } else {
        list = list.filter(item => item !== mediaId);
      }
      localStorage.setItem(this.getUserKey(this.KEYS.COMMUNITY_HIDDEN), JSON.stringify(list));

      if (window.SupabaseService && typeof SupabaseService.setMediaCommunityHidden === 'function') {
        SupabaseService.setMediaCommunityHidden(mediaId, isHidden).catch(() => {});
      }
      return !!isHidden;
    } catch (e) {
      console.error('Storage setCommunityHidden error:', e);
      return false;
    }
  },

  toggleCommunityHidden(id) {
    const current = this.isCommunityHidden(id);
    return this.setCommunityHidden(id, !current);
  },

  // Dropped Content Management (Content marked as abandoned / disliked)
  isDropped(id) {
    try {
      if (!id) return false;
      const data = localStorage.getItem(this.getUserKey(this.KEYS.DROPPED));
      if (!data) return false;
      const list = JSON.parse(data);
      return Array.isArray(list) ? list.includes(String(id)) : !!list[String(id)];
    } catch (e) {
      return false;
    }
  },

  setMediaDropped(id, isDropped) {
    try {
      if (!id) return false;
      const mediaId = String(id);
      const data = localStorage.getItem(this.getUserKey(this.KEYS.DROPPED));
      let list = [];
      try {
        list = data ? JSON.parse(data) : [];
        if (!Array.isArray(list)) list = [];
      } catch (err) {
        list = [];
      }

      if (isDropped) {
        if (!list.includes(mediaId)) list.push(mediaId);
        // Remove from local continue watching immediately
        const contList = this.getContinueWatching().filter(i => String(i.id) !== mediaId);
        localStorage.setItem(this.getUserKey(this.KEYS.CONTINUE_WATCHING), JSON.stringify(contList));
      } else {
        list = list.filter(item => item !== mediaId);
      }
      localStorage.setItem(this.getUserKey(this.KEYS.DROPPED), JSON.stringify(list));
      return !!isDropped;
    } catch (e) {
      console.error('Storage setMediaDropped error:', e);
      return false;
    }
  },

  toggleDropped(id) {
    const current = this.isDropped(id);
    return this.setMediaDropped(id, !current);
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
