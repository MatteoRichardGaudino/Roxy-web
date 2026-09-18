/**
 * Roxy - Domain Manager
 * Synchronizes updated domains for VixSrc and AnimeSaturn from GitHub repositories
 * with local caching and non-blocking background updates.
 */
class DomainManager {
  constructor() {
    this.CACHE_KEY = 'roxy_domains_cache';
    this.VIX_DOMAINS_URL = 'https://raw.githubusercontent.com/qwertyuiop8899/streamvix/main/config/domains.jsonbk';
    this.GITHUB_FILTERS_URL = 'https://raw.githubusercontent.com/LukeSavefrogs/animesaturn-adblock/main/animesaturn_filters.txt';

    this.vixDomain = 'https://vixsrc.to';
    this.saturnDomains = [
      'https://www.animesaturn.net',
      'https://animemars.org',
      'https://www.animesaturn.cx',
      'https://www.animesaturn.cc',
      'https://www.animesaturn.com'
    ];

    this.loadCache();
  }

  loadCache() {
    try {
      const raw = localStorage.getItem(this.CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.vixsrc && typeof cached.vixsrc === 'string') {
          this.vixDomain = cached.vixsrc;
        }
        if (Array.isArray(cached.animesaturn) && cached.animesaturn.length > 0) {
          this.saturnDomains = cached.animesaturn;
        }
      }
    } catch (e) {
      console.warn('[DomainManager] Cache read warning:', e);
    }
  }

  saveCache() {
    try {
      localStorage.setItem(this.CACHE_KEY, JSON.stringify({
        vixsrc: this.vixDomain,
        animesaturn: this.saturnDomains,
        updatedAt: Date.now()
      }));
    } catch (e) {}
  }

  getSaturnDomains() {
    return [...this.saturnDomains];
  }

  getVixDomain() {
    return this.vixDomain;
  }

  applyDomains() {
    if (window.AnimeSaturnService) {
      window.AnimeSaturnService.DOMAINS = this.getSaturnDomains();
    }
    if (window.CONFIG && window.CONFIG.STREAM_PROVIDERS) {
      const base = this.vixDomain.replace(/\/+$/, '');
      CONFIG.STREAM_PROVIDERS.VIXSRC_BASE = base;
      CONFIG.STREAM_PROVIDERS.VIXSRC_API_MOVIE = `${base}/api/movie/{id}?lang=it&primaryColor=6366f1&secondaryColor=1e1e2d&autoplay=true&canPlayFHD=1`;
      CONFIG.STREAM_PROVIDERS.VIXSRC_API_TV = `${base}/api/tv/{id}/{season}/{episode}?lang=it&primaryColor=6366f1&secondaryColor=1e1e2d&autoplay=true&canPlayFHD=1`;
      CONFIG.STREAM_PROVIDERS.VIXSRC_MOVIE = `${base}/movie/{id}?primaryColor=6366f1&secondaryColor=1e1e2d&lang=it&autoplay=true`;
      CONFIG.STREAM_PROVIDERS.VIXSRC_TV = `${base}/tv/{id}/{season}/{episode}?primaryColor=6366f1&secondaryColor=1e1e2d&lang=it&autoplay=true`;
    }
    if (window.CONFIG && window.CONFIG.CATALOG_LIST) {
      const base = this.vixDomain.replace(/\/+$/, '');
      CONFIG.CATALOG_LIST.MOVIE = `${base}/api/list/movie?lang=it`;
      CONFIG.CATALOG_LIST.TV = `${base}/api/list/tv?lang=it`;
      CONFIG.CATALOG_LIST.EPISODE = `${base}/api/list/episode?lang=it`;
    }
  }

  async syncFromGithub() {
    this.applyDomains();

    // Run network check in background with short timeout
    const fetchWithTimeout = async (url, timeoutMs = 3500) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        return res;
      } catch (err) {
        clearTimeout(id);
        throw err;
      }
    };

    try {
      // 1. VixSrc domain from streamvix repo
      try {
        const vixRes = await fetchWithTimeout(this.VIX_DOMAINS_URL, 3500);
        if (vixRes.ok) {
          const data = await vixRes.json();
          if (data && data.vixsrc) {
            const clean = data.vixsrc.trim().replace(/\/+$/, '');
            this.vixDomain = clean.startsWith('http') ? clean : `https://${clean}`;
            console.log(`[DomainManager] VixSrc domain synced from GitHub: ${this.vixDomain}`);
          }
        }
      } catch (err) {
        console.warn('[DomainManager] VixSrc domain sync notice:', err.message);
      }

      // 2. AnimeSaturn domains from animesaturn-adblock repo
      try {
        const saturnRes = await fetchWithTimeout(this.GITHUB_FILTERS_URL, 3500);
        if (saturnRes.ok) {
          const text = await saturnRes.text();
          const newDomains = [];
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.includes('##') && !line.startsWith('!')) {
              const raw = line.split('##')[0].split(',');
              for (const d of raw) {
                const clean = d.trim();
                if (clean && (clean.includes('animesaturn') || clean.includes('animemars'))) {
                  let norm = clean.startsWith('http') ? clean : `https://${clean}`;
                  if (!norm.includes('www.') && !norm.includes('animemars')) {
                    norm = norm.replace('https://', 'https://www.');
                  }
                  if (!newDomains.includes(norm)) newDomains.push(norm);
                }
              }
              if (newDomains.length > 0) break;
            }
          }
          if (newDomains.length > 0) {
            this.saturnDomains = newDomains;
            console.log(`[DomainManager] AnimeSaturn domains synced from GitHub:`, this.saturnDomains);
          }
        }
      } catch (err) {
        console.warn('[DomainManager] AnimeSaturn domain sync notice:', err.message);
      }

      this.saveCache();
      this.applyDomains();
    } catch (e) {
      console.warn('[DomainManager] Sync error:', e);
    }
  }
}

window.DomainManager = new DomainManager();
