/**
 * Roxy - Local Storage Manager for webOS
 * Manages Continue Watching history, Watchlist, and App State
 */
const StorageService = {
  KEYS: {
    CONTINUE_WATCHING: 'roxy_continue_watching',
    WATCHLIST: 'roxy_watchlist',
    SETTINGS: 'roxy_settings'
  },

  // Continue Watching
  getContinueWatching() {
    try {
      const data = localStorage.getItem(this.KEYS.CONTINUE_WATCHING);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.error('Storage read error:', e);
      return [];
    }
  },

  getItemProgress(id) {
    try {
      const list = this.getContinueWatching();
      return list.find(i => i.id === Number(id)) || null;
    } catch (e) {
      return null;
    }
  },

  saveWatchProgress(item, currentTime = 0, duration = 0) {
    try {
      if (!item || !item.id) return;
      const list = this.getContinueWatching().filter(i => i.id !== item.id);
      const isTv = (item.media_type === 'tv' || !!item.name || (item.number_of_seasons !== undefined));
      const progressPercent = duration > 0 ? Math.min(100, Math.round((currentTime / duration) * 100)) : 0;
      
      const record = {
        id: item.id,
        media_type: isTv ? 'tv' : 'movie',
        title: item.title || item.name,
        backdrop_path: item.backdrop_path,
        poster_path: item.poster_path,
        season: item.season || 1,
        episode: item.episode || 1,
        episode_name: item.episode_name || '',
        currentTime: Math.floor(currentTime),
        duration: Math.floor(duration),
        progress: progressPercent,
        updatedAt: Date.now()
      };

      // Only save if user has watched at least 5 seconds and not finished (>95%)
      if (progressPercent < 95) {
        list.unshift(record);
      }
      
      // Keep up to 20 items
      localStorage.setItem(this.KEYS.CONTINUE_WATCHING, JSON.stringify(list.slice(0, 20)));
    } catch (e) {
      console.error('Storage save error:', e);
    }
  },

  // Watchlist
  getWatchlist() {
    try {
      const data = localStorage.getItem(this.KEYS.WATCHLIST);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  },

  isInWatchlist(id) {
    const list = this.getWatchlist();
    return list.some(item => item.id === id);
  },

  toggleWatchlist(item) {
    try {
      let list = this.getWatchlist();
      const index = list.findIndex(i => i.id === item.id);
      let added = false;
      if (index >= 0) {
        list.splice(index, 1);
        added = false;
      } else {
        list.unshift({
          id: item.id,
          media_type: item.media_type || (item.name ? 'tv' : 'movie'),
          title: item.title || item.name,
          poster_path: item.poster_path,
          backdrop_path: item.backdrop_path,
          vote_average: item.vote_average,
          release_date: item.release_date || item.first_air_date
        });
        added = true;
      }
      localStorage.setItem(this.KEYS.WATCHLIST, JSON.stringify(list));
      return added;
    } catch (e) {
      console.error('Watchlist toggle error:', e);
      return false;
    }
  }
};

window.StorageService = StorageService;
