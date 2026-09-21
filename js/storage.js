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
        const isSeries = isTv || isSaturn || item.media_type === 'anime';
        const rem = (item.duration && item.currentTime !== undefined) ? (item.duration - item.currentTime) : 999;
        const isNearEnd = (item.progress >= 95) || (item.duration > 300 && rem <= 180);
        
        // Exclude completed movies
        if (!isSeries && isNearEnd) continue;
        // Exclude completed last episode of entire series / anime
        if (isSeries && isNearEnd && item.isLastEpisode) continue;

        const key = String(item.id);
        if (!seen.has(key)) {
          seen.add(key);
          cleanList.push(item);
        }
      }
      cleanList.sort((a, b) => {
        const timeA = Number(a.updatedAt || a.timestamp || 0);
        const timeB = Number(b.updatedAt || b.timestamp || 0);
        return timeB - timeA;
      });
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
        if (episode !== null) {
          const s = season !== null ? season : 1;
          if (positions[`${mediaId}_s${s}_e${episode}`]) {
            return positions[`${mediaId}_s${s}_e${episode}`];
          }
          if (positions[`${mediaId}_e${episode}`]) {
            return positions[`${mediaId}_e${episode}`];
          }
        }
        if (positions[mediaId]) {
          const p = positions[mediaId];
          if (season === null && episode === null) return p;
          if (episode !== null && Number(p.episode) === Number(episode)) {
            if (season === null || Number(p.season) === Number(season)) return p;
          }
        }
      }

      // 2. Fallback to Continue Watching array
      const list = this.getContinueWatching();
      if (episode !== null) {
        const epMatch = list.find(i => String(i.id) === mediaId && Number(i.episode) === Number(episode) && (season === null || Number(i.season) === Number(season)));
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
      const isSeries = isTv || isSaturn || item.media_type === 'anime';
      
      const finalDuration = (duration && duration > 0) ? Math.floor(duration) : (isSeries ? 2700 : 7200);
      const finalCurrentTime = Math.max(0, Math.floor(currentTime || 0));
      const progressPercent = Math.min(100, Math.round((finalCurrentTime / finalDuration) * 100));
      const remainingSeconds = Math.max(0, finalDuration - finalCurrentTime);
      const isNearEnd = (progressPercent >= 95) || (finalDuration > 300 && remainingSeconds <= 180);

      const season = isSeries ? (Number(item.season) || 1) : undefined;
      const episode = isSeries ? (Number(item.episode) || 1) : undefined;

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
        updatedAt: Date.now(),
        timestamp: Date.now()
      };

      // Always persist exact playback time in positions dictionary (both overall show & episode-specific)
      try {
        const positionsKey = this.getUserKey(this.KEYS.PLAYBACK_POSITIONS);
        const positions = JSON.parse(localStorage.getItem(positionsKey) || '{}');
        positions[mediaId] = record;
        if (isSeries && episode) {
          const s = season || 1;
          positions[`${mediaId}_s${s}_e${episode}`] = record;
          positions[`${mediaId}_e${episode}`] = record;
        }
        localStorage.setItem(positionsKey, JSON.stringify(positions));
      } catch (err) {}

      // Update Continue Watching Carousel list (filter out duplicates)
      const list = this.getContinueWatching().filter(i => String(i.id) !== mediaId);

      if (!isSeries) {
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
            season: isSeries ? (Number(nextEp.season) || 1) : undefined,
            episode: isSeries ? (Number(nextEp.episode) || 1) : undefined,
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
          // Normal TV / Anime progress update (even near end, keeps series in list until next episode advances)
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
      const list = data ? JSON.parse(data) : [];
      if (Array.isArray(list)) {
        return list.map(item => {
          if (!item) return item;
          const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
          if (isSaturn) {
            const cleanSlug = item.slug || String(item.id).replace(/^saturn_/, '');
            item.slug = cleanSlug;
            if (item.isDub === undefined || item.isDub === null || item.isDub === false) {
              const detectedDub = (typeof AnimeSaturnService !== 'undefined' && typeof AnimeSaturnService.isDubAnime === 'function')
                ? AnimeSaturnService.isDubAnime(item.title || item.name, cleanSlug)
                : (cleanSlug.includes('-ita-') || String(item.title || '').includes('(ITA)'));
              if (detectedDub) {
                item.isDub = true;
              }
            }
          }
          return item;
        });
      }
      return [];
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
        const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
        const cleanSlug = item.slug || (isSaturn ? String(item.id).replace(/^saturn_/, '') : '');
        const isDub = isSaturn ? (
          item.isDub === true ||
          (typeof AnimeSaturnService !== 'undefined' && typeof AnimeSaturnService.isDubAnime === 'function' && AnimeSaturnService.isDubAnime(item.title || item.name, cleanSlug))
        ) : false;

        const watchlistItem = {
          id: item.id,
          source: item.source || (isSaturn ? 'animesaturn' : 'tmdb'),
          slug: cleanSlug,
          isDub: isDub,
          media_type: item.media_type || (isSaturn ? 'anime' : (item.name && !item.title ? 'tv' : 'movie')),
          title: item.title || item.name,
          poster_path: item.poster_path,
          backdrop_path: item.backdrop_path,
          vote_average: item.vote_average,
          release_date: item.release_date || item.first_air_date
        };
        list.unshift(watchlistItem);
        added = true;
        if (window.SupabaseService) {
          SupabaseService.syncWatchlistAdd(watchlistItem).catch(() => {});
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

      if (window.SupabaseService) {
        if (typeof SupabaseService.setMediaCommunityHidden === 'function') {
          SupabaseService.setMediaCommunityHidden(mediaId, isHidden).catch(() => {});
        }
        if (typeof SupabaseService.setWatchlistCommunityHidden === 'function') {
          SupabaseService.setWatchlistCommunityHidden(mediaId, isHidden).catch(() => {});
        }
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

      // Sync dropped state to cloud in background
      if (window.SupabaseService && typeof SupabaseService.setMediaDropped === 'function') {
        SupabaseService.setMediaDropped(mediaId, isDropped).catch(() => {});
      }

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

  // Set Media Completed ("Segna come finito")
  setMediaCompleted(id, isCompleted = true, mediaData = {}) {
    try {
      if (!id) return;
      const mediaId = String(id);
      const isSaturn = (mediaData.source === 'animesaturn' || mediaId.startsWith('saturn_'));
      const isTv = !isSaturn && (mediaData.media_type === 'tv' || (mediaData.media_type !== 'movie' && (mediaData.number_of_seasons !== undefined || (!!mediaData.name && !mediaData.title))));
      const isSeries = isTv || isSaturn || mediaData.media_type === 'anime';

      const duration = (mediaData.duration && mediaData.duration > 0) ? mediaData.duration : (isSeries ? 2700 : 7200);

      // 1. Remove from continue watching
      const contList = this.getContinueWatching().filter(i => String(i.id) !== mediaId);
      localStorage.setItem(this.getUserKey(this.KEYS.CONTINUE_WATCHING), JSON.stringify(contList));

      // 2. Update positions cache with completed flag
      try {
        const positionsKey = this.getUserKey(this.KEYS.PLAYBACK_POSITIONS);
        const positions = JSON.parse(localStorage.getItem(positionsKey) || '{}');
        positions[mediaId] = {
          id: mediaId,
          ...mediaData,
          progress: 100,
          currentTime: duration,
          duration: duration,
          isCompleted: true,
          isLastEpisode: true,
          updatedAt: Date.now()
        };
        localStorage.setItem(positionsKey, JSON.stringify(positions));
      } catch (e) {}

      // 3. Unmark from dropped
      this.setMediaDropped(mediaId, false);

      // 4. Sync to Supabase Cloud
      if (window.SupabaseService && typeof SupabaseService.setMediaCompleted === 'function') {
        SupabaseService.setMediaCompleted(mediaId, isCompleted, mediaData).catch(() => {});
      }
    } catch (e) {
      console.error('Storage setMediaCompleted error:', e);
    }
  },

  // Reset Watch Progress ("Segna come Da guardare" / Azzera progressi)
  resetMediaProgress(id) {
    try {
      if (!id) return;
      const mediaId = String(id);

      // 1. Remove from continue watching
      const contList = this.getContinueWatching().filter(i => String(i.id) !== mediaId);
      localStorage.setItem(this.getUserKey(this.KEYS.CONTINUE_WATCHING), JSON.stringify(contList));

      // 2. Clear all positions for this media from cache
      try {
        const positionsKey = this.getUserKey(this.KEYS.PLAYBACK_POSITIONS);
        const positions = JSON.parse(localStorage.getItem(positionsKey) || '{}');
        delete positions[mediaId];
        Object.keys(positions).forEach(k => {
          if (k.startsWith(`${mediaId}_`)) delete positions[k];
        });
        localStorage.setItem(positionsKey, JSON.stringify(positions));
      } catch (e) {}

      // 3. Unset dropped
      this.setMediaDropped(mediaId, false);

      // 4. Reset in Supabase Cloud
      if (window.SupabaseService && typeof SupabaseService.resetMediaProgress === 'function') {
        SupabaseService.resetMediaProgress(mediaId).catch(() => {});
      }
    } catch (e) {
      console.error('Storage resetMediaProgress error:', e);
    }
  },

  // Sync cloud data into local storage on login / startup
  async syncFromCloud() {
    if (!window.SupabaseService) return;
    const user = SupabaseService.getActiveUser();
    if (!user || !user.id) return;

    try {
      const [allProgressRows, cloudContinue, cloudWatchlist] = await Promise.all([
        SupabaseService.getAllUserWatchProgress(user.id).catch(() => []),
        SupabaseService.getCloudContinueWatching().catch(() => []),
        SupabaseService.getCloudWatchlist(user.id).catch(() => [])
      ]);

      // 1. Process all watch progress rows from cloud (Source of Truth)
      const cloudDropped = new Set();
      const cloudCommunityHidden = new Set();
      const cloudCompleted = new Set();
      const cloudHiddenOrReset = new Set();

      const positionsKey = this.getUserKey(this.KEYS.PLAYBACK_POSITIONS);
      let positions = {};
      try {
        positions = JSON.parse(localStorage.getItem(positionsKey) || '{}');
      } catch (e) {
        positions = {};
      }

      if (Array.isArray(allProgressRows)) {
        for (const r of allProgressRows) {
          const mId = String(r.media_id);
          const isSaturn = (r.source === 'animesaturn' || mId.startsWith('saturn_'));
          const isTv = !isSaturn && (r.media_type === 'tv' || (r.media_type !== 'movie' && Number(r.season) > 0));
          const isSeries = isTv || isSaturn || r.media_type === 'anime';
          const prog = Number(r.progress || 0);
          const isComp = r.is_completed === true || (!isSeries && prog >= 95) || (isSeries && r.is_last_episode === true && prog >= 95);

          if (r.is_dropped === true) cloudDropped.add(mId);
          if (r.community_hidden === true) cloudCommunityHidden.add(mId);
          if (isComp) cloudCompleted.add(mId);
          if (r.is_hidden === true || prog === 0) cloudHiddenOrReset.add(mId);

          // Update local positions cache with authoritative cloud data
          const posRecord = {
            id: mId,
            source: r.source || (isSaturn ? 'animesaturn' : 'tmdb'),
            media_type: r.media_type || (isSaturn ? 'anime' : (isTv ? 'tv' : 'movie')),
            title: r.title,
            name: isTv ? r.title : undefined,
            poster_path: r.poster_path,
            backdrop_path: r.backdrop_path,
            season: isSeries && Number(r.season) > 0 ? Number(r.season) : undefined,
            episode: isSeries && Number(r.episode) > 0 ? Number(r.episode) : undefined,
            episode_name: r.episode_name,
            currentTime: Number(r.playback_time || 0),
            duration: Number(r.duration || (isSeries ? 2700 : 7200)),
            progress: prog,
            isCompleted: isComp,
            isLastEpisode: !!r.is_last_episode,
            isDropped: !!r.is_dropped,
            updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : Date.now()
          };

          // If reset to 0 and hidden, remove from positions cache so it's truly clean
          if (prog === 0 && r.is_hidden && !isComp) {
            delete positions[mId];
            if (r.season && r.episode) {
              delete positions[`${mId}_s${r.season}_e${r.episode}`];
            }
          } else {
            positions[mId] = posRecord;
            if (r.season && r.episode) {
              positions[`${mId}_s${r.season}_e${r.episode}`] = posRecord;
            }
          }
        }
      }

      // Save updated positions
      try {
        localStorage.setItem(positionsKey, JSON.stringify(positions));
      } catch (e) {}

      // Sync dropped and hidden lists to local storage
      if (cloudDropped.size > 0) {
        localStorage.setItem(this.getUserKey(this.KEYS.DROPPED), JSON.stringify(Array.from(cloudDropped)));
      }
      if (cloudCommunityHidden.size > 0) {
        localStorage.setItem(this.getUserKey(this.KEYS.COMMUNITY_HIDDEN), JSON.stringify(Array.from(cloudCommunityHidden)));
      }

      // 2. Sync Continue Watching: Cloud is authoritative
      if (Array.isArray(cloudContinue)) {
        const finalContinueMap = new Map();
        for (const item of cloudContinue) {
          if (!item || !item.id) continue;
          const mId = String(item.id);
          // Safety: skip if completed, dropped, or hidden
          if (cloudCompleted.has(mId) || cloudDropped.has(mId) || cloudHiddenOrReset.has(mId)) continue;
          finalContinueMap.set(mId, item);
        }

        // Check existing local items: only preserve if strictly newer than cloud AND not marked completed/dropped/hidden in cloud
        let existingLocal = [];
        try {
          const raw = localStorage.getItem(this.getUserKey(this.KEYS.CONTINUE_WATCHING));
          if (raw) existingLocal = JSON.parse(raw);
          if (!Array.isArray(existingLocal)) existingLocal = [];
        } catch (e) {
          existingLocal = [];
        }

        for (const localItem of existingLocal) {
          if (!localItem || !localItem.id) continue;
          const mId = String(localItem.id);
          // If completed, dropped, or hidden in cloud -> NEVER resurrect!
          if (cloudCompleted.has(mId) || cloudDropped.has(mId) || cloudHiddenOrReset.has(mId)) continue;

          const cloudItem = finalContinueMap.get(mId);
          if (cloudItem) {
            const localTime = Number(localItem.updatedAt || localItem.timestamp || 0);
            const cloudTime = Number(cloudItem.updatedAt || cloudItem.timestamp || 0);
            if (localTime > cloudTime) {
              finalContinueMap.set(mId, { ...cloudItem, ...localItem });
            }
          }
        }

        const sortedList = Array.from(finalContinueMap.values());
        sortedList.sort((a, b) => {
          const timeA = Number(a.updatedAt || a.timestamp || 0);
          const timeB = Number(b.updatedAt || b.timestamp || 0);
          return timeB - timeA;
        });

        localStorage.setItem(this.getUserKey(this.KEYS.CONTINUE_WATCHING), JSON.stringify(sortedList.slice(0, 30)));
      }

      // 3. Sync Watchlist
      if (Array.isArray(cloudWatchlist)) {
        const hydratedWatchlist = cloudWatchlist.map(item => {
          if (!item) return item;
          const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
          if (isSaturn) {
            const cleanSlug = item.slug || String(item.id).replace(/^saturn_/, '');
            const isDub = item.isDub === true || (
              typeof AnimeSaturnService !== 'undefined' && typeof AnimeSaturnService.isDubAnime === 'function'
                ? AnimeSaturnService.isDubAnime(item.title || item.name, cleanSlug)
                : (cleanSlug.includes('-ita-') || String(item.title || '').includes('(ITA)'))
            );
            return { ...item, isDub, slug: cleanSlug };
          }
          return item;
        });
        localStorage.setItem(this.getUserKey(this.KEYS.WATCHLIST), JSON.stringify(hydratedWatchlist));
      }
    } catch (e) {
      console.warn('[StorageService] Cloud sync error:', e);
    }
  },

  // Anime DUB status updater
  updateAnimeDubStatus(mediaId, isDub) {
    try {
      if (!mediaId) return;
      const mId = String(mediaId);
      let wl = this.getWatchlist();
      let wlChanged = false;
      wl = wl.map(i => {
        if (String(i.id) === mId && i.isDub !== isDub) {
          i.isDub = isDub;
          wlChanged = true;
        }
        return i;
      });
      if (wlChanged) {
        localStorage.setItem(this.getUserKey(this.KEYS.WATCHLIST), JSON.stringify(wl));
        if (window.SupabaseService && typeof SupabaseService.syncWatchlistDubStatus === 'function') {
          SupabaseService.syncWatchlistDubStatus(mId, isDub).catch(() => {});
        }
      }

      let cw = this.getContinueWatching();
      let cwChanged = false;
      cw = cw.map(i => {
        if (String(i.id) === mId && i.isDub !== isDub) {
          i.isDub = isDub;
          cwChanged = true;
        }
        return i;
      });
      if (cwChanged) {
        localStorage.setItem(this.getUserKey(this.KEYS.CONTINUE_WATCHING), JSON.stringify(cw));
      }
    } catch (e) {
      console.warn('[StorageService] updateAnimeDubStatus error:', e);
    }
  }
};

window.StorageService = StorageService;
