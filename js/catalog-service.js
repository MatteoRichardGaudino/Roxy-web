/**
 * Roxy - VixSrc Catalog Synchronization Service
 * Caches the Italian catalog once every 24 hours in local storage/IndexedDB
 * to avoid startup delays and unnecessary network requests.
 */
const CatalogService = {
  CACHE_KEY_META: 'roxy_catalog_meta',
  CACHE_KEY_MOVIES: 'roxy_catalog_movies',
  CACHE_KEY_TV: 'roxy_catalog_tv',
  CACHE_KEY_EPISODES: 'roxy_catalog_episodes',
  ONE_DAY_MS: 24 * 60 * 60 * 1000, // 24 hours

  movies: new Set(),
  tv: new Set(),
  episodes: new Set(),
  isLoaded: false,
  isLoading: false,
  lastSyncTime: null,

  // IndexedDB helper for fast, large quota storage
  openDB() {
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      const request = indexedDB.open('RoxyCatalogDB', 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('catalog')) {
          db.createObjectStore('catalog');
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = () => resolve(null);
    });
  },

  async getFromDB(key) {
    try {
      const db = await this.openDB();
      if (!db) {
        const fallback = localStorage.getItem(key);
        return fallback ? JSON.parse(fallback) : null;
      }
      return new Promise((resolve) => {
        const tx = db.transaction('catalog', 'readonly');
        const store = tx.objectStore('catalog');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  },

  async saveToDB(key, data) {
    try {
      const db = await this.openDB();
      if (!db) {
        try { localStorage.setItem(key, JSON.stringify(data)); } catch(e) {}
        return;
      }
      return new Promise((resolve) => {
        const tx = db.transaction('catalog', 'readwrite');
        const store = tx.objectStore('catalog');
        store.put(data, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (e) {
      console.warn('[CatalogService] DB save warning:', e);
    }
  },

  async init() {
    if (this.isLoaded) return;
    if (this._initPromise) return this._initPromise;
    this.isLoading = true;

    this._initPromise = (async () => {
      try {
        // 1. Check local cache and sync timestamp
        const meta = await this.getFromDB(this.CACHE_KEY_META);
        const now = Date.now();

        if (meta && meta.lastSyncTimestamp && (now - meta.lastSyncTimestamp < this.ONE_DAY_MS)) {
          this.lastSyncTime = new Date(meta.lastSyncTimestamp);
          console.log(`[CatalogService] Cache is valid (synced on ${this.lastSyncTime.toLocaleString()}). Loading from storage...`);

          const [cachedMovies, cachedTv, cachedEpisodes] = await Promise.all([
            this.getFromDB(this.CACHE_KEY_MOVIES),
            this.getFromDB(this.CACHE_KEY_TV),
            this.getFromDB(this.CACHE_KEY_EPISODES)
          ]);

          if (Array.isArray(cachedMovies) && Array.isArray(cachedTv) && Array.isArray(cachedEpisodes)) {
            this.movies = new Set(cachedMovies);
            this.tv = new Set(cachedTv);
            this.episodes = new Set(cachedEpisodes);
            this.isLoaded = true;
            console.log(`[CatalogService] Loaded instant cache: ${this.movies.size} Movies, ${this.tv.size} TV Shows, ${this.episodes.size} Episodes.`);
            return;
          }
        }

        // 2. If no cache or cache older than 24h: fetch fresh catalog from API in background
        await this.fetchAndSaveFreshCatalog();
      } catch (err) {
        console.warn('[CatalogService] Error initializing catalog:', err);
      } finally {
        this.isLoading = false;
        this.isLoaded = true;
      }
    })();

    return this._initPromise;
  },

  async ready() {
    if (this.isLoaded) return;
    if (this._initPromise) {
      await this._initPromise;
    } else {
      await this.init();
    }
  },

  async fetchAndSaveFreshCatalog() {
    console.log('[CatalogService] Fetching fresh Italian catalog from Supabase Storage / Vix (Daily Sync)...');

    const fetchEndpoint = async (url) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 6000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (res.ok) return await res.json();
        return null;
      } catch (e) {
        clearTimeout(id);
        console.warn(`[CatalogService] Endpoint notice on ${url}:`, e.message);
        return null;
      }
    };

    // 1. Try Supabase Storage public bucket first (CORS-free on web browser, fast, globally distributed)
    let [moviesData, tvData, epData] = await Promise.all([
      fetchEndpoint(CONFIG.SUPABASE.STORAGE_CATALOG.MOVIE),
      fetchEndpoint(CONFIG.SUPABASE.STORAGE_CATALOG.TV),
      fetchEndpoint(CONFIG.SUPABASE.STORAGE_CATALOG.EPISODE)
    ]);

    let moviesList = [];
    let tvList = [];
    let episodesList = [];

    if (Array.isArray(moviesData) && Array.isArray(tvData) && Array.isArray(epData) && (moviesData.length > 0 || tvData.length > 0)) {
      // Supabase bucket stores parsed integer arrays directly
      moviesList = moviesData.map(Number).filter(Boolean);
      tvList = tvData.map(Number).filter(Boolean);
      episodesList = epData.filter(Boolean);
      console.log(`[CatalogService] Loaded via Supabase Cloud Storage: ${moviesList.length} Movies, ${tvList.length} TV Shows.`);
    } else {
      // 2. Fallback to direct VixSrc endpoints (e.g. on webOS where CORS is unrestricted)
      console.log('[CatalogService] Storage bucket empty/fallback, fetching direct Vix endpoints...');
      const [vixMovies, vixTv, vixEp] = await Promise.all([
        fetchEndpoint(CONFIG.CATALOG_LIST.MOVIE),
        fetchEndpoint(CONFIG.CATALOG_LIST.TV),
        fetchEndpoint(CONFIG.CATALOG_LIST.EPISODE)
      ]);

      if (Array.isArray(vixMovies)) {
        vixMovies.forEach(m => {
          if (m && m.tmdb_id) moviesList.push(Number(m.tmdb_id));
        });
      }
      if (Array.isArray(vixTv)) {
        vixTv.forEach(t => {
          if (t && t.tmdb_id) tvList.push(Number(t.tmdb_id));
        });
      }
      if (Array.isArray(vixEp)) {
        vixEp.forEach(e => {
          if (e && e.tmdb_id && e.s !== undefined && e.e !== undefined) {
            episodesList.push(`${e.tmdb_id}_${e.s}_${e.e}`);
          }
        });
      }
    }

    this.movies = new Set(moviesList);
    this.tv = new Set(tvList);
    this.episodes = new Set(episodesList);
    this.isLoaded = true;
    this.lastSyncTime = new Date();

    console.log(`[CatalogService] Downloaded & parsed: ${this.movies.size} Movies, ${this.tv.size} TV Shows, ${this.episodes.size} Episodes.`);

    // Persist to storage with current timestamp
    await Promise.all([
      this.saveToDB(this.CACHE_KEY_MOVIES, moviesList),
      this.saveToDB(this.CACHE_KEY_TV, tvList),
      this.saveToDB(this.CACHE_KEY_EPISODES, episodesList),
      this.saveToDB(this.CACHE_KEY_META, {
        lastSyncTimestamp: Date.now(),
        moviesCount: moviesList.length,
        tvCount: tvList.length,
        episodesCount: episodesList.length
      })
    ]);

    console.log('[CatalogService] Catalog cached locally for 24 hours.');
  },

  isMovieAvailable(tmdbId) {
    if (!this.movies || this.movies.size === 0) return false;
    return this.movies.has(Number(tmdbId));
  },

  isTvAvailable(tmdbId) {
    if (!this.tv || this.tv.size === 0) return false;
    return this.tv.has(Number(tmdbId));
  },

  isEpisodeAvailable(tmdbId, season, episode) {
    if (!this.episodes || this.episodes.size === 0) return false;
    return this.episodes.has(`${tmdbId}_${season}_${episode}`);
  },

  isItemAvailable(item) {
    if (!item || !item.id) return false;
    if (item.source === 'animesaturn' || String(item.id).startsWith('saturn_')) return true;
    const isTv = (item.media_type === 'tv' || !!item.name || (item.number_of_seasons !== undefined));
    return isTv ? this.isTvAvailable(item.id) : this.isMovieAvailable(item.id);
  },

  filterAvailable(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(item => this.isItemAvailable(item));
  }
};

window.CatalogService = CatalogService;
