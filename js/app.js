/**
 * Roxy - Main Application Controller
 * Handles UI views, TMDB catalog loading, Netflix-style billboard & rows, and modals
 */
class RoxyApp {
  constructor() {
    this.currentSection = 'home';
    this.heroIndex = 0;
    this.heroItems = [];
    this.heroTimer = null;
    this.lastFocusedElement = null;
    this.searchDebounceTimer = null;

    this.init();
  }

  async init() {
    console.log('Initializing Roxy Streaming Player...');
    
    // Initialize services
    window.navigatorInstance = new SpatialNavigator();
    WebOSBridge.init();
    PlayerController.init();

    this.bindHeaderEvents();
    this.bindModalEvents();
    this.bindSearchEvents();

    // 1. Sync VixSrc Italian catalog list first
    await CatalogService.init();

    // 2. Load initial home page catalog (only available items)
    await this.loadHomeCatalog();

    // Set initial focus to the Hero Play Button
    setTimeout(() => {
      const initialFocus = document.querySelector('.hero-actions .btn-primary-play') || 
                           document.querySelector('.hero-actions .btn-unavailable') || 
                           document.querySelector('.nav-item');
      if (initialFocus) {
        window.navigatorInstance.setFocus(initialFocus);
      }
    }, 400);
  }

  // =========================================================================
  // Navigation & Routing
  // =========================================================================
  bindHeaderEvents() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', (e) => {
        const targetSection = item.getAttribute('data-section');
        if (targetSection) {
          this.switchSection(targetSection);
        }
      });
    });

    const searchTrigger = document.getElementById('nav-search-btn');
    if (searchTrigger) {
      searchTrigger.addEventListener('click', () => this.switchSection('search'));
    }

    // Scroll listener for sticky header background
    const viewContainer = document.querySelector('.view-container');
    const header = document.querySelector('.top-header');
    if (viewContainer && header) {
      viewContainer.addEventListener('scroll', () => {
        if (viewContainer.scrollTop > 40) {
          header.classList.add('scrolled');
        } else {
          header.classList.remove('scrolled');
        }
      });
    }
  }

  switchSection(sectionName) {
    this.currentSection = sectionName;

    // Update active nav button
    document.querySelectorAll('.nav-item').forEach(btn => {
      if (btn.getAttribute('data-section') === sectionName) {
        btn.classList.add('nav-active');
      } else {
        btn.classList.remove('nav-active');
      }
    });

    // Toggle section containers
    document.querySelectorAll('.view-section').forEach(sec => {
      sec.classList.remove('active');
    });

    const targetView = document.getElementById(`view-${sectionName}`);
    if (targetView) {
      targetView.classList.add('active');
    }

    // Reset scroll to top
    const viewContainer = document.querySelector('.view-container');
    if (viewContainer) viewContainer.scrollTop = 0;

    // Load section content if needed
    if (sectionName === 'movies') {
      this.loadMoviesCatalog();
    } else if (sectionName === 'tv') {
      this.loadTVCatalog();
    } else if (sectionName === 'watchlist') {
      this.renderWatchlist();
    } else if (sectionName === 'search') {
      setTimeout(() => {
        const wrapper = document.querySelector('.search-input-wrapper');
        const input = document.getElementById('search-input');
        if (wrapper) {
          window.navigatorInstance.setFocus(wrapper);
        }
        if (input) {
          input.focus();
        }
      }, 150);
      return;
    }

    // Focus first navigable in view
    setTimeout(() => {
      const firstNav = targetView ? targetView.querySelector('.navigable') : null;
      if (firstNav) {
        window.navigatorInstance.setFocus(firstNav);
      }
    }, 200);
  }

  // =========================================================================
  // Home Page Catalog Loading (Intersected with VixSrc Italian Catalog)
  // =========================================================================
  async loadHomeCatalog() {
    try {
      // 1. Fetch data concurrently from TMDB
      const [trending, popularMovies, allTimePopular, popularTV, topRated, actionMovies, sciFiMovies, animation] = await Promise.all([
        TMDBService.getTrending('day'),
        TMDBService.getPopularMovies(),
        TMDBService.getAllTimePopularMovies(),
        TMDBService.getPopularTV(),
        TMDBService.getTopRatedMovies(),
        TMDBService.getByGenre(CONFIG.GENRES.ACTION, 'movie', Math.floor(Math.random() * 2) + 1),
        TMDBService.getByGenre(CONFIG.GENRES.SCI_FI, 'movie', Math.floor(Math.random() * 2) + 1),
        TMDBService.getByGenre(CONFIG.GENRES.ANIMATION, 'movie')
      ]);

      // 2. Filter every collection with CatalogService to display only available items on homepage
      const availTrending = CatalogService.filterAvailable(trending);
      const availPopularMovies = CatalogService.filterAvailable(popularMovies);
      const availAllTime = CatalogService.filterAvailable(allTimePopular);
      const availPopularTV = CatalogService.filterAvailable(popularTV);
      const availTopRated = CatalogService.filterAvailable(topRated);
      const availAction = CatalogService.filterAvailable(actionMovies);
      const availSciFi = CatalogService.filterAvailable(sciFiMovies);
      const availAnimation = CatalogService.filterAvailable(animation);

      // 3. Randomized Hero Billboard: mix of available popular released movies and trending shows
      const heroPool = [...availPopularMovies.slice(0, 6), ...availAllTime.slice(0, 6), ...availTrending.slice(0, 6)];
      this.heroItems = TMDBService.shuffle(heroPool.filter(i => i.backdrop_path)).slice(0, 8);
      this.renderHeroBillboard();

      // 4. Render Continue Watching Row
      this.renderContinueWatchingRow();

      // 5. Create a dynamic randomized mix for "Scelti per Te"
      const mixedPicks = TMDBService.shuffle([...availPopularMovies.slice(0, 10), ...availAllTime.slice(0, 10)]);

      // 6. Render Horizontal Rows with available contents
      this.renderRow('I Più Popolari in Streaming Oggi', availTrending.slice(0, 18), 'home-rows-container');
      this.renderRow('Grandi Successi di Sempre', availAllTime, 'home-rows-container');
      this.renderRow('Serie TV del Momento', availPopularTV, 'home-rows-container');
      this.renderRow('Scelti per Te (Mix Consigliati)', mixedPicks, 'home-rows-container');
      this.renderRow('Film da Non Perdere', availPopularMovies, 'home-rows-container');
      this.renderRow('I Più Votati dalla Critica', availTopRated, 'home-rows-container');
      this.renderRow('Azione & Avventura Esplosiva', availAction, 'home-rows-container');
      this.renderRow('Fantascienza & Mondi Futuri', availSciFi, 'home-rows-container');
      this.renderRow('Animazione per Tutti', availAnimation, 'home-rows-container');

    } catch (e) {
      console.error('Failed to load home catalog:', e);
    }
  }

  // =========================================================================
  // Movies Section Catalog
  // =========================================================================
  async loadMoviesCatalog() {
    const container = document.getElementById('movies-rows-container');
    if (!container || container.children.length > 0) return;

    try {
      const [popular, topRated, thriller, comedy, horror] = await Promise.all([
        TMDBService.getPopularMovies(),
        TMDBService.getTopRatedMovies(),
        TMDBService.getByGenre(CONFIG.GENRES.THRILLER, 'movie'),
        TMDBService.getByGenre(CONFIG.GENRES.COMEDY, 'movie'),
        TMDBService.getByGenre(CONFIG.GENRES.HORROR, 'movie')
      ]);

      this.renderRow('Film Popolari', CatalogService.filterAvailable(popular), 'movies-rows-container');
      this.renderRow('Capolavori del Cinema', CatalogService.filterAvailable(topRated), 'movies-rows-container');
      this.renderRow('Brividi & Thriller ad Alta Tensione', CatalogService.filterAvailable(thriller), 'movies-rows-container');
      this.renderRow('Commedie & Risate', CatalogService.filterAvailable(comedy), 'movies-rows-container');
      this.renderRow('Horror & Mistero', CatalogService.filterAvailable(horror), 'movies-rows-container');
    } catch (e) {
      console.error('Failed to load movies catalog:', e);
    }
  }

  // =========================================================================
  // TV Shows Section Catalog
  // =========================================================================
  async loadTVCatalog() {
    const container = document.getElementById('tv-rows-container');
    if (!container || container.children.length > 0) return;

    try {
      const [popular, topRated, drama, sciFi, crime] = await Promise.all([
        TMDBService.getPopularTV(),
        TMDBService.fetchTMDB('/tv/top_rated'),
        TMDBService.getByGenre(CONFIG.GENRES.DRAMA, 'tv'),
        TMDBService.getByGenre(CONFIG.GENRES.SCI_FI, 'tv'),
        TMDBService.getByGenre(CONFIG.GENRES.CRIME, 'tv')
      ]);

      this.renderRow('Serie TV del Momento', CatalogService.filterAvailable(popular), 'tv-rows-container');
      this.renderRow('Le Migliori Serie di Sempre', CatalogService.filterAvailable(topRated.results || []), 'tv-rows-container');
      this.renderRow('Drammi Avvincenti', CatalogService.filterAvailable(drama), 'tv-rows-container');
      this.renderRow('Fantascienza & Mistero Seriale', CatalogService.filterAvailable(sciFi), 'tv-rows-container');
      this.renderRow('Crime & Polizieschi', CatalogService.filterAvailable(crime), 'tv-rows-container');
    } catch (e) {
      console.error('Failed to load TV catalog:', e);
    }
  }

  // =========================================================================
  // Hero Billboard Logic
  // =========================================================================
  renderHeroBillboard() {
    if (!this.heroItems || this.heroItems.length === 0) return;
    const item = this.heroItems[this.heroIndex];

    const backdropImg = document.getElementById('hero-backdrop');
    const titleEl = document.getElementById('hero-title');
    const overviewEl = document.getElementById('hero-overview');
    const badgesContainer = document.getElementById('hero-badges');
    const btnPlay = document.getElementById('hero-btn-play');
    const btnInfo = document.getElementById('hero-btn-info');
    const btnWatchlist = document.getElementById('hero-btn-watchlist');

    if (backdropImg) {
      backdropImg.src = TMDBService.getOriginalUrl(item.backdrop_path);
    }

    if (titleEl) {
      titleEl.textContent = item.title || item.name || '';
    }

    if (overviewEl) {
      overviewEl.textContent = item.overview || 'Nessuna descrizione disponibile per questo titolo.';
    }

    if (badgesContainer) {
      const year = (item.release_date || item.first_air_date || '').substring(0, 4);
      const rating = item.vote_average ? item.vote_average.toFixed(1) : '7.5';
      const typeLabel = (item.media_type === 'tv' || item.name) ? 'SERIE TV' : 'FILM';

      badgesContainer.innerHTML = `
        <span class="badge-indigo">${typeLabel}</span>
        <span class="badge-rating">★ ${rating}</span>
        <span class="badge-quality">4K ULTRA HD</span>
        <span class="badge-quality">5.1 SURROUND</span>
        ${year ? `<span style="color: var(--text-med); font-weight: 600;">${year}</span>` : ''}
      `;
    }

    const isAvailable = CatalogService.isItemAvailable(item);

    // Action buttons click listeners
    if (btnPlay) {
      if (isAvailable) {
        btnPlay.className = 'btn-primary-play navigable';
        btnPlay.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Riproduci`;
        btnPlay.onclick = () => PlayerController.play(item);
      } else {
        btnPlay.className = 'btn-unavailable navigable';
        btnPlay.innerHTML = `<span style="font-weight:900;margin-right:6px;">✕</span> Non disponibile`;
        btnPlay.onclick = () => this.showToast('Questo contenuto non è attualmente disponibile per lo streaming in italiano.');
      }
    }

    if (btnInfo) {
      btnInfo.onclick = () => this.openDetailsModal(item);
    }

    if (btnWatchlist) {
      const inList = StorageService.isInWatchlist(item.id);
      btnWatchlist.innerHTML = inList ? '✓ Nella Lista' : '+ La Mia Lista';
      btnWatchlist.onclick = () => {
        const added = StorageService.toggleWatchlist(item);
        btnWatchlist.innerHTML = added ? '✓ Nella Lista' : '+ La Mia Lista';
        this.showToast(added ? `"${item.title || item.name}" aggiunto a La mia lista` : 'Rimosso da La mia lista');
      };
    }

    // Render Indicator Dots
    const dotsContainer = document.getElementById('hero-dots');
    if (dotsContainer) {
      dotsContainer.innerHTML = this.heroItems.map((_, i) => 
        `<div class="hero-dot ${i === this.heroIndex ? 'active' : ''}"></div>`
      ).join('');
    }

    // Auto rotate every 9 seconds
    if (this.heroTimer) clearInterval(this.heroTimer);
    this.heroTimer = setInterval(() => {
      // Rotate hero only if no modal or player is open
      if (!window.navigatorInstance.isModalOpen && !PlayerController.isActive) {
        this.heroIndex = (this.heroIndex + 1) % this.heroItems.length;
        this.renderHeroBillboard();
      }
    }, 9000);
  }

  // =========================================================================
  // Continue Watching Row (Real Progress & Exact Resume Point)
  // =========================================================================
  renderContinueWatchingRow() {
    const list = StorageService.getContinueWatching();
    let container = document.getElementById('continue-watching-row');
    
    if (list.length === 0) {
      if (container) container.remove();
      return;
    }

    const rowsWrapper = document.getElementById('home-rows-container');
    if (!rowsWrapper) return;

    if (!container) {
      container = document.createElement('div');
      container.id = 'continue-watching-row';
      container.className = 'content-row';
      rowsWrapper.insertBefore(container, rowsWrapper.firstChild);
    }

    container.innerHTML = `
      <div class="row-header">
        <h2 class="row-title">Continua a Guardare</h2>
      </div>
      <div class="row-carousel" id="carousel-continue">
        ${list.map(item => {
          const progressPercent = item.progress || (item.duration > 0 ? Math.round((item.currentTime / item.duration) * 100) : 0);
          const currentMins = Math.floor((item.currentTime || 0) / 60);
          const durMins = Math.floor((item.duration || 0) / 60);
          const timeText = (durMins > 0) ? `${currentMins}/${durMins} min` : (currentMins > 0 ? `${currentMins} min` : '');
          const isTv = (item.media_type === 'tv');
          const subInfo = isTv ? `S${item.season || 1}:E${item.episode || 1}` : '';

          return `
          <div class="continue-card navigable" tabindex="0" data-id="${item.id}" data-type="${item.media_type}">
            <img src="${TMDBService.getBackdropUrl(item.backdrop_path || item.poster_path)}" alt="${item.title}" loading="lazy" />
            <div class="card-play-indicator">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
            </div>
            <div class="continue-overlay">
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <span style="font-size: 0.75rem; color: #a5b4fc; font-weight: 600;">${subInfo}</span>
                <span class="badge-indigo" style="font-size: 0.75rem;">${isTv ? 'SERIE' : 'FILM'}</span>
              </div>
              <div>
                <div class="card-title">${item.title}</div>
                <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 4px;">
                  <span>${progressPercent}%</span>
                  <span>${timeText}</span>
                </div>
                <div class="continue-progress-bar">
                  <div class="continue-progress-fill" style="width: ${progressPercent}%"></div>
                </div>
              </div>
            </div>
          </div>
        `}).join('')}
      </div>
    `;

    // Attach click events: Play button starts playback directly, clicking the card body opens details modal
    container.querySelectorAll('.continue-card').forEach(card => {
      const id = parseInt(card.getAttribute('data-id'));
      const item = list.find(i => i.id === id);
      if (item) {
        const playBtn = card.querySelector('.card-play-indicator');
        if (playBtn) {
          playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.lastFocusedElement = card;
            PlayerController.play(item, null, item.currentTime || 0);
          });
        }
        card.addEventListener('click', () => {
          this.lastFocusedElement = card;
          this.openDetailsModal(item);
        });
      }
    });
  }

  // =========================================================================
  // Horizontal Content Rows
  // =========================================================================
  renderRow(title, items, targetContainerId) {
    if (!items || items.length === 0) return;
    const parent = document.getElementById(targetContainerId);
    if (!parent) return;

    const row = document.createElement('div');
    row.className = 'content-row';

    const rowId = `row-${Math.random().toString(36).substr(2, 9)}`;

    row.innerHTML = `
      <div class="row-header">
        <h2 class="row-title">${title}</h2>
      </div>
      <div class="row-carousel" id="${rowId}">
        ${items.filter(i => i.poster_path).map(item => {
          const isAvailable = CatalogService.isItemAvailable(item);
          return `
          <div class="media-card navigable ${isAvailable ? '' : 'unavailable'}" tabindex="0" data-id="${item.id}" data-type="${item.media_type || 'movie'}">
            <div class="card-badge-top">
              ${isAvailable ? `<span class="badge-rating">★ ${(item.vote_average || 7.0).toFixed(1)}</span>` : `<span class="badge-unavailable">Non disp.</span>`}
            </div>
            <img src="${TMDBService.getPosterUrl(item.poster_path)}" alt="${item.title || item.name}" loading="lazy" />
            ${isAvailable ? `
            <div class="card-play-indicator">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
            </div>` : ''}
            <div class="card-overlay">
              <div class="card-title">${item.title || item.name}</div>
              <div class="card-meta">
                <span>${(item.release_date || item.first_air_date || '').substring(0, 4)}</span>
                <span>•</span>
                <span>${item.media_type === 'tv' || item.name ? 'Serie TV' : 'Film'}</span>
              </div>
            </div>
          </div>
        `}).join('')}
      </div>
    `;

    parent.appendChild(row);

    // Attach click listeners: play button starts playback, card body opens details modal
    row.querySelectorAll('.media-card').forEach(card => {
      const id = parseInt(card.getAttribute('data-id'));
      const item = items.find(i => i.id === id);
      if (item) {
        const playBtn = card.querySelector('.card-play-indicator');
        if (playBtn) {
          playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!CatalogService.isItemAvailable(item)) {
              this.showToast('Questo contenuto non è attualmente disponibile per lo streaming in italiano.');
              return;
            }
            this.lastFocusedElement = card;
            PlayerController.play(item);
          });
        }
        card.addEventListener('click', () => {
          this.lastFocusedElement = card;
          this.openDetailsModal(item);
        });
      }
    });
  }

  // =========================================================================
  // Details Modal (Availability verification & Episode Selector)
  // =========================================================================
  bindModalEvents() {
    const modalCloseBtn = document.getElementById('modal-btn-close');
    if (modalCloseBtn) {
      modalCloseBtn.addEventListener('click', () => this.closeModal());
    }

    const backdrop = document.getElementById('details-modal');
    if (backdrop) {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) this.closeModal();
      });
    }
  }

  async openDetailsModal(item) {
    const modal = document.getElementById('details-modal');
    if (!modal) return;

    this.lastFocusedElement = document.activeElement;

    // Fetch full details
    const mediaType = item.media_type || (item.name ? 'tv' : 'movie');
    const fullDetails = await TMDBService.getDetails(item.id, mediaType);
    const data = fullDetails || item;

    // Verify availability against VixSrc catalog list
    const isAvailable = CatalogService.isItemAvailable(data);

    // Populate Modal DOM
    const backdropImg = document.getElementById('modal-backdrop-img');
    const titleEl = document.getElementById('modal-title');
    const badgesEl = document.getElementById('modal-badges');
    const overviewEl = document.getElementById('modal-overview');
    const gridEl = document.getElementById('modal-meta-grid');
    const btnPlay = document.getElementById('modal-btn-play');
    const btnWatchlist = document.getElementById('modal-btn-watchlist');

    if (backdropImg) {
      backdropImg.src = TMDBService.getBackdropUrl(data.backdrop_path || data.poster_path);
    }

    if (titleEl) {
      titleEl.textContent = data.title || data.name || '';
    }

    if (badgesEl) {
      const year = (data.release_date || data.first_air_date || '').substring(0, 4);
      const rating = data.vote_average ? data.vote_average.toFixed(1) : '7.5';
      const duration = data.runtime ? `${data.runtime} min` : (data.number_of_seasons ? `${data.number_of_seasons} Stagioni` : '');

      badgesEl.innerHTML = `
        <span class="badge-indigo">${mediaType === 'tv' ? 'SERIE TV' : 'FILM'}</span>
        ${!isAvailable ? `<span class="badge-unavailable">NON DISPONIBILE</span>` : ''}
        <span class="badge-rating">★ ${rating}</span>
        <span class="badge-quality">4K HDR</span>
        ${duration ? `<span class="badge-quality">${duration}</span>` : ''}
        ${year ? `<span style="color: var(--text-med); font-weight: 600;">${year}</span>` : ''}
      `;
    }

    if (overviewEl) {
      overviewEl.textContent = data.overview || 'Nessuna sinossi disponibile.';
    }

    if (gridEl) {
      const genresStr = (data.genres || []).map(g => g.name).join(', ') || 'Generale';
      const statusStr = data.status || 'Rilasciato';
      const langStr = (data.original_language || 'it').toUpperCase();

      gridEl.innerHTML = `
        <div class="meta-item">
          <div class="meta-item-label">Generi</div>
          <div class="meta-item-val">${genresStr}</div>
        </div>
        <div class="meta-item">
          <div class="meta-item-label">Stato</div>
          <div class="meta-item-val">${statusStr}</div>
        </div>
        <div class="meta-item">
          <div class="meta-item-label">Lingua Originale</div>
          <div class="meta-item-val">${langStr}</div>
        </div>
      `;
    }

    // TV Show Seasons & Episodes Section
    const episodesContainer = document.getElementById('modal-episodes-container');
    if (episodesContainer) {
      if (mediaType === 'tv' && data.seasons && data.seasons.length > 0) {
        episodesContainer.style.display = 'flex';
        const validSeasons = data.seasons.filter(s => s.season_number > 0);
        const seasonsList = validSeasons.length > 0 ? validSeasons : data.seasons;

        episodesContainer.innerHTML = `
          <h3 class="modal-section-title">Episodi</h3>
          <div class="seasons-bar" id="modal-seasons-bar">
            ${seasonsList.map((s, idx) => `
              <button class="season-tab navigable focus-compact ${idx === 0 ? 'active' : ''}" data-season="${s.season_number}">
                ${s.name || `Stagione ${s.season_number}`}
              </button>
            `).join('')}
          </div>
          <div class="episodes-grid" id="modal-episodes-grid">
            <div style="color: var(--text-muted); font-size: 0.95rem;">Caricamento episodi...</div>
          </div>
        `;

        const loadSeasonEpisodes = async (seasonNum) => {
          const grid = document.getElementById('modal-episodes-grid');
          if (!grid) return;
          grid.innerHTML = `<div style="color: var(--text-muted); font-size: 0.95rem;">Caricamento episodi in corso...</div>`;
          const seasonData = await TMDBService.getSeasonDetails(data.id, seasonNum);
          const episodes = (seasonData && seasonData.episodes) ? seasonData.episodes : [];

          if (episodes.length === 0) {
            grid.innerHTML = `<div style="color: var(--text-muted);">Nessun episodio disponibile per questa stagione.</div>`;
            return;
          }

          grid.innerHTML = episodes.map(ep => {
            const epAvail = CatalogService.isEpisodeAvailable(data.id, seasonNum, ep.episode_number);
            return `
            <div class="episode-card navigable ${epAvail ? '' : 'unavailable'}" tabindex="0" data-season="${seasonNum}" data-episode="${ep.episode_number}" data-avail="${epAvail}">
              <div class="episode-thumb-wrap">
                <img src="${TMDBService.getBackdropUrl(ep.still_path || data.backdrop_path, 'w500')}" alt="${ep.name}" loading="lazy" />
              </div>
              <div class="episode-info">
                <div class="episode-title-row">
                  <div class="episode-number-title">${ep.episode_number}. ${ep.name || `Episodio ${ep.episode_number}`}</div>
                  <div style="display:flex; align-items:center; gap:8px;">
                    ${!epAvail ? `<span class="badge-unavailable">Non disp.</span>` : ''}
                    <div class="episode-runtime">${ep.runtime ? `${ep.runtime} min` : ''}</div>
                  </div>
                </div>
                <div class="episode-overview">${ep.overview || 'Nessuna descrizione disponibile.'}</div>
              </div>
            </div>
          `}).join('');

          // Episode click listeners
          grid.querySelectorAll('.episode-card').forEach(epCard => {
            epCard.addEventListener('click', () => {
              const epAvail = epCard.getAttribute('data-avail') === 'true';
              if (!epAvail) {
                this.showToast('Questo episodio non è attualmente disponibile per lo streaming in italiano.');
                return;
              }
              const sNum = parseInt(epCard.getAttribute('data-season'));
              const eNum = parseInt(epCard.getAttribute('data-episode'));
              const epData = episodes.find(e => e.episode_number === eNum);
              this.closeModal();
              PlayerController.play({
                ...data,
                media_type: 'tv',
                season: sNum,
                episode: eNum,
                episode_name: epData ? epData.name : ''
              });
            });
          });
        };

        // Attach season tab click handlers
        episodesContainer.querySelectorAll('.season-tab').forEach(tab => {
          tab.addEventListener('click', () => {
            episodesContainer.querySelectorAll('.season-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const sNum = parseInt(tab.getAttribute('data-season'));
            loadSeasonEpisodes(sNum);
          });
        });

        // Fetch Season 1 episodes by default
        loadSeasonEpisodes(seasonsList[0].season_number);
      } else {
        episodesContainer.style.display = 'none';
        episodesContainer.innerHTML = '';
      }
    }

    // Modal Action Buttons (Handle Available / Unavailable State)
    if (btnPlay) {
      if (isAvailable) {
        btnPlay.className = 'btn-primary-play navigable';
        btnPlay.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Riproduci`;
        btnPlay.onclick = () => {
          this.closeModal();
          PlayerController.play(data);
        };
      } else {
        btnPlay.className = 'btn-unavailable navigable';
        btnPlay.innerHTML = `<span style="font-weight:900;margin-right:6px;">✕</span> Non disponibile`;
        btnPlay.onclick = () => {
          this.showToast('Questo contenuto non è attualmente disponibile per lo streaming in italiano.');
        };
      }
    }

    if (btnWatchlist) {
      const inList = StorageService.isInWatchlist(data.id);
      btnWatchlist.innerHTML = inList ? '✓ Nella Lista' : '+ La Mia Lista';
      btnWatchlist.onclick = () => {
        const added = StorageService.toggleWatchlist(data);
        btnWatchlist.innerHTML = added ? '✓ Nella Lista' : '+ La Mia Lista';
        this.showToast(added ? `"${data.title || data.name}" aggiunto a La mia lista` : 'Rimosso da La mia lista');
      };
    }

    // "Rimuovi da Continua a guardare" Button Handler
    const btnRemoveContinue = document.getElementById('modal-btn-remove-continue');
    const isContinueWatching = StorageService.getItemProgress(data.id) !== null;
    if (btnRemoveContinue) {
      if (isContinueWatching) {
        btnRemoveContinue.style.display = 'inline-flex';
        btnRemoveContinue.onclick = () => {
          StorageService.removeContinueWatching(data.id);
          btnRemoveContinue.style.display = 'none';
          this.showToast(`"${data.title || data.name}" rimosso da Continua a guardare`);
          this.renderContinueWatchingRow();
          if (btnPlay) {
            window.navigatorInstance.setFocus(btnPlay);
          }
        };
      } else {
        btnRemoveContinue.style.display = 'none';
      }
    }

    // Show modal & set focus trap
    modal.classList.add('active');
    window.navigatorInstance.setModal(true, modal);

    setTimeout(() => {
      if (btnPlay) window.navigatorInstance.setFocus(btnPlay);
    }, 100);
  }

  closeModal() {
    const modal = document.getElementById('details-modal');
    if (!modal) return;

    modal.classList.remove('active');
    window.navigatorInstance.setModal(false, null);

    if (this.lastFocusedElement) {
      window.navigatorInstance.setFocus(this.lastFocusedElement);
    }
  }

  // =========================================================================
  // Search View
  // =========================================================================
  bindSearchEvents() {
    const wrapper = document.querySelector('.search-input-wrapper');
    const searchInput = document.getElementById('search-input');
    if (!searchInput) return;

    if (wrapper) {
      wrapper.addEventListener('click', () => {
        window.navigatorInstance.setFocus(wrapper);
        searchInput.focus();
      });
    }

    searchInput.addEventListener('focus', () => {
      if (wrapper) {
        wrapper.classList.add('focused');
        window.navigatorInstance.currentFocused = wrapper;
      }
    });

    searchInput.addEventListener('blur', () => {
      if (wrapper) {
        wrapper.classList.remove('focused');
      }
    });

    searchInput.addEventListener('input', (e) => {
      const query = e.target.value;
      if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = setTimeout(() => this.performSearch(query), 400);
    });
  }

  async performSearch(query) {
    const grid = document.getElementById('search-results-grid');
    if (!grid) return;

    if (!query || query.trim().length === 0) {
      grid.innerHTML = `<div style="color: var(--text-muted); font-size: 1.2rem; grid-column: 1/-1;">Inizia a digitare per cercare tra migliaia di film e serie TV...</div>`;
      return;
    }

    grid.innerHTML = `<div style="color: var(--primary-indigo-light); font-size: 1.2rem; grid-column: 1/-1;">Ricerca in corso...</div>`;

    const results = await TMDBService.search(query);

    if (results.length === 0) {
      grid.innerHTML = `<div style="color: var(--text-muted); font-size: 1.2rem; grid-column: 1/-1;">Nessun risultato trovato per "${query}".</div>`;
      return;
    }

    grid.innerHTML = results.map(item => {
      const isAvailable = CatalogService.isItemAvailable(item);
      return `
      <div class="media-card navigable ${isAvailable ? '' : 'unavailable'}" tabindex="0" data-id="${item.id}" data-type="${item.media_type}">
        <div class="card-badge-top">
          ${isAvailable ? `<span class="badge-rating">★ ${(item.vote_average || 7.0).toFixed(1)}</span>` : `<span class="badge-unavailable">Non disp.</span>`}
        </div>
        <img src="${TMDBService.getPosterUrl(item.poster_path)}" alt="${item.title || item.name}" loading="lazy" />
        ${isAvailable ? `
        <div class="card-play-indicator">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
        </div>` : ''}
        <div class="card-overlay">
          <div class="card-title">${item.title || item.name}</div>
          <div class="card-meta">
            <span>${(item.release_date || item.first_air_date || '').substring(0, 4)}</span>
            <span>•</span>
            <span>${item.media_type === 'tv' ? 'Serie TV' : 'Film'}</span>
          </div>
        </div>
      </div>
    `}).join('');

    grid.querySelectorAll('.media-card').forEach(card => {
      const id = parseInt(card.getAttribute('data-id'));
      const item = results.find(i => i.id === id);
      if (item) {
        const playBtn = card.querySelector('.card-play-indicator');
        if (playBtn) {
          playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!CatalogService.isItemAvailable(item)) {
              this.showToast('Questo contenuto non è attualmente disponibile per lo streaming in italiano.');
              return;
            }
            this.lastFocusedElement = card;
            PlayerController.play(item);
          });
        }
        card.addEventListener('click', () => {
          this.lastFocusedElement = card;
          this.openDetailsModal(item);
        });
      }
    });
  }

  // =========================================================================
  // Watchlist View
  // =========================================================================
  renderWatchlist() {
    const grid = document.getElementById('watchlist-grid');
    if (!grid) return;

    const list = StorageService.getWatchlist();

    if (list.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 60px 0;">
          <div style="font-size: 3rem; margin-bottom: 14px;">🎬</div>
          <div style="font-size: 1.3rem; font-weight: 700; color: #ffffff;">La tua lista è vuota</div>
          <div style="font-size: 1rem; color: var(--text-muted); margin-top: 8px;">Aggiungi film e serie TV per ritrovarli facilmente qui.</div>
        </div>
      `;
      return;
    }

    grid.innerHTML = list.map(item => {
      const isAvailable = CatalogService.isItemAvailable(item);
      return `
      <div class="media-card navigable ${isAvailable ? '' : 'unavailable'}" tabindex="0" data-id="${item.id}" data-type="${item.media_type}">
        <div class="card-badge-top">
          ${isAvailable ? `<span class="badge-rating">★ ${(item.vote_average || 7.0).toFixed(1)}</span>` : `<span class="badge-unavailable">Non disp.</span>`}
        </div>
        <img src="${TMDBService.getPosterUrl(item.poster_path)}" alt="${item.title}" loading="lazy" />
        ${isAvailable ? `
        <div class="card-play-indicator">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
        </div>` : ''}
        <div class="card-overlay">
          <div class="card-title">${item.title}</div>
          <div class="card-meta">
            <span>${(item.release_date || '').substring(0, 4)}</span>
            <span>•</span>
            <span>${item.media_type === 'tv' ? 'Serie TV' : 'Film'}</span>
          </div>
        </div>
      </div>
    `}).join('');

    grid.querySelectorAll('.media-card').forEach(card => {
      const id = parseInt(card.getAttribute('data-id'));
      const item = list.find(i => i.id === id);
      if (item) {
        const playBtn = card.querySelector('.card-play-indicator');
        if (playBtn) {
          playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!CatalogService.isItemAvailable(item)) {
              this.showToast('Questo contenuto non è attualmente disponibile per lo streaming in italiano.');
              return;
            }
            this.lastFocusedElement = card;
            PlayerController.play(item);
          });
        }
        card.addEventListener('click', () => {
          this.lastFocusedElement = card;
          this.openDetailsModal(item);
        });
      }
    });
  }

  // =========================================================================
  // Toast Notifications
  // =========================================================================
  showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
}

// Instantiate application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.App = new RoxyApp();
});
