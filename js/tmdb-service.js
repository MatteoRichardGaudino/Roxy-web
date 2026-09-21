/**
 * Roxy - TMDB API Service
 * Fetches movies, TV shows, genres, details, search results and backdrops
 */
const TMDBService = {
  async fetchTMDB(endpoint, params = {}) {
    const url = new URL(`${CONFIG.TMDB.BASE_URL}${endpoint}`);
    url.searchParams.append('api_key', CONFIG.TMDB.API_KEY);
    url.searchParams.append('language', CONFIG.TMDB.LANGUAGE);

    Object.keys(params).forEach(key => {
      url.searchParams.append(key, params[key]);
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`TMDB HTTP error ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      console.warn(`TMDB fetch failed for ${endpoint}, retrying with fallback language:`, error.message);
      // Try fallback to en-US if localized call had an issue
      const fallbackController = new AbortController();
      const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), 4000);
      try {
        url.searchParams.set('language', CONFIG.TMDB.FALLBACK_LANGUAGE);
        const fallbackRes = await fetch(url.toString(), { signal: fallbackController.signal });
        clearTimeout(fallbackTimeoutId);
        if (fallbackRes.ok) return await fallbackRes.json();
      } catch (e) {
        clearTimeout(fallbackTimeoutId);
        console.error('TMDB fallback failed:', e.message);
      }
      return { results: [] };
    }
  },

  getTodayDate() {
    return new Date().toISOString().split('T')[0];
  },

  shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },

  // Get Trending items filtered for released media
  async getTrending(timeWindow = 'day') {
    const today = this.getTodayDate();
    const [p1, p2] = await Promise.all([
      this.fetchTMDB(`/trending/all/${timeWindow}`, { page: 1 }),
      this.fetchTMDB(`/trending/all/${timeWindow}`, { page: 2 })
    ]);
    const raw = [...(p1.results || []), ...(p2.results || [])];
    const seen = new Set();
    const results = raw.filter(item => {
      if (!item || !item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      const releaseDate = item.release_date || item.first_air_date;
      return item.backdrop_path && (item.title || item.name) && (!releaseDate || releaseDate <= today);
    });
    return results;
  },

  // Get Currently Popular Movies available on Digital/Streaming (4) or Physical Disc (5)
  async getPopularMovies(page = 1) {
    const today = this.getTodayDate();
    const [p1, p2] = await Promise.all([
      this.fetchTMDB('/discover/movie', {
        with_release_type: '4|5',
        'release_date.lte': today,
        'vote_count.gte': 25,
        sort_by: 'popularity.desc',
        page: page * 2 - 1
      }),
      this.fetchTMDB('/discover/movie', {
        with_release_type: '4|5',
        'release_date.lte': today,
        'vote_count.gte': 25,
        sort_by: 'popularity.desc',
        page: page * 2
      })
    ]);
    const raw = [...(p1.results || []), ...(p2.results || [])];
    const seen = new Set();
    return raw.filter(i => {
      if (!i || !i.id || seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    }).map(i => ({ ...i, media_type: 'movie' }));
  },

  // Get All-Time Popular Blockbusters available on Digital / Disc
  async getAllTimePopularMovies(page = 1) {
    const today = this.getTodayDate();
    const [p1, p2] = await Promise.all([
      this.fetchTMDB('/discover/movie', {
        with_release_type: '4|5',
        'release_date.lte': today,
        'vote_count.gte': 500,
        'vote_average.gte': 6.8,
        sort_by: 'vote_count.desc',
        page: page * 2 - 1
      }),
      this.fetchTMDB('/discover/movie', {
        with_release_type: '4|5',
        'release_date.lte': today,
        'vote_count.gte': 500,
        'vote_average.gte': 6.8,
        sort_by: 'vote_count.desc',
        page: page * 2
      })
    ]);
    const raw = [...(p1.results || []), ...(p2.results || [])];
    const seen = new Set();
    return raw.filter(i => {
      if (!i || !i.id || seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    }).map(i => ({ ...i, media_type: 'movie' }));
  },

  // Get Popular TV Series
  async getPopularTV(page = 1) {
    const today = this.getTodayDate();
    const [p1, p2] = await Promise.all([
      this.fetchTMDB('/discover/tv', {
        'first_air_date.lte': today,
        'vote_count.gte': 15,
        sort_by: 'popularity.desc',
        page: page * 2 - 1
      }),
      this.fetchTMDB('/discover/tv', {
        'first_air_date.lte': today,
        'vote_count.gte': 15,
        sort_by: 'popularity.desc',
        page: page * 2
      })
    ]);
    const raw = [...(p1.results || []), ...(p2.results || [])];
    const seen = new Set();
    return raw.filter(i => {
      if (!i || !i.id || seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    }).map(i => ({ ...i, media_type: 'tv' }));
  },

  // Get Top Rated Movies available on Digital/Disc
  async getTopRatedMovies(page = 1) {
    const today = this.getTodayDate();
    const [p1, p2] = await Promise.all([
      this.fetchTMDB('/discover/movie', {
        with_release_type: '4|5',
        'release_date.lte': today,
        'vote_count.gte': 200,
        'vote_average.gte': 7.5,
        sort_by: 'vote_average.desc',
        page: page * 2 - 1
      }),
      this.fetchTMDB('/discover/movie', {
        with_release_type: '4|5',
        'release_date.lte': today,
        'vote_count.gte': 200,
        'vote_average.gte': 7.5,
        sort_by: 'vote_average.desc',
        page: page * 2
      })
    ]);
    const raw = [...(p1.results || []), ...(p2.results || [])];
    const seen = new Set();
    return raw.filter(i => {
      if (!i || !i.id || seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    }).map(i => ({ ...i, media_type: 'movie' }));
  },

  // Discover by Genre (filtered to released items only)
  async getByGenre(genreId, mediaType = 'movie', page = 1) {
    const today = this.getTodayDate();
    if (mediaType === 'tv') {
      const [p1, p2] = await Promise.all([
        this.fetchTMDB('/discover/tv', {
          with_genres: genreId,
          'first_air_date.lte': today,
          'vote_count.gte': 10,
          sort_by: 'popularity.desc',
          page: page * 2 - 1
        }),
        this.fetchTMDB('/discover/tv', {
          with_genres: genreId,
          'first_air_date.lte': today,
          'vote_count.gte': 10,
          sort_by: 'popularity.desc',
          page: page * 2
        })
      ]);
      const raw = [...(p1.results || []), ...(p2.results || [])];
      const seen = new Set();
      return raw.filter(i => {
        if (!i || !i.id || seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      }).map(i => ({ ...i, media_type: 'tv' }));
    } else {
      const [p1, p2] = await Promise.all([
        this.fetchTMDB('/discover/movie', {
          with_genres: genreId,
          with_release_type: '4|5',
          'release_date.lte': today,
          'vote_count.gte': 15,
          sort_by: 'popularity.desc',
          page: page * 2 - 1
        }),
        this.fetchTMDB('/discover/movie', {
          with_genres: genreId,
          with_release_type: '4|5',
          'release_date.lte': today,
          'vote_count.gte': 15,
          sort_by: 'popularity.desc',
          page: page * 2
        })
      ]);
      const raw = [...(p1.results || []), ...(p2.results || [])];
      const seen = new Set();
      return raw.filter(i => {
        if (!i || !i.id || seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      }).map(i => ({ ...i, media_type: 'movie' }));
    }
  },

  // In-memory cache for genre discoveries
  _discoverCache: new Map(),

  // Discover by Multiple Genres (simultaneous filters) with caching and released filter
  async discoverByMultipleGenres(movieGenreIds = [], tvGenreIds = [], mediaType = 'all', page = 1) {
    const today = this.getTodayDate();
    const movieGStr = (movieGenreIds || []).slice().sort().join(',');
    const tvGStr = (tvGenreIds || []).slice().sort().join(',');
    const cacheKey = `${mediaType}:${movieGStr}:${tvGStr}:${page}`;

    if (this._discoverCache.has(cacheKey)) {
      return this._discoverCache.get(cacheKey);
    }

    const promises = [];

    // Movie discovery
    if ((mediaType === 'all' || mediaType === 'movie') && movieGenreIds && movieGenreIds.length > 0) {
      const gParam = movieGenreIds.join(',');
      promises.push(
        this.fetchTMDB('/discover/movie', {
          with_genres: gParam,
          with_release_type: '4|5',
          'release_date.lte': today,
          'vote_count.gte': 15,
          sort_by: 'popularity.desc',
          page: page * 2 - 1
        }).then(res => (res.results || []).map(i => ({ ...i, media_type: 'movie' })))
      );
      promises.push(
        this.fetchTMDB('/discover/movie', {
          with_genres: gParam,
          with_release_type: '4|5',
          'release_date.lte': today,
          'vote_count.gte': 15,
          sort_by: 'popularity.desc',
          page: page * 2
        }).then(res => (res.results || []).map(i => ({ ...i, media_type: 'movie' })))
      );
    }

    // TV Series discovery
    if ((mediaType === 'all' || mediaType === 'tv') && tvGenreIds && tvGenreIds.length > 0) {
      const gParam = tvGenreIds.join(',');
      promises.push(
        this.fetchTMDB('/discover/tv', {
          with_genres: gParam,
          'first_air_date.lte': today,
          'vote_count.gte': 10,
          sort_by: 'popularity.desc',
          page: page * 2 - 1
        }).then(res => (res.results || []).map(i => ({ ...i, media_type: 'tv' })))
      );
      promises.push(
        this.fetchTMDB('/discover/tv', {
          with_genres: gParam,
          'first_air_date.lte': today,
          'vote_count.gte': 10,
          sort_by: 'popularity.desc',
          page: page * 2
        }).then(res => (res.results || []).map(i => ({ ...i, media_type: 'tv' })))
      );
    }

    const fetchedArrays = await Promise.all(promises);
    const combined = fetchedArrays.flat();

    const seen = new Set();
    const results = combined.filter(item => {
      if (!item || !item.id || !item.poster_path || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });

    results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

    // Maintain cache bounded to 80 entries
    if (this._discoverCache.size > 80) {
      const oldestKey = this._discoverCache.keys().next().value;
      this._discoverCache.delete(oldestKey);
    }
    this._discoverCache.set(cacheKey, results);

    return results;
  },

  // Search Multi (Movies & TV Series) with 2 TMDB pages per pagination batch
  async search(query, page = 1) {
    if (!query || query.trim().length === 0) return [];
    const [p1, p2] = await Promise.all([
      this.fetchTMDB('/search/multi', {
        query: encodeURIComponent(query),
        page: page * 2 - 1,
        include_adult: false
      }),
      this.fetchTMDB('/search/multi', {
        query: encodeURIComponent(query),
        page: page * 2,
        include_adult: false
      })
    ]);
    const raw = [...(p1.results || []), ...(p2.results || [])];
    const seen = new Set();
    return raw.filter(item => {
      if (!item || !item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return (item.media_type === 'movie' || item.media_type === 'tv') && item.poster_path;
    });
  },

  // Get Content Details with Videos, Credits & Similar
  async getDetails(id, mediaType = 'movie') {
    const endpoint = `/${mediaType}/${id}`;
    return await this.fetchTMDB(endpoint, {
      append_to_response: 'videos,credits,similar,recommendations'
    });
  },

  // Get Season Episodes for TV Series
  async getSeasonDetails(tvId, seasonNumber = 1) {
    return await this.fetchTMDB(`/tv/${tvId}/season/${seasonNumber}`);
  },

  // Helpers for Image URLs
  getPosterUrl(path, size = 'w500') {
    if (!path) return 'assets/bgImage.png';
    return `https://image.tmdb.org/t/p/${size}${path}`;
  },

  getBackdropUrl(path, size = 'w1280') {
    if (!path) return 'assets/bgImage.png';
    return `https://image.tmdb.org/t/p/${size}${path}`;
  },

  getOriginalUrl(path) {
    if (!path) return 'assets/bgImage.png';
    return `${CONFIG.TMDB.IMAGE_BASE_ORIGINAL}${path}`;
  }
};

window.TMDBService = TMDBService;
