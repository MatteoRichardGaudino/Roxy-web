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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

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
      clearTimeout(timeoutId);
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

  // =========================================================================
  // Profiles & Authentication
  // =========================================================================
  async getProfiles() {
    try {
      const profiles = await this.restRequest('profiles?select=id,username,avatar_emoji,created_at,last_active_at&order=last_active_at.desc');
      return Array.isArray(profiles) ? profiles : [];
    } catch (e) {
      console.warn('[SupabaseService] Failed to load profiles from cloud:', e);
      return [];
    }
  },

  async createProfile(username, pin, avatarEmoji = '🍿') {
    const cleanUser = String(username || '').trim();
    const cleanPin = String(pin || '').trim();

    if (!cleanUser || cleanUser.length < 2) {
      throw new Error('Il nome profilo deve contenere almeno 2 caratteri.');
    }
    if (!/^\d{4}$/.test(cleanPin)) {
      throw new Error('Il PIN deve essere composto esattamente da 4 cifre numeriche.');
    }

    // Check 30 users limit
    const existing = await this.getProfiles();
    if (existing.length >= this.maxUsersLimit) {
      throw new Error(`Limite massimo di ${this.maxUsersLimit} amici registrati raggiunto.`);
    }

    if (existing.some(p => p.username.toLowerCase() === cleanUser.toLowerCase())) {
      throw new Error(`Il nome "${cleanUser}" è già utilizzato da un altro profilo.`);
    }

    const pinHash = await this.hashPin(cleanPin);
    const newProfiles = await this.restRequest('profiles', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        username: cleanUser,
        pin_hash: pinHash,
        avatar_emoji: avatarEmoji || '🍿'
      })
    });

    const user = newProfiles && newProfiles[0] ? newProfiles[0] : null;
    if (user) {
      this.setActiveUser(user);
      this.logMetric('register_profile', null, { username: cleanUser });
    }
    return user;
  },

  async login(profileId, enteredPin) {
    const cleanPin = String(enteredPin || '').trim();
    if (!/^\d{4}$/.test(cleanPin)) {
      throw new Error('Inserisci un PIN numerico di 4 cifre.');
    }

    const pinHash = await this.hashPin(cleanPin);
    const results = await this.restRequest(`profiles?id=eq.${profileId}&select=id,username,pin_hash,avatar_emoji`);

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
    if (updates.avatar_emoji) payload.avatar_emoji = updates.avatar_emoji;
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
        avatar_emoji: user.avatar_emoji
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
          avatar_emoji: user.avatar_emoji
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
  // Cloud Watch Progress Sync (Continue Watching)
  // =========================================================================
  async syncWatchProgress(item, currentTime, duration) {
    const user = this.getActiveUser();
    if (!user || !user.id || !item || !item.id || duration <= 0) return;

    const mediaId = String(item.id);
    const isTv = (item.media_type === 'tv' || !!item.name || (item.number_of_seasons !== undefined));
    const season = item.season || (isTv ? 1 : 0);
    const episode = item.episode || (isTv ? 1 : 0);
    const progress = Math.min(100, Math.max(0, (currentTime / duration) * 100));

    const payload = {
      user_id: user.id,
      media_id: mediaId,
      source: item.source || 'tmdb',
      media_type: item.media_type || (isTv ? 'tv' : 'movie'),
      title: item.title || item.name || 'Streaming',
      poster_path: item.poster_path || '',
      backdrop_path: item.backdrop_path || '',
      season: season,
      episode: episode,
      episode_name: item.episode_name || '',
      playback_time: Math.floor(currentTime),
      duration: Math.floor(duration),
      progress: Math.round(progress * 10) / 10,
      is_dub: !!item.isDub,
      slug: item.slug || '',
      updated_at: new Date().toISOString()
    };

    try {
      await this.restRequest('watch_progress?on_conflict=user_id,media_id,season,episode', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.warn('[SupabaseService] Cloud progress sync notice:', e.message);
    }
  },

  async getCloudContinueWatching() {
    const user = this.getActiveUser();
    if (!user || !user.id) return [];

    try {
      const rows = await this.restRequest(`watch_progress?user_id=eq.${user.id}&progress=lt.95&order=updated_at.desc&limit=25`);
      if (!Array.isArray(rows)) return [];
      return rows.map(r => ({
        id: r.media_id,
        source: r.source,
        media_type: r.media_type,
        title: r.title,
        name: r.title,
        poster_path: r.poster_path,
        backdrop_path: r.backdrop_path,
        season: r.season > 0 ? r.season : undefined,
        episode: r.episode > 0 ? r.episode : undefined,
        episode_name: r.episode_name,
        currentTime: Number(r.playback_time),
        duration: Number(r.duration),
        progress: Number(r.progress),
        isDub: r.is_dub,
        slug: r.slug,
        timestamp: new Date(r.updated_at).getTime()
      }));
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
  }
};

window.SupabaseService = SupabaseService;
