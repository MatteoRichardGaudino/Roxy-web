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
    const data = await this.fetchTMDB(`/trending/all/${timeWindow}`);
    const results = (data.results || []).filter(item => {
      const releaseDate = item.release_date || item.first_air_date;
      return item.backdrop_path && (item.title || item.name) && (!releaseDate || releaseDate <= today);
    });
    return results;
  },

  // Get Currently Popular Movies available on Digital/Streaming (4) or Physical Disc (5)
  async getPopularMovies(page = 1) {
    const today = this.getTodayDate();
    const data = await this.fetchTMDB('/discover/movie', {
      with_release_type: '4|5',
      'release_date.lte': today,
      'vote_count.gte': 25,
      sort_by: 'popularity.desc',
      page
    });
    return (data.results || []).map(i => ({ ...i, media_type: 'movie' }));
  },

  // Get All-Time Popular Blockbusters available on Digital / Disc
  async getAllTimePopularMovies(page = 1) {
    const today = this.getTodayDate();
    const data = await this.fetchTMDB('/discover/movie', {
      with_release_type: '4|5',
      'release_date.lte': today,
      'vote_count.gte': 500,
      'vote_average.gte': 6.8,
      sort_by: 'vote_count.desc',
      page
    });
    return (data.results || []).map(i => ({ ...i, media_type: 'movie' }));
  },

  // Get Popular TV Series
  async getPopularTV(page = 1) {
    const today = this.getTodayDate();
    const data = await this.fetchTMDB('/discover/tv', {
      'first_air_date.lte': today,
      'vote_count.gte': 15,
      sort_by: 'popularity.desc',
      page
    });
    return (data.results || []).map(i => ({ ...i, media_type: 'tv' }));
  },

  // Get Top Rated Movies available on Digital/Disc
  async getTopRatedMovies(page = 1) {
    const today = this.getTodayDate();
    const data = await this.fetchTMDB('/discover/movie', {
      with_release_type: '4|5',
      'release_date.lte': today,
      'vote_count.gte': 200,
      'vote_average.gte': 7.5,
      sort_by: 'vote_average.desc',
      page
    });
    return (data.results || []).map(i => ({ ...i, media_type: 'movie' }));
  },

  // Discover by Genre (filtered to released items only)
  async getByGenre(genreId, mediaType = 'movie', page = 1) {
    const today = this.getTodayDate();
    if (mediaType === 'tv') {
      const data = await this.fetchTMDB('/discover/tv', {
        with_genres: genreId,
        'first_air_date.lte': today,
        'vote_count.gte': 10,
        sort_by: 'popularity.desc',
        page
      });
      return (data.results || []).map(i => ({ ...i, media_type: 'tv' }));
    } else {
      const data = await this.fetchTMDB('/discover/movie', {
        with_genres: genreId,
        with_release_type: '4|5',
        'release_date.lte': today,
        'vote_count.gte': 15,
        sort_by: 'popularity.desc',
        page
      });
      return (data.results || []).map(i => ({ ...i, media_type: 'movie' }));
    }
  },

  // Search Multi (Movies & TV Series)
  async search(query, page = 1) {
    if (!query || query.trim().length === 0) return [];
    const data = await this.fetchTMDB('/search/multi', {
      query: encodeURIComponent(query),
      page,
      include_adult: false
    });
    return (data.results || []).filter(item => (item.media_type === 'movie' || item.media_type === 'tv') && item.poster_path);
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
