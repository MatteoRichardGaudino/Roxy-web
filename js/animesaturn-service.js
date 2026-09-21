/**
 * Roxy - AnimeSaturn Service
 * Connects to the AnimeSaturn Addon service (https://animesaturn.orkhon-pythagorean.ts.net)
 * with graceful offline detection, health monitoring, and direct stream extraction.
 */
const AnimeSaturnService = {
  ADDON_URL: 'https://animesaturn.orkhon-pythagorean.ts.net',
  isOnline: true,
  lastCheckTime: 0,

  init() {
    this.checkHealth();
    // Re-check health every 2 minutes
    setInterval(() => this.checkHealth(), 120000);
  },

  updateStatusBadge(isOnline) {
    this.isOnline = isOnline;
    const badge = document.getElementById('saturn-status-badge');
    if (badge) {
      badge.style.display = isOnline ? 'none' : 'inline-flex';
    }
  },

  async checkHealth() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(`${this.ADDON_URL}/manifest.json`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const ok = res.ok;
      this.updateStatusBadge(ok);
      return ok;
    } catch (err) {
      console.warn('[AnimeSaturn] Health check notice - addon offline:', err.message);
      this.updateStatusBadge(false);
      return false;
    }
  },

  isDubAnime(title, slug) {
    if (!title && !slug) return false;
    const t = (title || '').toLowerCase();
    const s = (slug || '').toLowerCase();

    // Explicit slug indicators on AnimeSaturn (e.g. -ita-, -ita, -dub-)
    if (
      s.includes('-ita-') || s.endsWith('-ita') ||
      s.includes('_ita_') || s.endsWith('_ita') ||
      s.includes('-dub-') || s.endsWith('-dub') ||
      s.includes('_dub_') || s.endsWith('_dub')
    ) {
      return true;
    }

    // Explicit SUB keywords exclude DUB
    const isExplicitSub = t.includes('sub ita') || t.includes('ita sub') || t.includes('(sub)') || t.includes('subtitled');
    if (isExplicitSub) {
      return false;
    }

    // Explicit DUB indicators in title
    if (
      t.includes('(ita)') ||
      t.includes('(dub)') ||
      t.includes('(dub ita)') ||
      t.includes('dub ita') ||
      t.includes('doppiato') ||
      t.includes('italiano') ||
      /\bita\b/.test(t) ||
      /\bdub\b/.test(t)
    ) {
      return true;
    }

    return false;
  },

  cleanAnimeTitle(title) {
    if (!title) return '';
    return title.replace(/\s*\((ITA|SUB|SUB ITA|ITA SUB)\)\s*/gi, '').replace(/\s*(ITA|SUB|DUB)\s*$/gi, '').trim();
  },

  async getLatestAnime() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      // Fetch both DUB and SUB latest catalogs concurrently using proper catalog IDs
      const [dubRes, subRes] = await Promise.allSettled([
        fetch(`${this.ADDON_URL}/catalog/series/animesaturn_dub.json`, { signal: controller.signal }),
        fetch(`${this.ADDON_URL}/catalog/series/animesaturn_sub.json`, { signal: controller.signal })
      ]);
      clearTimeout(timeoutId);

      const items = [];
      const seenSlugs = new Set();

      // Process DUB catalog (all items in this catalog are Italian Dubbed)
      if (dubRes.status === 'fulfilled' && dubRes.value.ok) {
        const dubData = await dubRes.value.json();
        const metas = dubData.metas || [];
        metas.forEach(meta => {
          const rawSlug = (meta.id || '').replace(/^as:/, '');
          if (!rawSlug || seenSlugs.has(rawSlug)) return;
          seenSlugs.add(rawSlug);

          items.push({
            id: `saturn_${rawSlug}`,
            slug: rawSlug,
            source: 'animesaturn',
            title: meta.name || rawSlug,
            name: meta.name || rawSlug,
            media_type: 'anime',
            poster_path: meta.poster || '',
            backdrop_path: meta.background || meta.poster || '',
            vote_average: meta.imdbRating ? parseFloat(meta.imdbRating) : 8.0,
            release_date: meta.releaseInfo || '',
            anime_type: 'Anime',
            isDub: true,
            overview: meta.description || `Anime doppiato in Italiano.`
          });
        });
        this.updateStatusBadge(true);
      }

      // Process SUB catalog (subtitled in Italian)
      if (subRes.status === 'fulfilled' && subRes.value.ok) {
        const subData = await subRes.value.json();
        const metas = subData.metas || [];
        metas.forEach(meta => {
          const rawSlug = (meta.id || '').replace(/^as:/, '');
          if (!rawSlug || seenSlugs.has(rawSlug)) return;
          seenSlugs.add(rawSlug);

          const isDub = this.isDubAnime(meta.name, rawSlug);
          items.push({
            id: `saturn_${rawSlug}`,
            slug: rawSlug,
            source: 'animesaturn',
            title: meta.name || rawSlug,
            name: meta.name || rawSlug,
            media_type: 'anime',
            poster_path: meta.poster || '',
            backdrop_path: meta.background || meta.poster || '',
            vote_average: meta.imdbRating ? parseFloat(meta.imdbRating) : 7.6,
            release_date: meta.releaseInfo || '',
            anime_type: 'Anime',
            isDub: isDub,
            overview: meta.description || `Anime sottotitolato in Italiano.`
          });
        });
        this.updateStatusBadge(true);
      }

      if (items.length > 0) {
        return items;
      }
    } catch (err) {
      console.warn('[AnimeSaturn] getLatestAnime notice - addon offline:', err.message);
      this.updateStatusBadge(false);
    }
    return [];
  },

  async search(query) {
    if (!query || !query.trim()) return [];
    try {
      const q = encodeURIComponent(query.trim());
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const [dubRes, subRes] = await Promise.allSettled([
        fetch(`${this.ADDON_URL}/catalog/series/animesaturn_dub/search=${q}.json`, { signal: controller.signal }),
        fetch(`${this.ADDON_URL}/catalog/series/animesaturn_sub/search=${q}.json`, { signal: controller.signal })
      ]);
      clearTimeout(timeoutId);

      const items = [];
      const seenSlugs = new Set();

      const parseMetas = (metas, isDubCatalog) => {
        (metas || []).forEach(meta => {
          const rawSlug = (meta.id || '').replace(/^as:/, '');
          if (!rawSlug || seenSlugs.has(rawSlug)) return;
          seenSlugs.add(rawSlug);

          const isDub = isDubCatalog || this.isDubAnime(meta.name, rawSlug);
          items.push({
            id: `saturn_${rawSlug}`,
            slug: rawSlug,
            source: 'animesaturn',
            title: meta.name || rawSlug,
            name: meta.name || rawSlug,
            media_type: 'anime',
            poster_path: meta.poster || '',
            backdrop_path: meta.background || meta.poster || '',
            vote_average: meta.imdbRating ? parseFloat(meta.imdbRating) : 7.8,
            release_date: meta.releaseInfo || '',
            anime_type: 'Anime',
            isDub: isDub,
            overview: meta.description || `Anime ${isDub ? 'Doppiato in Italiano' : 'Sottotitolato in Italiano'}.`
          });
        });
      };

      if (dubRes.status === 'fulfilled' && dubRes.value.ok) {
        const d = await dubRes.value.json();
        parseMetas(d.metas, true);
        this.updateStatusBadge(true);
      }
      if (subRes.status === 'fulfilled' && subRes.value.ok) {
        const d = await subRes.value.json();
        parseMetas(d.metas, false);
        this.updateStatusBadge(true);
      }

      // Sort with DUB first, then SUB
      return items.sort((a, b) => {
        if (a.isDub && !b.isDub) return -1;
        if (!a.isDub && b.isDub) return 1;
        return 0;
      });
    } catch (err) {
      console.warn('[AnimeSaturn] search notice - addon offline:', err.message);
      this.updateStatusBadge(false);
      return [];
    }
  },

  async getAnimeDetails(slug) {
    try {
      const cleanSlug = slug.replace(/^saturn_/, '').replace(/^as:/, '');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500);

      const res = await fetch(`${this.ADDON_URL}/meta/series/as:${cleanSlug}.json`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const meta = data.meta || {};

      const isDub = this.isDubAnime(meta.name, cleanSlug);

      const episodes = (meta.videos || []).map(v => ({
        episode_number: v.episode || v.number || 1,
        name: v.title || `Episodio ${v.episode || 1}`,
        still_path: v.thumbnail || meta.background || meta.poster || '',
        overview: v.overview || `Episodio ${v.episode || 1} di ${meta.name}`
      }));

      episodes.sort((a, b) => a.episode_number - b.episode_number);

      this.updateStatusBadge(true);

      return {
        id: `saturn_${cleanSlug}`,
        slug: cleanSlug,
        source: 'animesaturn',
        title: meta.name || cleanSlug,
        name: meta.name || cleanSlug,
        media_type: 'anime',
        poster_path: meta.poster || '',
        backdrop_path: meta.background || meta.poster || '',
        overview: meta.description || 'Nessuna sinossi disponibile.',
        genres: (meta.genres || []).map(g => ({ name: g })),
        status: 'Disponibile',
        original_language: isDub ? 'it' : 'ja',
        isDub: isDub,
        episodes: episodes,
        seasons: [{
          season_number: 1,
          name: isDub ? 'Episodi (DUB ITA)' : 'Episodi (SUB ITA)',
          episode_count: episodes.length
        }]
      };
    } catch (err) {
      console.error('[AnimeSaturn] getAnimeDetails failed:', err);
      this.updateStatusBadge(false);
      return null;
    }
  },

  async resolveStream(slug, epNum = 1) {
    try {
      const cleanSlug = slug.replace(/^saturn_/, '').replace(/^as:/, '');
      const streamEndpoint = `${this.ADDON_URL}/stream/series/as:${cleanSlug}:${epNum}.json`;
      console.log(`[AnimeSaturn] Resolving stream from addon: ${streamEndpoint}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);

      const res = await fetch(streamEndpoint, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data && Array.isArray(data.streams) && data.streams.length > 0) {
        // Find the direct stream first
        const directStream = data.streams.find(s => s.title === 'Diretto' || s.name === 'AnimeSaturn' || !s.url.includes('proxy')) || data.streams[0];
        if (directStream && directStream.url) {
          console.log(`[AnimeSaturn] Successfully resolved direct stream: ${directStream.url}`);
          this.updateStatusBadge(true);
          return {
            type: 'direct',
            streamUrl: directStream.url
          };
        }
      }

      throw new Error('No stream URLs found in response');
    } catch (err) {
      console.error('[AnimeSaturn] resolveStream failed:', err.message);
      this.updateStatusBadge(false);
      return null;
    }
  }
};

window.AnimeSaturnService = AnimeSaturnService;
