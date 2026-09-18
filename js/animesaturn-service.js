/**
 * Roxy - AnimeSaturn Service
 * Scrapes anime catalog, details, episodes, and resolves direct video streams from SaturnCDN
 */
const AnimeSaturnService = {
  DOMAINS: [
    'https://www.animesaturn.net',
    'https://animemars.org',
    'https://www.animesaturn.cx',
    'https://www.animesaturn.cc',
    'https://www.animesaturn.com'
  ],
  currentDomainIndex: 0,

  getBaseUrl() {
    const domains = (window.DomainManager && window.DomainManager.saturnDomains && window.DomainManager.saturnDomains.length > 0)
      ? window.DomainManager.saturnDomains
      : this.DOMAINS;
    return domains[this.currentDomainIndex] || domains[0];
  },

  isDubAnime(title, slug) {
    if (!title && !slug) return false;
    const t = (title || '').toLowerCase();
    const s = (slug || '').toLowerCase();
    if (t.includes('(ita)') || t.includes(' ita') || t.includes('doppiato') || t.includes('italiano')) return true;
    if (s.includes('-ita-') || s.endsWith('-ita') || s.includes('_ita_') || s.endsWith('_ita')) return true;
    return false;
  },

  cleanAnimeTitle(title) {
    if (!title) return '';
    return title.replace(/\s*\((ITA|SUB|SUB ITA|ITA SUB)\)\s*/gi, '').replace(/\s*(ITA|SUB|DUB)\s*$/gi, '').trim();
  },

  decodeSaturnResponse(encodedData, token) {
    try {
      const binaryString = atob(encodedData);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i) ^ token.charCodeAt(i % token.length);
      }
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      console.error('[AnimeSaturn] XOR decode error:', e);
      return '';
    }
  },

  async fetchWithFallback(path, options = {}) {
    const domains = (window.DomainManager && window.DomainManager.saturnDomains && window.DomainManager.saturnDomains.length > 0)
      ? window.DomainManager.saturnDomains
      : this.DOMAINS;

    for (let i = 0; i < domains.length; i++) {
      const idx = (this.currentDomainIndex + i) % domains.length;
      const domain = domains[idx];
      const url = domain + (path.startsWith('/') ? path : '/' + path);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 3500);

      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
            ...(options.headers || {})
          },
          ...options
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          this.currentDomainIndex = idx;
          const html = await res.text();
          return { html, baseUrl: domain, status: res.status };
        }
      } catch (err) {
        clearTimeout(timeoutId);
        console.warn(`[AnimeSaturn] Error/timeout on ${domain}:`, err.message);
      }
    }
    throw new Error('All AnimeSaturn domains unreachable.');
  },

  async getLatestAnime() {
    try {
      const { html, baseUrl } = await this.fetchWithFallback('/filter?sort=update');
      return this.parseAnimeCards(html, baseUrl);
    } catch (err) {
      console.error('[AnimeSaturn] getLatestAnime failed:', err);
      return [];
    }
  },

  async search(query) {
    if (!query || !query.trim()) return [];
    try {
      const path = `/filter?key=${encodeURIComponent(query.trim())}`;
      const { html, baseUrl } = await this.fetchWithFallback(path);
      return this.parseAnimeCards(html, baseUrl);
    } catch (err) {
      console.error('[AnimeSaturn] search failed:', err);
      return [];
    }
  },

  parseAnimeCards(html, baseUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const cards = doc.querySelectorAll('a.ac.group');
    const items = [];

    cards.forEach(card => {
      const href = card.getAttribute('href') || '';
      if (!href || !href.includes('/anime/')) return;

      const slug = href.replace(/\/$/, '').split('/').pop();
      const titleTag = card.querySelector('h3.ac__title');
      const title = titleTag ? titleTag.textContent.trim() : slug;

      const posterTag = card.querySelector('img');
      let poster = '';
      if (posterTag) {
        poster = posterTag.getAttribute('src') || posterTag.getAttribute('data-src') || '';
        if (poster && poster.startsWith('/')) poster = baseUrl + poster;
      }

      const typeTag = card.querySelector('span.ac__type-badge');
      const typeStr = typeTag ? typeTag.textContent.trim() : 'TV';

      const scoreTag = card.querySelector('span.ac__score');
      const scoreText = scoreTag ? scoreTag.textContent.trim() : '';
      const vote_average = parseFloat(scoreText.replace(/[^0-9.]/g, '')) || 7.5;

      const subTag = card.querySelector('p.ac__sub');
      const subInfo = subTag ? subTag.textContent.trim() : '';

      const isDub = this.isDubAnime(title, slug);

      items.push({
        id: `saturn_${slug}`,
        slug: slug,
        source: 'animesaturn',
        title: title,
        name: title,
        media_type: 'anime',
        poster_path: poster,
        backdrop_path: poster,
        vote_average: vote_average,
        release_date: subInfo.split('·')[0]?.trim() || '',
        sub_info: subInfo,
        anime_type: typeStr,
        isDub: isDub,
        overview: `Anime ${typeStr} • ${subInfo} • ${isDub ? 'Doppiato in Italiano' : 'Sottotitolato in Italiano'}`
      });
    });

    // Sort prioritizing DUB (Italian audio) first, then SUB
    return items.sort((a, b) => {
      if (a.isDub && !b.isDub) return -1;
      if (!a.isDub && b.isDub) return 1;
      return 0;
    });
  },

  async getAnimeDetails(slug) {
    try {
      const { html, baseUrl } = await this.fetchWithFallback(`/anime/${slug}`);
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const titleEl = doc.querySelector('h1');
      const title = titleEl ? titleEl.textContent.trim() : slug;

      const posterEl = doc.querySelector('img[src*="locandine"]') || doc.querySelector('.anime-poster img') || doc.querySelector('img');
      let poster = posterEl ? (posterEl.getAttribute('src') || posterEl.getAttribute('data-src') || '') : '';
      if (poster && poster.startsWith('/')) poster = baseUrl + poster;

      const bgEl = doc.querySelector('img.anime-hero__bg') || doc.querySelector('img[src*="background"]');
      let backdrop = bgEl ? (bgEl.getAttribute('src') || bgEl.getAttribute('data-src') || '') : poster;
      if (backdrop && backdrop.startsWith('/')) backdrop = baseUrl + backdrop;

      const descEl = doc.querySelector('.story-clip') || doc.querySelector('.ag-story div') || doc.querySelector('#synopsis');
      const overview = descEl ? descEl.textContent.trim() : 'Nessuna sinossi disponibile.';

      const genreEls = doc.querySelectorAll('a[href*="/genres/"], a[href*="/genere/"]');
      const genres = Array.from(genreEls).map(g => ({ name: g.textContent.trim() })).filter(g => g.name);

      // Extract episodes
      const epTiles = doc.querySelectorAll('a.ep-tile, a[href*="/ep-"]');
      const episodes = [];
      const seenNums = new Set();

      epTiles.forEach(ep => {
        const href = ep.getAttribute('href') || '';
        const epTitle = ep.getAttribute('title') || ep.textContent.trim();
        const numMatch = href.match(/ep-(\d+)/i) || ep.textContent.match(/(\d+)/);
        const epNum = numMatch ? parseInt(numMatch[1]) : (episodes.length + 1);

        if (!seenNums.has(epNum)) {
          seenNums.add(epNum);
          const watchHref = href.replace('/episode/', '/anime/');
          episodes.push({
            episode_number: epNum,
            name: epTitle || `Episodio ${epNum}`,
            href: href,
            watchHref: watchHref.startsWith('http') ? watchHref : (baseUrl + watchHref),
            still_path: backdrop || poster,
            overview: `Episodio ${epNum} di ${title}`
          });
        }
      });

      episodes.sort((a, b) => a.episode_number - b.episode_number);

      const isDub = this.isDubAnime(title, slug);

      return {
        id: `saturn_${slug}`,
        slug: slug,
        source: 'animesaturn',
        title: title,
        name: title,
        media_type: 'anime',
        poster_path: poster,
        backdrop_path: backdrop,
        overview: overview,
        genres: genres.length > 0 ? genres : [{ name: 'Anime' }, { name: isDub ? 'Dub ITA' : 'Sub ITA' }],
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
      console.error('[AnimeSaturn] getAnimeDetails error:', err);
      return null;
    }
  },

  async resolveStream(slug, epNum = 1) {
    try {
      const baseUrl = this.getBaseUrl();
      const watchPath = `/anime/${slug}/ep-${epNum}`;
      console.log(`[AnimeSaturn] Resolving stream from ${watchPath}...`);

      const { html } = await this.fetchWithFallback(watchPath);
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const iframe = doc.querySelector('iframe#watch-iframe') || doc.querySelector('iframe[src*="saturncdn"]');
      if (!iframe) {
        throw new Error('Watch iframe not found in page');
      }

      let iframeSrc = iframe.getAttribute('src') || '';
      if (iframeSrc.startsWith('//')) iframeSrc = 'https:' + iframeSrc;

      const u = new URL(iframeSrc);
      const token = u.searchParams.get('token');
      const expires = u.searchParams.get('expires');

      if (!token) {
        return { type: 'iframe', streamUrl: iframeSrc };
      }

      const playlistUrl = `${u.origin}${u.pathname}/playlist?token=${token}` + (expires ? `&expires=${expires}` : '');
      console.log(`[AnimeSaturn] Fetching playlist: ${playlistUrl}`);

      const playRes = await fetch(playlistUrl, {
        headers: {
          'Referer': 'https://play.saturncdn.net'
        }
      });

      if (!playRes.ok) {
        return { type: 'iframe', streamUrl: iframeSrc };
      }

      const playData = await playRes.json();
      if (playData && playData.d) {
        const directVideoUrl = this.decodeSaturnResponse(playData.d, token);
        console.log(`[AnimeSaturn] Resolved direct video stream URL: ${directVideoUrl}`);
        return {
          type: 'direct',
          streamUrl: directVideoUrl,
          iframeFallback: iframeSrc
        };
      }

      return { type: 'iframe', streamUrl: iframeSrc };
    } catch (err) {
      console.error('[AnimeSaturn] resolveStream failed:', err);
      return null;
    }
  }
};

window.AnimeSaturnService = AnimeSaturnService;
