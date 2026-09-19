/**
 * Roxy - Supabase Service
 * Multi-user profiles (Name + PIN + Emoji), cloud watch progress & watchlist sync,
 * and viewing metrics.
 */
const SupabaseService = {
  activeUser: null,
  maxUsersLimit: 30,

  // Helper for direct Supabase REST API requests
  async restRequest(endpoint, options = {}) {
    const url = `${CONFIG.SUPABASE.URL}/rest/v1/${endpoint}`;
    const headers = {
      'apikey': CONFIG.SUPABASE.ANON_KEY,
      'Authorization': `Bearer ${CONFIG.SUPABASE.ANON_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    const isKeepalive = !!options.keepalive;
    let signal = undefined;
    let timeoutId = undefined;

    if (!isKeepalive && typeof AbortController !== 'undefined') {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 6000);
      signal = controller.signal;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal
      });
      if (timeoutId) clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Supabase API ${response.status}: ${errText}`);
      }

      if (response.status === 204) return null;
      const text = await response.text();
      if (!text || text.trim() === '') return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        return text;
      }
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      console.warn(`[SupabaseService] Request error on ${endpoint}:`, err.message);
      throw err;
    }
  },

  // SHA-256 PIN hashing
  async hashPin(pin) {
    const cleanPin = String(pin || '').trim();
    if (window.crypto && window.crypto.subtle) {
      const msgBuffer = new TextEncoder().encode(`roxy_salt_${cleanPin}`);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // Simple fast fallback hash
    let hash = 0;
    const str = `roxy_salt_${cleanPin}`;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return `fb_${Math.abs(hash)}`;
  },

  // Client-side image compressor: square center-crop, resize to 256x256, output WebP (or JPEG) Blob
  async compressImage(file, targetSize = 256, quality = 0.82) {
    if (!file || !(file instanceof Blob)) {
      throw new Error('File non valido.');
    }

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Errore nella lettura del file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Formato immagine non supportato o file corrotto.'));
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = targetSize;
            canvas.height = targetSize;
            const ctx = canvas.getContext('2d');

            // Center square crop calculations
            const sw = img.naturalWidth || img.width;
            const sh = img.naturalHeight || img.height;
            const size = Math.min(sw, sh);
            const sx = (sw - size) / 2;
            const sy = (sh - size) / 2;

            // Background fill (for transparent PNGs converted to WebP/JPEG)
            ctx.fillStyle = '#1e1e2d';
            ctx.fillRect(0, 0, targetSize, targetSize);

            // Draw center-cropped square
            ctx.drawImage(img, sx, sy, size, size, 0, 0, targetSize, targetSize);

            // Check WebP support
            const canWebp = (canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0);
            const exportMime = canWebp ? 'image/webp' : 'image/jpeg';
            const fileExt = canWebp ? 'webp' : 'jpg';

            canvas.toBlob((blob) => {
              if (blob) {
                resolve({
                  blob,
                  mimeType: exportMime,
                  fileExt,
                  dataUrl: canvas.toDataURL(exportMime, quality)
                });
              } else {
                reject(new Error('Compressione immagine fallita.'));
              }
            }, exportMime, quality);
          } catch (err) {
            reject(err);
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  },

  // Upload compressed avatar blob to Supabase Storage 'avatars' bucket
  async uploadAvatar(blob, fileExt = 'webp', userId = null) {
    if (!blob) throw new Error('Dati immagine mancanti.');
    const safeId = userId || (this.activeUser ? this.activeUser.id : `guest_${Date.now()}`);
    const filePath = `avatar_${safeId}_${Date.now()}.${fileExt}`;
    const url = `${CONFIG.SUPABASE.URL}/storage/v1/object/avatars/${filePath}`;

    const headers = {
      'apikey': CONFIG.SUPABASE.ANON_KEY,
      'Authorization': `Bearer ${CONFIG.SUPABASE.ANON_KEY}`,
      'Content-Type': blob.type || 'image/webp',
      'x-upsert': 'true'
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: blob
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Errore caricamento storage (${response.status}): ${errText}`);
    }

    const publicUrl = `${CONFIG.SUPABASE.URL}/storage/v1/object/public/avatars/${filePath}`;
    console.log('[SupabaseService] Avatar uploaded successfully:', publicUrl);
    return publicUrl;
  },

  // =========================================================================
  // Profiles & Authentication
  // =========================================================================
  async getProfiles() {
    try {
      const profiles = await this.restRequest('profiles?select=id,username,avatar_emoji,avatar_url,bio,created_at,last_active_at&order=last_active_at.desc');
      return Array.isArray(profiles) ? profiles : [];
    } catch (e) {
      console.warn('[SupabaseService] Failed to load profiles from cloud:', e);
      return [];
    }
  },

  async createProfile(username, pin, avatarEmoji = '🍿', avatarUrl = null) {
    const cleanUser = String(username || '').trim();
    const cleanPin = String(pin || '').trim();

    if (!cleanUser || cleanUser.length < 2) {
      throw new Error('Il nome profilo deve contenere almeno 2 caratteri.');
    }
    if (!/^\d{4}$/.test(cleanPin)) {
      throw new Error('Il PIN deve essere composto esattamente da 4 cifre numeriche.');
    }

    const existing = await this.getProfiles();
    if (existing.length >= this.maxUsersLimit) {
      throw new Error(`Limite massimo di profili raggiunto (${this.maxUsersLimit}).`);
    }

    const nameExists = existing.some(p => p.username.toLowerCase() === cleanUser.toLowerCase());
    if (nameExists) {
      throw new Error('Un profilo con questo nome esiste già.');
    }

    const pinHash = await this.hashPin(cleanPin);

    const payload = {
      username: cleanUser,
      pin_hash: pinHash,
      avatar_emoji: avatarEmoji || '🍿',
      avatar_url: avatarUrl || null,
      bio: '',
      last_active_at: new Date().toISOString()
    };

    const inserted = await this.restRequest('profiles', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(payload)
    });

    if (Array.isArray(inserted) && inserted.length > 0) {
      return inserted[0];
    }
    throw new Error('Errore durante la creazione del profilo su Supabase.');
  },

  async login(profileId, enteredPin) {
    const cleanPin = String(enteredPin || '').trim();
    if (!/^\d{4}$/.test(cleanPin)) {
      throw new Error('Inserisci un PIN numerico di 4 cifre.');
    }

    const pinHash = await this.hashPin(cleanPin);
    const results = await this.restRequest(`profiles?id=eq.${profileId}&select=id,username,pin_hash,avatar_emoji,avatar_url,bio`);

    if (!results || results.length === 0) {
      throw new Error('Profilo non trovato.');
    }

    const profile = results[0];
    if (profile.pin_hash !== pinHash) {
      throw new Error('PIN errato. Riprova.');
    }

    // Update last_active_at in background
    this.restRequest(`profiles?id=eq.${profileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_active_at: new Date().toISOString() })
    }).catch(() => {});

    this.setActiveUser(profile);
    this.logMetric('login_success', null, { username: profile.username });
    return profile;
  },

  async updateProfile(profileId, updates = {}) {
    const payload = {};
    if (updates.username) payload.username = String(updates.username).trim();
    if (updates.avatar_emoji !== undefined) payload.avatar_emoji = updates.avatar_emoji;
    if (updates.avatar_url !== undefined) payload.avatar_url = updates.avatar_url;
    if (updates.bio !== undefined) payload.bio = String(updates.bio).trim();
    if (updates.pin) {
      if (!/^\d{4}$/.test(String(updates.pin).trim())) {
        throw new Error('Il PIN deve essere di 4 cifre.');
      }
      payload.pin_hash = await this.hashPin(String(updates.pin).trim());
    }

    const updated = await this.restRequest(`profiles?id=eq.${profileId}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(payload)
    });

    const user = updated && updated[0] ? updated[0] : null;
    if (user && this.activeUser && this.activeUser.id === profileId) {
      this.setActiveUser({
        ...this.activeUser,
        username: user.username,
        avatar_emoji: user.avatar_emoji,
        avatar_url: user.avatar_url,
        bio: user.bio
      });
    }
    return user;
  },

  async deleteProfile(profileId) {
    await this.restRequest(`profiles?id=eq.${profileId}`, {
      method: 'DELETE'
    });

    if (this.activeUser && this.activeUser.id === profileId) {
      this.logout();
    }
    // Clean local storage cache for that user
    try {
      localStorage.removeItem(`roxy_continue_watching_${profileId}`);
      localStorage.removeItem(`roxy_watchlist_${profileId}`);
    } catch (e) {}
    return true;
  },

  getActiveUser() {
    if (this.activeUser) return this.activeUser;
    try {
      const saved = localStorage.getItem('roxy_active_user');
      if (saved) {
        this.activeUser = JSON.parse(saved);
        return this.activeUser;
      }
    } catch (e) {}
    return null;
  },

  setActiveUser(user) {
    this.activeUser = user;
    try {
      if (user) {
        localStorage.setItem('roxy_active_user', JSON.stringify({
          id: user.id,
          username: user.username,
          avatar_emoji: user.avatar_emoji,
          avatar_url: user.avatar_url || null
        }));
      } else {
        localStorage.removeItem('roxy_active_user');
      }
    } catch (e) {}
  },

  logout() {
    this.setActiveUser(null);
  },

  // =========================================================================
  // Cloud Watch Progress Sync & Social Presence
  // =========================================================================
  async syncWatchProgress(item, currentTime, duration) {
    const user = this.getActiveUser();
    if (!user || !user.id || !item || !item.id) return;

    const mediaId = String(item.id);
    const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
    const isTv = !isSaturn && (item.media_type === 'tv' || (item.media_type !== 'movie' && (item.number_of_seasons !== undefined || (!!item.name && !item.title))));
    const isSeries = isTv || isSaturn || item.media_type === 'anime';
    
    // Movies strictly use season 0, episode 0 to avoid duplicate rows
    const season = isSeries ? (Number(item.season) || 1) : 0;
    const episode = isSeries ? (Number(item.episode) || 1) : 0;
    
    const validDuration = (duration && duration > 0) ? Math.floor(duration) : (isSeries ? 2700 : 7200);
    const validCurrentTime = Math.max(0, Math.floor(currentTime || 0));
    const progress = Math.min(100, Math.max(0, (validCurrentTime / validDuration) * 100));

    const isCompleted = (!isSeries && progress >= 95) || (isSeries && !!item.isLastEpisode && progress >= 95) || !!item.isCompleted;

    const payload = {
      user_id: user.id,
      media_id: mediaId,
      source: item.source || (isSaturn ? 'animesaturn' : 'tmdb'),
      media_type: item.media_type || (isSaturn ? 'anime' : (isTv ? 'tv' : 'movie')),
      title: item.title || item.name || 'Streaming',
      poster_path: item.poster_path || '',
      backdrop_path: item.backdrop_path || '',
      season: season,
      episode: episode,
      episode_name: item.episode_name || '',
      playback_time: validCurrentTime,
      duration: validDuration,
      progress: Math.round(progress * 10) / 10,
      is_dub: !!item.isDub,
      is_hidden: isCompleted,
      is_completed: isCompleted,
      is_last_episode: !!item.isLastEpisode,
      is_dropped: typeof StorageService !== 'undefined' && typeof StorageService.isDropped === 'function' ? StorageService.isDropped(mediaId) : false,
      community_hidden: typeof StorageService !== 'undefined' && typeof StorageService.isCommunityHidden === 'function' ? StorageService.isCommunityHidden(mediaId) : false,
      slug: item.slug || '',
      updated_at: new Date().toISOString()
    };

    try {
      await this.restRequest('watch_progress?on_conflict=user_id,media_id,season,episode', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(payload),
        keepalive: true
      });

      // For TV Series and Anime: when user watches episode (S, E), hide all other episodes of the same show
      if (isSeries && (season > 0 || episode > 0)) {
        this.restRequest(`watch_progress?user_id=eq.${user.id}&media_id=eq.${encodeURIComponent(String(mediaId))}&or=(season.neq.${season},episode.neq.${episode})`, {
          method: 'PATCH',
          body: JSON.stringify({ is_hidden: true })
        }).catch(() => {});
      }
    } catch (e) {
      console.warn('[SupabaseService] Cloud progress sync notice:', e.message);
    }
  },

  async setMediaDropped(mediaId, isDropped, mediaData = null) {
    const user = this.getActiveUser();
    if (!user || !user.id || !mediaId) return;

    try {
      const res = await this.restRequest(`watch_progress?user_id=eq.${user.id}&media_id=eq.${encodeURIComponent(String(mediaId))}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({
          is_dropped: !!isDropped,
          is_hidden: !!isDropped, // Dropped items hidden from continue watching
          updated_at: new Date().toISOString()
        })
      });

      // If no existing row was updated and mediaData is provided, insert a watch_progress record
      if ((!res || res.length === 0) && mediaData) {
        const isSaturn = (mediaData.source === 'animesaturn' || String(mediaId).startsWith('saturn_'));
        const isTv = !isSaturn && (mediaData.media_type === 'tv' || (mediaData.media_type !== 'movie' && (mediaData.number_of_seasons !== undefined || (!!mediaData.name && !mediaData.title))));
        await this.restRequest('watch_progress?on_conflict=user_id,media_id,season,episode', {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({
            user_id: user.id,
            media_id: String(mediaId),
            source: mediaData.source || (isSaturn ? 'animesaturn' : 'tmdb'),
            media_type: mediaData.media_type || (isSaturn ? 'anime' : (isTv ? 'tv' : 'movie')),
            title: mediaData.title || mediaData.name || 'Streaming',
            poster_path: mediaData.poster_path || '',
            backdrop_path: mediaData.backdrop_path || '',
            season: isTv ? (Number(mediaData.season) || 1) : 0,
            episode: isTv ? (Number(mediaData.episode) || 1) : 0,
            playback_time: 1,
            duration: 100,
            progress: 1,
            is_hidden: true,
            is_dropped: !!isDropped,
            community_hidden: typeof StorageService !== 'undefined' && typeof StorageService.isCommunityHidden === 'function' ? StorageService.isCommunityHidden(mediaId) : false,
            slug: mediaData.slug || '',
            updated_at: new Date().toISOString()
          })
        });
      }

      // Refresh memory cache
      await this.loadGlobalSocialActivity();
    } catch (e) {
      console.warn('[SupabaseService] Failed to set dropped status:', e);
    }
  },

  async setMediaCompleted(mediaId, isCompleted = true, mediaData = null) {
    const user = this.getActiveUser();
    if (!user || !user.id || !mediaId) return;

    try {
      const res = await this.restRequest(`watch_progress?user_id=eq.${user.id}&media_id=eq.${encodeURIComponent(String(mediaId))}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({
          progress: isCompleted ? 100 : 0,
          is_hidden: !!isCompleted,
          is_dropped: false,
          is_completed: !!isCompleted,
          is_last_episode: !!isCompleted,
          updated_at: new Date().toISOString()
        })
      });

      if ((!res || res.length === 0) && mediaData) {
        const isSaturn = (mediaData.source === 'animesaturn' || String(mediaId).startsWith('saturn_'));
        const isTv = !isSaturn && (mediaData.media_type === 'tv' || (mediaData.media_type !== 'movie' && (mediaData.number_of_seasons !== undefined || (!!mediaData.name && !mediaData.title))));
        const isSeries = isTv || isSaturn || mediaData.media_type === 'anime';

        await this.restRequest('watch_progress?on_conflict=user_id,media_id,season,episode', {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({
            user_id: user.id,
            media_id: String(mediaId),
            source: mediaData.source || (isSaturn ? 'animesaturn' : 'tmdb'),
            media_type: mediaData.media_type || (isSaturn ? 'anime' : (isTv ? 'tv' : 'movie')),
            title: mediaData.title || mediaData.name || 'Streaming',
            poster_path: mediaData.poster_path || '',
            backdrop_path: mediaData.backdrop_path || '',
            season: isSeries ? (Number(mediaData.season) || 1) : 0,
            episode: isSeries ? (Number(mediaData.episode) || 1) : 0,
            playback_time: isSeries ? 2700 : 7200,
            duration: isSeries ? 2700 : 7200,
            progress: 100,
            is_hidden: true,
            is_completed: true,
            is_last_episode: true,
            is_dropped: false,
            community_hidden: typeof StorageService !== 'undefined' && typeof StorageService.isCommunityHidden === 'function' ? StorageService.isCommunityHidden(mediaId) : false,
            slug: mediaData.slug || '',
            updated_at: new Date().toISOString()
          })
        });
      }

      await this.loadGlobalSocialActivity();
    } catch (e) {
      console.warn('[SupabaseService] Failed to set completed status:', e);
    }
  },

  async resetMediaProgress(mediaId) {
    const user = this.getActiveUser();
    if (!user || !user.id || !mediaId) return;

    try {
      await this.restRequest(`watch_progress?user_id=eq.${user.id}&media_id=eq.${encodeURIComponent(String(mediaId))}`, {
        method: 'DELETE'
      });
      await this.loadGlobalSocialActivity();
    } catch (e) {
      console.warn('[SupabaseService] Failed to reset media progress:', e);
    }
  },

  async isMediaDropped(mediaId) {
    const user = this.getActiveUser();
    if (!user || !user.id || !mediaId) return false;

    try {
      const rows = await this.restRequest(`watch_progress?user_id=eq.${user.id}&media_id=eq.${encodeURIComponent(String(mediaId))}&select=is_dropped&limit=1`);
      if (Array.isArray(rows) && rows.length > 0) {
        return !!rows[0].is_dropped;
      }
      return false;
    } catch (e) {
      return false;
    }
  },

  async setMediaCommunityHidden(mediaId, isHidden) {
    const user = this.getActiveUser();
    if (!user || !user.id || !mediaId) return;

    try {
      await this.restRequest(`watch_progress?user_id=eq.${user.id}&media_id=eq.${encodeURIComponent(String(mediaId))}`, {
        method: 'PATCH',
        body: JSON.stringify({
          community_hidden: !!isHidden,
          updated_at: new Date().toISOString()
        })
      });
    } catch (e) {
      console.warn('[SupabaseService] Failed to set community hidden status:', e);
    }
  },

  async isMediaCommunityHidden(mediaId) {
    const user = this.getActiveUser();
    if (!user || !user.id || !mediaId) return false;

    try {
      const rows = await this.restRequest(`watch_progress?user_id=eq.${user.id}&media_id=eq.${encodeURIComponent(String(mediaId))}&select=community_hidden&limit=1`);
      if (Array.isArray(rows) && rows.length > 0) {
        return !!rows[0].community_hidden;
      }
      return false;
    } catch (e) {
      return false;
    }
  },

  async hideWatchProgress(mediaId) {
    const user = this.getActiveUser();
    if (!user || !user.id || !mediaId) return;

    try {
      await this.restRequest(`watch_progress?user_id=eq.${user.id}&media_id=eq.${encodeURIComponent(String(mediaId))}`, {
        method: 'PATCH',
        body: JSON.stringify({
          is_hidden: true,
          updated_at: new Date().toISOString()
        })
      });
      this.logMetric('remove_continue_watching', mediaId);
    } catch (e) {
      console.warn('[SupabaseService] Failed to hide watch progress:', e);
    }
  },

  async getCloudContinueWatching() {
    const user = this.getActiveUser();
    if (!user || !user.id) return [];

    try {
      // Order by updated_at desc: most recently watched episode of any show comes first
      const rows = await this.restRequest(`watch_progress?user_id=eq.${user.id}&is_hidden=eq.false&order=updated_at.desc&limit=40`);
      if (!Array.isArray(rows)) return [];

      const seen = new Set();
      const uniqueList = [];

      for (const r of rows) {
        const key = String(r.media_id);
        if (r.is_dropped === true) {
          if (typeof StorageService !== 'undefined' && typeof StorageService.setMediaDropped === 'function') {
            StorageService.setMediaDropped(r.media_id, true);
          }
          continue;
        }
        if (r.community_hidden === true && typeof StorageService !== 'undefined' && typeof StorageService.setCommunityHidden === 'function') {
          StorageService.setCommunityHidden(r.media_id, true);
        }

        const isSaturn = (r.source === 'animesaturn' || String(r.media_id).startsWith('saturn_'));
        const isTv = !isSaturn && (r.media_type === 'tv' || (r.media_type !== 'movie' && Number(r.season) > 0));
        const isSeries = isTv || isSaturn || r.media_type === 'anime';
        const prog = Number(r.progress || 0);

        // Movies: skip if completed
        if (!isSeries && (prog >= 95 || r.is_completed)) {
          continue;
        }

        // TV / Anime: skip only if entire series is completed
        if (r.is_completed === true || (isSeries && r.is_last_episode === true && prog >= 95)) {
          continue;
        }

        if (seen.has(key)) continue;
        seen.add(key);

        uniqueList.push({
          id: r.media_id,
          source: r.source,
          media_type: r.media_type || (isSaturn ? 'anime' : (isTv ? 'tv' : 'movie')),
          title: r.title,
          name: isTv ? r.title : undefined,
          poster_path: r.poster_path,
          backdrop_path: r.backdrop_path,
          season: isSeries && r.season > 0 ? r.season : (isSeries ? 1 : undefined),
          episode: isSeries && r.episode > 0 ? r.episode : (isSeries ? 1 : undefined),
          episode_name: r.episode_name,
          currentTime: Number(r.playback_time),
          duration: Number(r.duration),
          progress: prog,
          isDub: r.is_dub,
          slug: r.slug,
          timestamp: new Date(r.updated_at).getTime(),
          updatedAt: new Date(r.updated_at).getTime()
        });
      }

      uniqueList.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return uniqueList;
    } catch (e) {
      console.warn('[SupabaseService] Failed to load cloud continue watching:', e);
      return [];
    }
  },

  // =========================================================================
  // Cloud Watchlist Sync
  // =========================================================================
  async syncWatchlistAdd(item) {
    const user = this.getActiveUser();
    if (!user || !user.id || !item || !item.id) return;

    try {
      await this.restRequest('watchlist?on_conflict=user_id,media_id', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          user_id: user.id,
          media_id: String(item.id),
          source: item.source || 'tmdb',
          media_type: item.media_type || (item.name ? 'tv' : 'movie'),
          title: item.title || item.name || '',
          poster_path: item.poster_path || '',
          overview: item.overview || '',
          vote_average: item.vote_average || 0,
          added_at: new Date().toISOString()
        })
      });
      this.logMetric('watchlist_add', item.id, { title: item.title || item.name });
    } catch (e) {
      console.warn('[SupabaseService] Watchlist add sync error:', e);
    }
  },

  async syncWatchlistRemove(itemId) {
    const user = this.getActiveUser();
    if (!user || !user.id || !itemId) return;

    try {
      await this.restRequest(`watchlist?user_id=eq.${user.id}&media_id=eq.${encodeURIComponent(String(itemId))}`, {
        method: 'DELETE'
      });
      this.logMetric('watchlist_remove', itemId);
    } catch (e) {
      console.warn('[SupabaseService] Watchlist remove sync error:', e);
    }
  },

  async getCloudWatchlist() {
    const user = this.getActiveUser();
    if (!user || !user.id) return [];

    try {
      const rows = await this.restRequest(`watchlist?user_id=eq.${user.id}&order=added_at.desc`);
      if (!Array.isArray(rows)) return [];
      return rows.map(r => ({
        id: r.media_id,
        source: r.source,
        media_type: r.media_type,
        title: r.title,
        name: r.title,
        poster_path: r.poster_path,
        overview: r.overview,
        vote_average: Number(r.vote_average || 0),
        added_at: r.added_at
      }));
    } catch (e) {
      console.warn('[SupabaseService] Failed to load cloud watchlist:', e);
      return [];
    }
  },

  // =========================================================================
  // Metrics Logging
  // =========================================================================
  async logMetric(eventType, mediaId = null, metadata = {}) {
    const user = this.getActiveUser();
    const isWebOS = (window.webOS !== undefined || navigator.userAgent.includes('Web0S') || navigator.userAgent.includes('SmartTV'));
    const deviceType = isWebOS ? 'webOS Smart TV' : 'Web Browser';

    try {
      await this.restRequest('watch_metrics', {
        method: 'POST',
        body: JSON.stringify({
          user_id: user ? user.id : null,
          media_id: mediaId ? String(mediaId) : null,
          event_type: eventType,
          device_type: deviceType,
          metadata: {
            ...metadata,
            userAgent: navigator.userAgent.substring(0, 100),
            timestamp: new Date().toISOString()
          }
        })
      });
    } catch (e) {
      // Metric errors are silent
    }
  },

  // =========================================================================
  // Social Community & Comments System
  // =========================================================================
  async addComment(item, text) {
    const user = this.getActiveUser();
    if (!user || !user.id) throw new Error('Accedi con il tuo profilo per lasciare un commento.');
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('Il testo del commento non può essere vuoto.');

    const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
    const isTv = (item.media_type === 'tv' || (item.name && !item.title));
    const title = isSaturn ? (window.AnimeSaturnService?.cleanAnimeTitle(item.title || item.name) || item.title || item.name) : (item.title || item.name);

    const payload = {
      user_id: user.id,
      username: user.username,
      avatar_emoji: user.avatar_emoji || '🍿',
      avatar_url: user.avatar_url || null,
      media_id: String(item.id),
      media_type: item.media_type || (isSaturn ? 'anime' : (isTv ? 'tv' : 'movie')),
      source: item.source || (isSaturn ? 'animesaturn' : 'tmdb'),
      title: title || 'Streaming',
      poster_path: item.poster_path || '',
      backdrop_path: item.backdrop_path || '',
      slug: item.slug || '',
      comment_type: 'comment',
      comment_text: cleanText,
      created_at: new Date().toISOString()
    };

    const result = await this.restRequest('comments', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(payload)
    });

    this.logMetric('post_comment', item.id);
    return Array.isArray(result) ? result[0] : result;
  },

  async deleteComment(commentId) {
    const user = this.getActiveUser();
    if (!user || !user.id) {
      throw new Error('Devi aver effettuato l\'accesso per eliminare un commento.');
    }
    if (!commentId) return;

    await this.restRequest(`comments?id=eq.${encodeURIComponent(String(commentId))}&user_id=eq.${user.id}`, {
      method: 'DELETE'
    });

    this.logMetric('delete_comment', null, { comment_id: commentId });
    return true;
  },

  async toggleRecommendation(item) {
    const user = this.getActiveUser();
    if (!user || !user.id) throw new Error('Accedi con il tuo profilo per consigliare un contenuto.');

    const mediaId = String(item.id);
    // Check if user already recommended this title
    const existing = await this.restRequest(`comments?user_id=eq.${user.id}&media_id=eq.${encodeURIComponent(mediaId)}&comment_type=eq.recommendation&select=id`);

    if (Array.isArray(existing) && existing.length > 0) {
      // Remove recommendation
      await this.restRequest(`comments?id=eq.${existing[0].id}`, {
        method: 'DELETE'
      });
      return { recommended: false };
    } else {
      // Add recommendation
      const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
      const isTv = (item.media_type === 'tv' || (item.name && !item.title));
      const title = isSaturn ? (window.AnimeSaturnService?.cleanAnimeTitle(item.title || item.name) || item.title || item.name) : (item.title || item.name);

      const payload = {
        user_id: user.id,
        username: user.username,
        avatar_emoji: user.avatar_emoji || '🍿',
        avatar_url: user.avatar_url || null,
        media_id: mediaId,
        media_type: item.media_type || (isSaturn ? 'anime' : (isTv ? 'tv' : 'movie')),
        source: item.source || (isSaturn ? 'animesaturn' : 'tmdb'),
        title: title || 'Streaming',
        poster_path: item.poster_path || '',
        backdrop_path: item.backdrop_path || '',
        slug: item.slug || '',
        comment_type: 'recommendation',
        comment_text: 'Consiglia di vedere assolutamente questo contenuto!',
        created_at: new Date().toISOString()
      };

      await this.restRequest('comments', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify(payload)
      });

      this.logMetric('recommend_media', mediaId);
      return { recommended: true };
    }
  },

  async hasUserRecommended(mediaId) {
    const user = this.getActiveUser();
    if (!user || !user.id || !mediaId) return false;

    try {
      const rows = await this.restRequest(`comments?user_id=eq.${user.id}&media_id=eq.${encodeURIComponent(String(mediaId))}&comment_type=eq.recommendation&select=id&limit=1`);
      return Array.isArray(rows) && rows.length > 0;
    } catch (e) {
      return false;
    }
  },

  async getCommentsForMedia(mediaId) {
    if (!mediaId) return [];
    try {
      const rows = await this.restRequest(`comments?media_id=eq.${encodeURIComponent(String(mediaId))}&order=created_at.desc&limit=50`);
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      console.warn('[SupabaseService] Error loading comments for media:', e);
      return [];
    }
  },

  // Social Activity Cache: mediaId -> Array<{ userId, username, avatar_emoji, avatar_url, status: 'watching' | 'completed', progress, updatedAt }>
  socialActivityMap: new Map(),

  async loadGlobalSocialActivity() {
    try {
      const [rows, profiles] = await Promise.all([
        this.restRequest('watch_progress?community_hidden=eq.false&order=updated_at.desc&limit=150').catch(() => []),
        this.getProfiles().catch(() => [])
      ]);

      const profileMap = new Map();
      if (Array.isArray(profiles)) {
        profiles.forEach(p => profileMap.set(String(p.id), p));
      }

      const map = new Map();
      if (Array.isArray(rows)) {
        const seenUserMedia = new Set();
        for (const r of rows) {
          if (r.community_hidden === true) continue;
          const isSaturn = (r.source === 'animesaturn' || String(r.media_id).startsWith('saturn_'));
          const isTv = !isSaturn && (r.media_type === 'tv' || (r.media_type !== 'movie' && Number(r.season) > 0));
          const isSeries = isTv || isSaturn || r.media_type === 'anime';
          const prog = Number(r.progress || 0);

          const isCompleted = r.is_completed === true || (!isSeries && prog >= 95) || (isSeries && r.is_last_episode === true && prog >= 95);
          const isDropped = !!r.is_dropped;
          const isWatching = !isCompleted && !isDropped && !r.is_hidden;

          if (!isCompleted && !isWatching && !isDropped) continue;

          const key = `${r.user_id}_${r.media_id}`;
          if (seenUserMedia.has(key)) continue;
          seenUserMedia.add(key);

          const profile = profileMap.get(String(r.user_id));
          if (!profile) continue;

          const mId = String(r.media_id);
          if (!map.has(mId)) {
            map.set(mId, []);
          }

          let status = 'watching';
          if (isDropped) {
            status = 'dropped';
          } else if (isCompleted) {
            status = 'completed';
          }

          map.get(mId).push({
            userId: String(r.user_id),
            username: profile.username,
            avatar_emoji: profile.avatar_emoji || '🍿',
            avatar_url: profile.avatar_url || null,
            status: status,
            progress: prog,
            season: Number(r.season) || 0,
            episode: Number(r.episode) || 0,
            updatedAt: new Date(r.updated_at).getTime()
          });
        }
      }

      this.socialActivityMap = map;
      return map;
    } catch (e) {
      console.warn('[SupabaseService] Error loading social activity:', e);
      return this.socialActivityMap;
    }
  },

  getMediaSocialActivity(mediaId, includeSelf = false) {
    if (!mediaId) return [];
    const list = this.socialActivityMap.get(String(mediaId)) || [];
    const currentUserId = this.activeUser ? String(this.activeUser.id) : null;
    if (includeSelf || !currentUserId) {
      return list;
    }
    return list.filter(item => item.userId !== currentUserId);
  },

  async getCommunityFeed() {
    try {
      const [comments, watchingRows, profiles] = await Promise.all([
        // 1. Comments & recommendations
        this.restRequest('comments?order=created_at.desc&limit=35').catch(() => []),
        // 2. Watch progress from users (excluding hidden from community)
        this.restRequest('watch_progress?community_hidden=eq.false&order=updated_at.desc&limit=60').catch(() => []),
        // 3. User profiles for avatar and name mapping
        this.getProfiles().catch(() => [])
      ]);

      const profileMap = new Map();
      if (Array.isArray(profiles)) {
        profiles.forEach(p => profileMap.set(String(p.id), p));
      }

      // Also update socialActivityMap in memory
      const newMap = new Map();
      if (Array.isArray(watchingRows)) {
        const seenSocial = new Set();
        for (const r of watchingRows) {
          if (r.community_hidden === true) continue;
          const isSaturn = (r.source === 'animesaturn' || String(r.media_id).startsWith('saturn_'));
          const isTv = !isSaturn && (r.media_type === 'tv' || (r.media_type !== 'movie' && Number(r.season) > 0));
          const isSeries = isTv || isSaturn || r.media_type === 'anime';
          const prog = Number(r.progress || 0);

          const isCompleted = r.is_completed === true || (!isSeries && prog >= 95) || (isSeries && r.is_last_episode === true && prog >= 95);
          const isDropped = !!r.is_dropped;
          const isWatching = !isCompleted && !isDropped && !r.is_hidden;
          if (!isCompleted && !isWatching && !isDropped) continue;

          const key = `${r.user_id}_${r.media_id}`;
          if (seenSocial.has(key)) continue;
          seenSocial.add(key);

          const profile = profileMap.get(String(r.user_id));
          if (!profile) continue;

          const mId = String(r.media_id);
          if (!newMap.has(mId)) newMap.set(mId, []);

          let status = 'watching';
          if (isDropped) {
            status = 'dropped';
          } else if (isCompleted) {
            status = 'completed';
          }

          newMap.get(mId).push({
            userId: String(r.user_id),
            username: profile.username,
            avatar_emoji: profile.avatar_emoji || '🍿',
            avatar_url: profile.avatar_url || null,
            status: status,
            progress: prog,
            season: Number(r.season) || 0,
            episode: Number(r.episode) || 0,
            updatedAt: new Date(r.updated_at).getTime()
          });
        }
      }
      this.socialActivityMap = newMap;

      const feed = [];
      const currentUserId = this.activeUser ? String(this.activeUser.id) : null;

      // Format Comments and Recommendations
      if (Array.isArray(comments)) {
        for (const c of comments) {
          // If profile still exists, use fresh avatar/name
          const profile = profileMap.get(String(c.user_id));
          feed.push({
            id: `comment_${c.id}`,
            feedType: c.comment_type, // 'comment' or 'recommendation'
            userId: c.user_id,
            username: profile ? profile.username : c.username,
            avatar_emoji: profile ? profile.avatar_emoji : c.avatar_emoji,
            avatar_url: profile ? profile.avatar_url : c.avatar_url,
            mediaId: c.media_id,
            mediaType: c.media_type,
            source: c.source,
            title: c.title,
            posterPath: c.poster_path,
            backdropPath: c.backdrop_path,
            slug: c.slug,
            text: c.comment_text,
            timestamp: new Date(c.created_at).getTime()
          });
        }
      }

      // Format Watching, Completed & Dropped activities (from OTHER friends only)
      if (Array.isArray(watchingRows)) {
        const seenWatching = new Set();
        for (const w of watchingRows) {
          // Exclude active user's own watching activity ("L'utente sa cosa sta guardando / ha visto")
          if (currentUserId && String(w.user_id) === currentUserId) continue;
          // Exclude anything hidden from community
          if (w.community_hidden === true) continue;

          const isSaturn = (w.source === 'animesaturn' || String(w.media_id).startsWith('saturn_'));
          const isTv = !isSaturn && (w.media_type === 'tv' || (w.media_type !== 'movie' && Number(w.season) > 0));
          const isSeries = isTv || isSaturn || w.media_type === 'anime';
          const isMovie = !isSeries;
          const prog = Number(w.progress || 0);

          const isCompleted = w.is_completed === true || (!isSeries && prog >= 95) || (isSeries && w.is_last_episode === true && prog >= 95);
          const isDropped = !!w.is_dropped;
          const isWatching = !isCompleted && !isDropped && !w.is_hidden;

          // Skip if neither watching, completed, nor dropped
          if (!isCompleted && !isWatching && !isDropped) continue;

          const profile = profileMap.get(String(w.user_id));
          if (!profile) continue;

          // Key per user + media so we don't duplicate multiple episodes of the same show for one user
          const key = `${w.user_id}_${w.media_id}`;
          if (seenWatching.has(key)) continue;
          seenWatching.add(key);

          let watchText = 'Sta guardando questo contenuto';
          let actionText = 'sta guardando';
          let actionClass = 'is-watching';

          if (isDropped) {
            actionText = 'ha droppato';
            actionClass = 'is-dropped';
            watchText = 'Ha abbandonato la visione (non piaciuto)';
          } else if (isCompleted) {
            actionText = 'ha visto';
            actionClass = 'is-completed';
            if (isSaturn) {
              watchText = 'Ha completato la visione dell\'anime';
            } else if (isTv) {
              watchText = (w.season > 0 && w.episode > 0) ? `Ha finito l'episodio S${w.season}:E${w.episode}` : 'Ha completato la serie TV';
            } else {
              watchText = 'Ha completato la visione del film';
            }
          } else {
            actionText = 'sta guardando';
            actionClass = 'is-watching';
            if (isSaturn) {
              watchText = (w.episode > 0) ? `Sta guardando l'episodio ${w.episode}` : 'Sta guardando questo anime';
            } else if (isTv && w.season > 0 && w.episode > 0) {
              watchText = `Sta guardando S${w.season}:E${w.episode}`;
            } else {
              watchText = 'Sta guardando questo film';
            }
          }

          feed.push({
            id: `watching_${w.id}`,
            feedType: 'watching',
            watchStatus: isDropped ? 'dropped' : (isCompleted ? 'completed' : 'watching'),
            actionText: actionText,
            actionClass: actionClass,
            userId: w.user_id,
            username: profile.username,
            avatar_emoji: profile.avatar_emoji,
            avatar_url: profile.avatar_url,
            mediaId: w.media_id,
            mediaType: isSaturn ? 'anime' : (isTv ? 'tv' : 'movie'),
            source: w.source,
            title: w.title,
            posterPath: w.poster_path,
            backdropPath: w.backdrop_path,
            season: isTv && w.season > 0 ? w.season : undefined,
            episode: isTv && w.episode > 0 ? w.episode : undefined,
            progress: prog,
            slug: w.slug,
            text: watchText,
            timestamp: new Date(w.updated_at).getTime()
          });
        }
      }

      // Sort chronological descending
      feed.sort((a, b) => b.timestamp - a.timestamp);
      return feed.slice(0, 30);
    } catch (e) {
      console.warn('[SupabaseService] Failed to load community feed:', e);
      return [];
    }
  },

  // =========================================================================
  // Feedback & Feature Requests
  // =========================================================================
  async getFeedbackEntries() {
    try {
      const activeUser = this.getActiveUser();
      const currentUserId = activeUser ? String(activeUser.id) : null;

      const rows = await this.restRequest('feedback_entries?select=*,feedback_upvotes(*)&order=created_at.asc');
      if (!Array.isArray(rows)) return [];

      const parsed = rows.map(entry => {
        const upvotes = Array.isArray(entry.feedback_upvotes) ? entry.feedback_upvotes : [];
        const hasUpvoted = currentUserId ? upvotes.some(u => String(u.user_id) === currentUserId) : false;
        return {
          id: entry.id,
          userId: entry.user_id,
          username: entry.username,
          avatar_emoji: entry.avatar_emoji || '🍿',
          avatar_url: entry.avatar_url,
          type: entry.type, // 'bug' or 'feature'
          title: entry.title,
          description: entry.description,
          isCompleted: !!entry.is_completed,
          createdAt: new Date(entry.created_at).getTime(),
          upvotesCount: upvotes.length,
          hasUpvoted: hasUpvoted,
          upvoters: upvotes.map(u => ({
            userId: u.user_id,
            username: u.username,
            avatar_emoji: u.avatar_emoji || '🍿',
            avatar_url: u.avatar_url
          }))
        };
      });

      // Order by: 1. upvotes count descending, 2. created_at ascending (oldest first)
      parsed.sort((a, b) => {
        if (b.upvotesCount !== a.upvotesCount) {
          return b.upvotesCount - a.upvotesCount;
        }
        return a.createdAt - b.createdAt;
      });

      return parsed;
    } catch (e) {
      console.warn('[SupabaseService] Failed to get feedback entries:', e);
      return [];
    }
  },

  async createFeedbackEntry({ type, title, description }) {
    const user = this.getActiveUser();
    if (!user || !user.id) {
      throw new Error('Devi aver selezionato un profilo utente per inviare feedback.');
    }
    if (!description || !description.trim()) {
      throw new Error('La descrizione non può essere vuota.');
    }

    const payload = {
      user_id: user.id,
      username: user.username || 'Amico',
      avatar_emoji: user.avatar_emoji || '🍿',
      avatar_url: user.avatar_url || null,
      type: type === 'feature' ? 'feature' : 'bug',
      title: (title && title.trim()) ? title.trim() : (type === 'feature' ? 'Feature Request' : 'Segnalazione Bug'),
      description: description.trim(),
      is_completed: false
    };

    const res = await this.restRequest('feedback_entries', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(payload)
    });

    return Array.isArray(res) && res.length > 0 ? res[0] : res;
  },

  async deleteFeedbackEntry(feedbackId) {
    const user = this.getActiveUser();
    if (!user || !user.id || !feedbackId) {
      throw new Error('Non autorizzato a cancellare questa voce.');
    }

    await this.restRequest(`feedback_entries?id=eq.${encodeURIComponent(String(feedbackId))}&user_id=eq.${user.id}`, {
      method: 'DELETE'
    });
    return true;
  },

  async toggleFeedbackUpvote(feedbackId) {
    const user = this.getActiveUser();
    if (!user || !user.id || !feedbackId) {
      throw new Error('Devi selezionare un profilo per votare.');
    }

    // Check if user already upvoted
    const existing = await this.restRequest(`feedback_upvotes?feedback_id=eq.${encodeURIComponent(String(feedbackId))}&user_id=eq.${user.id}&select=id&limit=1`);

    if (Array.isArray(existing) && existing.length > 0) {
      // Remove upvote
      await this.restRequest(`feedback_upvotes?feedback_id=eq.${encodeURIComponent(String(feedbackId))}&user_id=eq.${user.id}`, {
        method: 'DELETE'
      });
      return { upvoted: false };
    } else {
      // Add upvote
      await this.restRequest('feedback_upvotes', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          feedback_id: feedbackId,
          user_id: user.id,
          username: user.username || 'Amico',
          avatar_emoji: user.avatar_emoji || '🍿',
          avatar_url: user.avatar_url || null
        })
      });
      return { upvoted: true };
    }
  },

  // =========================================================================
  // User Profile & Community Pages Data
  // =========================================================================
  async getUserProfileData(userId) {
    try {
      const activeUser = this.getActiveUser();
      const isOwner = activeUser && String(activeUser.id) === String(userId);

      // Fetch profile, watched history, recommendations and comments
      const [profiles, watchRows, commentsRows] = await Promise.all([
        this.restRequest(`profiles?id=eq.${userId}&select=id,username,avatar_emoji,avatar_url,bio,created_at,last_active_at&limit=1`),
        isOwner 
          ? this.restRequest(`watch_progress?user_id=eq.${userId}&order=updated_at.desc&limit=150`)
          : this.restRequest(`watch_progress?user_id=eq.${userId}&community_hidden=eq.false&order=updated_at.desc&limit=150`),
        this.restRequest(`comments?user_id=eq.${userId}&order=created_at.desc&limit=100`)
      ]);

      const profile = Array.isArray(profiles) && profiles.length > 0 ? profiles[0] : null;
      if (!profile) return null;

      // Extract watched (completed) items
      const watched = [];
      const seenMedia = new Set();
      if (Array.isArray(watchRows)) {
        for (const r of watchRows) {
          if (r.is_dropped) continue;
          const isSaturn = (r.source === 'animesaturn' || String(r.media_id).startsWith('saturn_'));
          const isTv = !isSaturn && (r.media_type === 'tv' || (r.media_type !== 'movie' && Number(r.season) > 0));
          const isSeries = isTv || isSaturn || r.media_type === 'anime';
          const prog = Number(r.progress || 0);

          const isCompleted = r.is_completed === true || (!isSeries && prog >= 95) || (isSeries && r.is_last_episode === true && prog >= 95);
          if (!isCompleted) continue;

          const key = String(r.media_id);
          if (seenMedia.has(key)) continue;
          seenMedia.add(key);

          watched.push({
            id: r.media_id,
            title: r.title,
            poster_path: r.poster_path,
            backdrop_path: r.backdrop_path,
            media_type: isSaturn ? 'anime' : (isTv ? 'tv' : 'movie'),
            source: r.source || (isSaturn ? 'animesaturn' : 'tmdb'),
            slug: r.slug,
            community_hidden: !!r.community_hidden,
            updated_at: r.updated_at
          });
        }
      }

      const recommendations = [];
      const comments = [];
      if (Array.isArray(commentsRows)) {
        for (const c of commentsRows) {
          const item = {
            id: c.id,
            media_id: c.media_id,
            title: c.title,
            poster_path: c.poster_path,
            backdrop_path: c.backdrop_path,
            media_type: c.media_type,
            source: c.source,
            slug: c.slug,
            comment_text: c.comment_text,
            comment_type: c.comment_type,
            created_at: c.created_at
          };
          if (c.comment_type === 'recommendation') {
            recommendations.push(item);
          } else {
            comments.push(item);
          }
        }
      }

      return {
        profile,
        isOwner,
        watched,
        recommendations,
        comments
      };
    } catch (e) {
      console.warn('[SupabaseService] Failed to load user profile data:', e);
      return null;
    }
  }
};

window.SupabaseService = SupabaseService;
