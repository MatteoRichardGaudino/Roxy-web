/**
 * Roxy - Configuration & Constants for LG webOS
 */
const CONFIG = {
  APP_NAME: 'Roxy',
  VERSION: '1.0.0',
  
  // TMDB API Configuration
  TMDB: {
    API_KEY: 'ebb42547710ed9b3dcfe11d1111d42d7',
    BASE_URL: 'https://api.themoviedb.org/3',
    IMAGE_BASE_POSTER: 'https://image.tmdb.org/t/p/w500',
    IMAGE_BASE_BACKDROP: 'https://image.tmdb.org/t/p/w1280',
    IMAGE_BASE_ORIGINAL: 'https://image.tmdb.org/t/p/original',
    LANGUAGE: 'it-IT',
    FALLBACK_LANGUAGE: 'en-US'
  },

  // Remote Control Key Codes (webOS & Standard Keyboard)
  KEYS: {
    // Arrow Navigation
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    
    // Action / Enter
    ENTER: 13,
    
    // Back Keys (webOS TV sends 461, browsers send 27/8)
    BACK_WEBOS: 461,
    BACK_ESC: 27,
    BACK_BACKSPACE: 8,
    
    // Media Playback Keys on LG Magic Remote
    PLAY: 415,
    PAUSE: 19,
    PLAY_PAUSE: 179,
    STOP: 413,
    FAST_FORWARD: 417,
    REWIND: 412,
    
    // LG Color Keys
    RED: 403,
    GREEN: 404,
    YELLOW: 405,
    BLUE: 406
  },

  // Genre IDs Mapping for TMDB
  GENRES: {
    ACTION: 28,
    ADVENTURE: 12,
    ANIMATION: 16,
    COMEDY: 35,
    CRIME: 80,
    DOCUMENTARY: 99,
    DRAMA: 18,
    FAMILY: 10751,
    FANTASY: 14,
    HORROR: 27,
    SCI_FI: 878,
    THRILLER: 53,
    ROMANCE: 10749
  },

  // VixSrc Catalog List API Endpoints (Italian language filter)
  CATALOG_LIST: {
    MOVIE: 'https://vixsrc.to/api/list/movie?lang=it',
    TV: 'https://vixsrc.to/api/list/tv?lang=it',
    EPISODE: 'https://vixsrc.to/api/list/episode?lang=it'
  },

  // Stream Provider Templates (vixsrc integration with OLED theme & Italian audio)
  STREAM_PROVIDERS: {
    VIXSRC_API_MOVIE: 'https://vixsrc.to/api/movie/{id}?lang=it&primaryColor=6366f1&secondaryColor=1e1e2d&autoplay=true&canPlayFHD=1',
    VIXSRC_API_TV: 'https://vixsrc.to/api/tv/{id}/{season}/{episode}?lang=it&primaryColor=6366f1&secondaryColor=1e1e2d&autoplay=true&canPlayFHD=1',
    VIXSRC_MOVIE: 'https://vixsrc.to/movie/{id}?primaryColor=6366f1&secondaryColor=1e1e2d&lang=it&autoplay=true',
    VIXSRC_TV: 'https://vixsrc.to/tv/{id}/{season}/{episode}?primaryColor=6366f1&secondaryColor=1e1e2d&lang=it&autoplay=true',
    VIXSRC_BASE: 'https://vixsrc.to'
  }
};

window.CONFIG = CONFIG;
