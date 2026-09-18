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
    this.searchRequestId = 0;

    this.init();
  }

  async init() {
    console.log('Initializing Roxy Streaming Player...');
    
    // Initialize services
    window.navigatorInstance = new SpatialNavigator();
    WebOSBridge.init();
    PlayerController.init();
    if (window.AnimeSaturnService) {
      AnimeSaturnService.init();
    }

    this.bindHeaderEvents();
    this.bindHeroEvents();
    this.bindModalEvents();
    this.bindProfileEvents();
    this.bindSearchEvents();

    // 1. Sync updated domains from GitHub in background (non-blocking)
    if (window.DomainManager) {
      DomainManager.syncFromGithub().catch(e => console.warn('[DomainManager] Background sync notice:', e));
    }

    // 2. Sync VixSrc Italian catalog in background (non-blocking)
    CatalogService.init().catch(e => console.warn('[CatalogService] Background init notice:', e));

    // 3. Check active user profile or prompt "Chi sta guardando?"
    const activeUser = SupabaseService.getActiveUser();
    if (activeUser) {
      this.updateHeaderProfileBadge(activeUser);
      StorageService.syncFromCloud().then(() => {
        this.renderContinueWatchingRow();
      }).catch(() => {});
    } else {
      setTimeout(() => this.showProfileSelectorModal(), 400);
    }

    // 4. Load initial home page catalog progressively
    this.loadHomeCatalog();
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
  // Progressive Home Page Catalog Loading (Zero-wait Streaming Rows)
  // =========================================================================
  loadHomeCatalog() {
    try {
      const container = document.getElementById('home-rows-container');
      if (!container) return;
      container.innerHTML = '';

      // 1. Render Continue Watching immediately from local storage
      this.renderContinueWatchingRow();

      // Helper to render each row into its designated slot as soon as its request completes
      const renderProgressiveRow = (slotId, title, itemsPromise, options = {}) => {
        let slot = document.getElementById(slotId);
        if (!slot) {
          slot = document.createElement('div');
          slot.id = slotId;
          container.appendChild(slot);
        }

        itemsPromise.then(async rawItems => {
          if (!options.skipFilter) {
            await CatalogService.ready();
          }
          const items = options.skipFilter ? rawItems : CatalogService.filterAvailable(rawItems);
          if (!items || items.length === 0) {
            slot.remove();
            return;
          }

          // Populate Hero billboard with the first available batch of visual items
          if ((!this.heroItems || this.heroItems.length === 0) && items.some(i => i.backdrop_path)) {
            this.heroItems = items.filter(i => i.backdrop_path && (options.skipFilter || CatalogService.isItemAvailable(i))).slice(0, 8);
            this.renderHeroBillboard();
            setTimeout(() => {
              const initialFocus = document.querySelector('.hero-actions .btn-primary-play') || 
                                   document.querySelector('.hero-actions .btn-unavailable') || 
                                   document.querySelector('.nav-item');
              if (initialFocus) {
                window.navigatorInstance.setFocus(initialFocus);
              }
            }, 300);
          }

          this.renderRowContent(slot, title, items);
        }).catch(err => {
          console.warn(`[Roxy] Row ${title} load notice:`, err.message);
          if (slot) slot.remove();
        });
      };

      // Create and dispatch requests progressively in priority order:
      renderProgressiveRow('slot-trending', 'I Più Popolari in Streaming Oggi', TMDBService.getTrending('day'));
      renderProgressiveRow('slot-anime', '🪐 Anime', AnimeSaturnService.getLatestAnime(), { skipFilter: true });
      renderProgressiveRow('slot-alltime', 'Grandi Successi di Sempre', TMDBService.getAllTimePopularMovies());
      renderProgressiveRow('slot-tv', 'Serie TV del Momento', TMDBService.getPopularTV());
      renderProgressiveRow('slot-movies', 'Film da Non Perdere', TMDBService.getPopularMovies());
      renderProgressiveRow('slot-toprated', 'I Più Votati dalla Critica', TMDBService.getTopRatedMovies());
      renderProgressiveRow('slot-action', 'Azione & Avventura Esplosiva', TMDBService.getByGenre(CONFIG.GENRES.ACTION, 'movie', 1));
      renderProgressiveRow('slot-scifi', 'Fantascienza & Mondi Futuri', TMDBService.getByGenre(CONFIG.GENRES.SCI_FI, 'movie', 1));
      renderProgressiveRow('slot-anim', 'Animazione per Tutti', TMDBService.getByGenre(CONFIG.GENRES.ANIMATION, 'movie'));

    } catch (e) {
      console.error('Failed to start progressive home catalog:', e);
    }
  }

  renderRowContent(slotElement, title, items) {
    if (!items || items.length === 0 || !slotElement) return;

    slotElement.className = 'content-row';
    const rowId = `row-${Math.random().toString(36).substr(2, 9)}`;

    slotElement.innerHTML = `
      <div class="row-header">
        <h2 class="row-title">${title}</h2>
      </div>
      <div class="row-carousel" id="${rowId}">
        ${items.filter(i => i.poster_path).map(item => this.getMediaCardHtml(item)).join('')}
      </div>
    `;

    // Attach click listeners: play button starts playback, card body opens details modal
    slotElement.querySelectorAll('.media-card').forEach(card => {
      const rawId = card.getAttribute('data-id');
      const item = items.find(i => String(i.id) === String(rawId));
      if (item) {
        const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
        const playBtn = card.querySelector('.card-play-indicator');
        if (playBtn) {
          playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!isSaturn && !CatalogService.isItemAvailable(item)) {
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
  // Movies Section Catalog
  // =========================================================================
  async loadMoviesCatalog() {
    const container = document.getElementById('movies-rows-container');
    if (!container || container.children.length > 0) return;

    try {
      await CatalogService.ready();
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
      await CatalogService.ready();
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
  bindHeroEvents() {
    const btnPrev = document.getElementById('hero-btn-prev');
    if (btnPrev) {
      btnPrev.addEventListener('click', (e) => {
        e.stopPropagation();
        this.prevHero();
      });
    }

    const btnNext = document.getElementById('hero-btn-next');
    if (btnNext) {
      btnNext.addEventListener('click', (e) => {
        e.stopPropagation();
        this.nextHero();
      });
    }
  }

  prevHero() {
    if (!this.heroItems || this.heroItems.length === 0) return;
    this.heroIndex = (this.heroIndex - 1 + this.heroItems.length) % this.heroItems.length;
    this.renderHeroBillboard();
  }

  nextHero() {
    if (!this.heroItems || this.heroItems.length === 0) return;
    this.heroIndex = (this.heroIndex + 1) % this.heroItems.length;
    this.renderHeroBillboard();
  }

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

    // Render Clickable Indicator Dots
    const dotsContainer = document.getElementById('hero-dots');
    if (dotsContainer) {
      dotsContainer.innerHTML = this.heroItems.map((_, i) => 
        `<button class="hero-dot navigable focus-compact ${i === this.heroIndex ? 'active' : ''}" data-index="${i}" title="Vai al titolo ${i + 1}" tabindex="0"></button>`
      ).join('');

      dotsContainer.querySelectorAll('.hero-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(dot.getAttribute('data-index'), 10);
          if (!isNaN(idx) && idx !== this.heroIndex) {
            this.heroIndex = idx;
            this.renderHeroBillboard();
          }
        });
      });
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
  // Media Card HTML Generator (TMDB & AnimeSaturn)
  // =========================================================================
  getMediaCardHtml(item) {
    const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
    const isAvailable = isSaturn ? true : CatalogService.isItemAvailable(item);
    const posterUrl = (item.poster_path && item.poster_path.startsWith('http'))
      ? item.poster_path
      : TMDBService.getPosterUrl(item.poster_path);

    let topBadges = '';
    let topLeftBadges = '';

    if (isSaturn) {
      topLeftBadges = `<span class="saturn-tag">🪐</span>`;
      topBadges = item.isDub ? `<span class="badge-dub">DUB</span>` : `<span class="badge-sub">SUB</span>`;
    } else {
      topBadges = isAvailable ? `<span class="badge-rating">★ ${(item.vote_average || 7.0).toFixed(1)}</span>` : `<span class="badge-unavailable">Non disp.</span>`;
    }

    const title = isSaturn ? AnimeSaturnService.cleanAnimeTitle(item.title || item.name) : (item.title || item.name);
    const year = (item.release_date || item.first_air_date || '').substring(0, 4);
    const mediaLabel = isSaturn ? (item.anime_type || 'Anime') : (item.media_type === 'tv' || item.name ? 'Serie TV' : 'Film');

    return `
      <div class="media-card navigable ${isAvailable ? '' : 'unavailable'}" tabindex="0" data-id="${item.id}" data-type="${item.media_type || (isSaturn ? 'anime' : 'movie')}" data-source="${item.source || 'tmdb'}">
        ${topLeftBadges ? `<div class="card-badge-top-left">${topLeftBadges}</div>` : ''}
        <div class="card-badge-top">${topBadges}</div>
        <img src="${posterUrl}" alt="${title}" loading="lazy" />
        ${isAvailable ? `
        <div class="card-play-indicator">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
        </div>` : ''}
        <div class="card-overlay">
          <div class="card-title">${isSaturn ? '🪐 ' : ''}${title}</div>
          <div class="card-meta">
            ${year ? `<span>${year}</span><span>•</span>` : ''}
            <span>${mediaLabel}</span>
            ${isSaturn ? `<span>•</span><span>${item.isDub ? 'DUB ITA' : 'SUB ITA'}</span>` : ''}
          </div>
        </div>
      </div>
    `;
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
          const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
          const isTv = (item.media_type === 'tv' || isSaturn);
          const subInfo = isSaturn 
            ? `Ep. ${item.episode || 1} • ${item.isDub ? 'DUB' : 'SUB'}` 
            : (isTv ? `S${item.season || 1}:E${item.episode || 1}` : '');

          const posterUrl = (item.backdrop_path || item.poster_path || '');
          const imgUrl = (posterUrl.startsWith('http')) ? posterUrl : TMDBService.getBackdropUrl(posterUrl);
          const cleanTitle = isSaturn ? AnimeSaturnService.cleanAnimeTitle(item.title) : item.title;

          return `
          <div class="continue-card navigable" tabindex="0" data-id="${item.id}" data-type="${item.media_type}">
            <img src="${imgUrl}" alt="${cleanTitle}" loading="lazy" />
            <div class="card-play-indicator">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
            </div>
            <div class="continue-overlay">
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <span style="font-size: 0.75rem; color: #a5b4fc; font-weight: 600;">${subInfo}</span>
                <span class="${isSaturn ? 'badge-saturn' : 'badge-indigo'}" style="font-size: 0.75rem;">${isSaturn ? '🪐 ANIME' : (isTv ? 'SERIE' : 'FILM')}</span>
              </div>
              <div>
                <div class="card-title">${isSaturn ? '🪐 ' : ''}${cleanTitle}</div>
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
      const rawId = card.getAttribute('data-id');
      const item = list.find(i => String(i.id) === String(rawId));
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
        ${items.filter(i => i.poster_path).map(item => this.getMediaCardHtml(item)).join('')}
      </div>
    `;

    parent.appendChild(row);

    // Attach click listeners: play button starts playback, card body opens details modal
    row.querySelectorAll('.media-card').forEach(card => {
      const rawId = card.getAttribute('data-id');
      const item = items.find(i => String(i.id) === String(rawId));
      if (item) {
        const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
        const playBtn = card.querySelector('.card-play-indicator');
        if (playBtn) {
          playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!isSaturn && !CatalogService.isItemAvailable(item)) {
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

    const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
    
    let data;
    if (isSaturn) {
      const slug = item.slug || String(item.id).replace('saturn_', '');
      const fetched = await AnimeSaturnService.getAnimeDetails(slug);
      data = fetched || item;
    } else {
      const mediaType = item.media_type || (item.name ? 'tv' : 'movie');
      const fullDetails = await TMDBService.getDetails(item.id, mediaType);
      data = fullDetails || item;
    }

    // Verify availability against VixSrc catalog list (Saturn is always available)
    const isAvailable = isSaturn ? true : CatalogService.isItemAvailable(data);

    // Populate Modal DOM
    const backdropImg = document.getElementById('modal-backdrop-img');
    const titleEl = document.getElementById('modal-title');
    const badgesEl = document.getElementById('modal-badges');
    const overviewEl = document.getElementById('modal-overview');
    const gridEl = document.getElementById('modal-meta-grid');
    const btnPlay = document.getElementById('modal-btn-play');
    const btnWatchlist = document.getElementById('modal-btn-watchlist');

    if (backdropImg) {
      const bg = data.backdrop_path || data.poster_path;
      backdropImg.src = (bg && bg.startsWith('http')) ? bg : TMDBService.getBackdropUrl(bg);
    }

    if (titleEl) {
      const displayTitle = isSaturn ? AnimeSaturnService.cleanAnimeTitle(data.title || data.name) : (data.title || data.name || '');
      titleEl.textContent = isSaturn ? `🪐 ${displayTitle}` : displayTitle;
    }

    if (badgesEl) {
      if (isSaturn) {
        badgesEl.innerHTML = `
          <span class="badge-saturn">🪐 AnimeSaturn</span>
          <span class="${data.isDub ? 'badge-dub' : 'badge-sub'}">${data.isDub ? 'DUB ITA' : 'SUB ITA'}</span>
          <span class="badge-quality">FULL HD 1080P</span>
          ${data.episodes ? `<span class="badge-quality">${data.episodes.length} Episodi</span>` : ''}
        `;
      } else {
        const year = (data.release_date || data.first_air_date || '').substring(0, 4);
        const rating = data.vote_average ? data.vote_average.toFixed(1) : '7.5';
        const duration = data.runtime ? `${data.runtime} min` : (data.number_of_seasons ? `${data.number_of_seasons} Stagioni` : '');
        const mediaType = data.media_type || (data.name ? 'tv' : 'movie');

        badgesEl.innerHTML = `
          <span class="badge-indigo">${mediaType === 'tv' ? 'SERIE TV' : 'FILM'}</span>
          ${!isAvailable ? `<span class="badge-unavailable">NON DISPONIBILE</span>` : ''}
          <span class="badge-rating">★ ${rating}</span>
          ${duration ? `<span class="badge-quality">${duration}</span>` : ''}
          ${year ? `<span style="color: var(--text-med); font-weight: 600;">${year}</span>` : ''}
        `;
      }
    }

    if (overviewEl) {
      overviewEl.textContent = data.overview || 'Nessuna sinossi disponibile.';
    }

    if (gridEl) {
      const genresStr = (data.genres || []).map(g => g.name).join(', ') || 'Generale';
      const statusStr = data.status || 'Disponibile';
      const langStr = isSaturn 
        ? (data.isDub ? 'Italiano (DUB)' : 'Giapponese (SUB ITA)') 
        : (data.original_language || 'it').toUpperCase();

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
          <div class="meta-item-label">Audio / Lingua</div>
          <div class="meta-item-val">${langStr}</div>
        </div>
      `;
    }

    // Episodes Section (Handles both TV Series and AnimeSaturn Episodes)
    const episodesContainer = document.getElementById('modal-episodes-container');
    if (episodesContainer) {
      if (isSaturn && data.episodes && data.episodes.length > 0) {
        episodesContainer.style.display = 'flex';
        episodesContainer.innerHTML = `
          <h3 class="modal-section-title">Episodi Anime (${data.episodes.length})</h3>
          <div class="episodes-grid" id="modal-episodes-grid">
            ${data.episodes.map(ep => `
              <div class="episode-card navigable" tabindex="0" data-episode="${ep.episode_number}">
                <div class="episode-thumb-wrap">
                  <img src="${(ep.still_path && ep.still_path.startsWith('http')) ? ep.still_path : (data.backdrop_path || data.poster_path)}" alt="${ep.name}" loading="lazy" />
                </div>
                <div class="episode-info">
                  <div class="episode-title-row">
                    <div class="episode-number-title">${ep.episode_number}. ${ep.name || `Episodio ${ep.episode_number}`}</div>
                    <div style="display:flex; align-items:center; gap:8px;">
                      <span class="${data.isDub ? 'badge-dub' : 'badge-sub'}">${data.isDub ? 'DUB' : 'SUB'}</span>
                    </div>
                  </div>
                  <div class="episode-overview">${ep.overview || `Episodio ${ep.episode_number}`}</div>
                </div>
              </div>
            `).join('')}
          </div>
        `;

        // Episode click handlers
        episodesContainer.querySelectorAll('.episode-card').forEach(epCard => {
          epCard.addEventListener('click', () => {
            const epNum = parseInt(epCard.getAttribute('data-episode'));
            const epData = data.episodes.find(e => e.episode_number === epNum);
            this.closeModal();
            PlayerController.play({
              ...data,
              source: 'animesaturn',
              slug: data.slug || item.slug,
              episode: epNum,
              episode_name: epData ? epData.name : `Episodio ${epNum}`
            });
          });
        });
      } else if (!isSaturn && (data.media_type === 'tv' || data.name) && data.seasons && data.seasons.length > 0) {
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
        btnPlay.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> ${isSaturn ? 'Riproduci Ep. 1' : 'Riproduci'}`;
        btnPlay.onclick = () => {
          this.closeModal();
          PlayerController.play(isSaturn ? { ...data, episode: 1 } : data);
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
    const isContinueWatching = StorageService.getContinueWatching().some(i => String(i.id) === String(data.id));
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
  // Multi-User Profile & Authentication System
  // =========================================================================
  bindProfileEvents() {
    const profileBtn = document.getElementById('nav-profile-btn');
    if (profileBtn) {
      profileBtn.addEventListener('click', () => {
        if (SupabaseService.getActiveUser()) {
          this.showProfileSettingsModal();
        } else {
          this.showProfileSelectorModal();
        }
      });
    }

    const btnOpenCreate = document.getElementById('btn-open-create-profile');
    if (btnOpenCreate) {
      btnOpenCreate.addEventListener('click', () => this.showCreateProfileModal());
    }

    const btnCancelCreate = document.getElementById('btn-cancel-create-profile');
    if (btnCancelCreate) {
      btnCancelCreate.addEventListener('click', () => this.closeCreateProfileModal());
    }

    // Create Profile Emoji Picker
    this.selectedNewEmoji = '🍿';
    const emojiBtns = document.querySelectorAll('#emoji-picker .emoji-btn');
    emojiBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        emojiBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedNewEmoji = btn.getAttribute('data-emoji') || '🍿';
      });
    });

    // Settings Profile Emoji Picker
    this.selectedSettingsEmoji = '🍿';
    const settingsEmojiBtns = document.querySelectorAll('#settings-emoji-picker .settings-emoji-btn');
    settingsEmojiBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        settingsEmojiBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedSettingsEmoji = btn.getAttribute('data-emoji') || '🍿';
        const avatarBig = document.getElementById('settings-current-avatar');
        if (avatarBig) avatarBig.textContent = this.selectedSettingsEmoji;
      });
    });

    // Create Profile Submit
    const btnSubmitCreate = document.getElementById('btn-submit-create-profile');
    if (btnSubmitCreate) {
      btnSubmitCreate.addEventListener('click', () => this.handleCreateProfileSubmit());
    }

    // Profile Settings Buttons
    const btnCloseSettings = document.getElementById('btn-close-profile-settings');
    if (btnCloseSettings) {
      btnCloseSettings.addEventListener('click', () => this.closeProfileSettingsModal());
    }

    const btnSaveSettings = document.getElementById('btn-settings-save');
    if (btnSaveSettings) {
      btnSaveSettings.addEventListener('click', () => this.handleProfileSettingsSave());
    }

    const btnSwitchUser = document.getElementById('btn-settings-switch-user');
    if (btnSwitchUser) {
      btnSwitchUser.addEventListener('click', () => this.handleProfileSwitch());
    }

    const btnDeleteProfile = document.getElementById('btn-settings-delete-profile');
    if (btnDeleteProfile) {
      btnDeleteProfile.addEventListener('click', () => this.handleProfileDelete());
    }

    // PIN Numpad
    this.currentPinInput = '';
    this.selectedTargetProfile = null;

    const numpadBtns = document.querySelectorAll('.numpad-grid .numpad-btn[data-num]');
    numpadBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const num = btn.getAttribute('data-num');
        if (num !== null) this.handlePinDigit(num);
      });
    });

    const btnPinDel = document.getElementById('btn-pin-del');
    if (btnPinDel) {
      btnPinDel.addEventListener('click', () => this.handlePinDelete());
    }

    const btnPinCancel = document.getElementById('btn-pin-cancel');
    if (btnPinCancel) {
      btnPinCancel.addEventListener('click', () => this.closePinModal());
    }

    // Physical / Remote keyboard numbers for PIN
    window.addEventListener('keydown', (e) => {
      const pinModal = document.getElementById('pin-modal');
      if (pinModal && pinModal.style.display !== 'none') {
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault();
          this.handlePinDigit(e.key);
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          this.handlePinDelete();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.closePinModal();
        }
      }
    });
  }

  updateHeaderProfileBadge(user) {
    const avatarEl = document.getElementById('header-user-avatar');
    const nameEl = document.getElementById('header-user-name');
    if (avatarEl && nameEl) {
      if (user) {
        avatarEl.textContent = user.avatar_emoji || '🍿';
        nameEl.textContent = user.username || 'Amico';
      } else {
        avatarEl.textContent = '🍿';
        nameEl.textContent = 'Accedi';
      }
    }
  }

  async showProfileSelectorModal() {
    const modal = document.getElementById('profile-modal');
    const grid = document.getElementById('profiles-grid');
    const countBadge = document.getElementById('profile-count-badge');
    if (!modal || !grid) return;

    grid.innerHTML = '<div style="color: var(--text-med); font-size: 1.2rem; width: 100%;">Caricamento profili amici...</div>';
    modal.style.display = 'flex';
    window.navigatorInstance.setModal(true, modal);

    try {
      const profiles = await SupabaseService.getProfiles();
      if (countBadge) {
        countBadge.textContent = `(${profiles.length}/${SupabaseService.maxUsersLimit})`;
      }

      if (profiles.length === 0) {
        grid.innerHTML = `
          <div style="color: var(--text-med); font-size: 1.1rem; width: 100%; margin: 20px 0;">
            Nessun profilo amico registrato. Creane subito uno per iniziare!
          </div>
        `;
      } else {
        grid.innerHTML = profiles.map(p => `
          <div class="profile-card navigable focus-compact" data-id="${p.id}" tabindex="0">
            <div class="profile-avatar-circle">${p.avatar_emoji || '🍿'}</div>
            <div class="profile-card-name">${p.username}</div>
          </div>
        `).join('');

        grid.querySelectorAll('.profile-card').forEach(card => {
          const id = card.getAttribute('data-id');
          const profile = profiles.find(p => String(p.id) === String(id));
          if (profile) {
            card.addEventListener('click', () => {
              this.showPinModal(profile);
            });
          }
        });
      }

      const firstNav = modal.querySelector('.navigable');
      if (firstNav) window.navigatorInstance.setFocus(firstNav);
    } catch (e) {
      grid.innerHTML = `<div style="color: #ef4444; font-size: 1.1rem;">Errore caricamento profili: ${e.message}</div>`;
    }
  }

  closeProfileSelectorModal() {
    const modal = document.getElementById('profile-modal');
    if (modal) {
      modal.style.display = 'none';
      window.navigatorInstance.setModal(false, null);
    }
  }

  showPinModal(profile) {
    this.selectedTargetProfile = profile;
    this.currentPinInput = '';

    const modal = document.getElementById('pin-modal');
    const avatar = document.getElementById('pin-target-avatar');
    const username = document.getElementById('pin-target-username');
    const errorMsg = document.getElementById('pin-error-msg');

    if (!modal) return;

    if (avatar) avatar.textContent = profile.avatar_emoji || '🍿';
    if (username) username.textContent = profile.username;
    if (errorMsg) errorMsg.style.display = 'none';

    this.updatePinDots();

    modal.style.display = 'flex';
    window.navigatorInstance.setModal(true, modal);

    const firstNav = modal.querySelector('.numpad-btn[data-num="1"]') || modal.querySelector('.navigable');
    if (firstNav) window.navigatorInstance.setFocus(firstNav);
  }

  closePinModal() {
    const modal = document.getElementById('pin-modal');
    if (modal) {
      modal.style.display = 'none';
    }
    this.currentPinInput = '';
    this.selectedTargetProfile = null;

    // Return to profile selector if no user is active
    if (!SupabaseService.getActiveUser()) {
      this.showProfileSelectorModal();
    } else {
      window.navigatorInstance.setModal(false, null);
    }
  }

  handlePinDigit(digit) {
    if (this.currentPinInput.length >= 4) return;
    this.currentPinInput += String(digit);
    this.updatePinDots();

    const errorMsg = document.getElementById('pin-error-msg');
    if (errorMsg) errorMsg.style.display = 'none';

    if (this.currentPinInput.length === 4) {
      this.verifyPin();
    }
  }

  handlePinDelete() {
    if (this.currentPinInput.length > 0) {
      this.currentPinInput = this.currentPinInput.slice(0, -1);
      this.updatePinDots();
    }
  }

  updatePinDots() {
    for (let i = 1; i <= 4; i++) {
      const dot = document.getElementById(`pin-dot-${i}`);
      if (dot) {
        if (i <= this.currentPinInput.length) {
          dot.classList.add('filled');
        } else {
          dot.classList.remove('filled');
        }
      }
    }
  }

  async verifyPin() {
    if (!this.selectedTargetProfile) return;
    const errorMsg = document.getElementById('pin-error-msg');

    try {
      const loggedUser = await SupabaseService.login(this.selectedTargetProfile.id, this.currentPinInput);
      this.closePinModal();
      this.closeProfileSelectorModal();
      this.onUserLogin(loggedUser);
    } catch (e) {
      if (errorMsg) {
        errorMsg.textContent = e.message || 'PIN errato. Riprova.';
        errorMsg.style.display = 'block';
      }
      this.currentPinInput = '';
      setTimeout(() => this.updatePinDots(), 500);
    }
  }

  showCreateProfileModal() {
    this.closeProfileSelectorModal();
    const modal = document.getElementById('create-profile-modal');
    const nameInput = document.getElementById('new-profile-name');
    const pinInput = document.getElementById('new-profile-pin');
    const errorMsg = document.getElementById('create-profile-error');

    if (!modal) return;
    if (nameInput) nameInput.value = '';
    if (pinInput) pinInput.value = '';
    if (errorMsg) errorMsg.style.display = 'none';

    modal.style.display = 'flex';
    window.navigatorInstance.setModal(true, modal);

    if (nameInput) window.navigatorInstance.setFocus(nameInput);
  }

  closeCreateProfileModal() {
    const modal = document.getElementById('create-profile-modal');
    if (modal) modal.style.display = 'none';
    this.showProfileSelectorModal();
  }

  async handleCreateProfileSubmit() {
    const nameInput = document.getElementById('new-profile-name');
    const pinInput = document.getElementById('new-profile-pin');
    const errorMsg = document.getElementById('create-profile-error');

    const username = nameInput ? nameInput.value.trim() : '';
    const pin = pinInput ? pinInput.value.trim() : '';
    const emoji = this.selectedNewEmoji || '🍿';

    if (errorMsg) errorMsg.style.display = 'none';

    try {
      const newUser = await SupabaseService.createProfile(username, pin, emoji);
      const modal = document.getElementById('create-profile-modal');
      if (modal) modal.style.display = 'none';
      this.closeProfileSelectorModal();
      this.onUserLogin(newUser);
    } catch (e) {
      if (errorMsg) {
        errorMsg.textContent = e.message || 'Errore durante la creazione del profilo.';
        errorMsg.style.display = 'block';
      }
    }
  }

  // Profile Settings Modal
  showProfileSettingsModal() {
    const user = SupabaseService.getActiveUser();
    if (!user) {
      this.showProfileSelectorModal();
      return;
    }

    const modal = document.getElementById('profile-settings-modal');
    const avatarEl = document.getElementById('settings-current-avatar');
    const titleEl = document.getElementById('settings-title-username');
    const nameInput = document.getElementById('settings-profile-name');
    const pinInput = document.getElementById('settings-profile-pin');
    const errorMsg = document.getElementById('settings-profile-error');

    if (!modal) return;

    this.selectedSettingsEmoji = user.avatar_emoji || '🍿';
    if (avatarEl) avatarEl.textContent = this.selectedSettingsEmoji;
    if (titleEl) titleEl.textContent = `Profilo di ${user.username}`;
    if (nameInput) nameInput.value = user.username || '';
    if (pinInput) pinInput.value = '';
    if (errorMsg) errorMsg.style.display = 'none';

    const emojiBtns = document.querySelectorAll('#settings-emoji-picker .settings-emoji-btn');
    emojiBtns.forEach(btn => {
      if (btn.getAttribute('data-emoji') === this.selectedSettingsEmoji) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    modal.style.display = 'flex';
    window.navigatorInstance.setModal(true, modal);

    if (nameInput) window.navigatorInstance.setFocus(nameInput);
  }

  closeProfileSettingsModal() {
    const modal = document.getElementById('profile-settings-modal');
    if (modal) {
      modal.style.display = 'none';
      window.navigatorInstance.setModal(false, null);
    }
  }

  async handleProfileSettingsSave() {
    const user = SupabaseService.getActiveUser();
    if (!user) return;

    const nameInput = document.getElementById('settings-profile-name');
    const pinInput = document.getElementById('settings-profile-pin');
    const errorMsg = document.getElementById('settings-profile-error');

    const newName = nameInput ? nameInput.value.trim() : '';
    const newPin = pinInput ? pinInput.value.trim() : '';
    const newEmoji = this.selectedSettingsEmoji || user.avatar_emoji || '🍿';

    if (errorMsg) errorMsg.style.display = 'none';

    const updates = {};
    if (newName && newName !== user.username) {
      updates.username = newName;
    }
    if (newEmoji && newEmoji !== user.avatar_emoji) {
      updates.avatar_emoji = newEmoji;
    }
    if (newPin) {
      if (!/^\d{4}$/.test(newPin)) {
        if (errorMsg) {
          errorMsg.textContent = 'Il PIN deve essere composto esattamente da 4 cifre numeriche.';
          errorMsg.style.display = 'block';
        }
        return;
      }
      updates.pin = newPin;
    }

    if (Object.keys(updates).length === 0) {
      this.closeProfileSettingsModal();
      return;
    }

    try {
      const updatedUser = await SupabaseService.updateProfile(user.id, updates);
      this.updateHeaderProfileBadge(updatedUser || SupabaseService.getActiveUser());
      this.closeProfileSettingsModal();
      this.showToast('Profilo aggiornato con successo! ✨');
    } catch (e) {
      if (errorMsg) {
        errorMsg.textContent = e.message || 'Errore durante l\'aggiornamento del profilo.';
        errorMsg.style.display = 'block';
      }
    }
  }

  async handleProfileDelete() {
    const user = SupabaseService.getActiveUser();
    if (!user) return;

    const confirmed = window.confirm(`Sei sicuro di voler eliminare definitivamente il profilo di "${user.username}"? Questa operazione è irreversibile.`);
    if (!confirmed) return;

    try {
      await SupabaseService.deleteProfile(user.id);
      this.closeProfileSettingsModal();
      this.updateHeaderProfileBadge(null);
      this.showToast('Profilo eliminato con successo.');
      this.renderContinueWatchingRow();
      if (this.currentSection === 'watchlist') {
        this.renderWatchlist();
      }
      this.showProfileSelectorModal();
    } catch (e) {
      this.showToast(`Errore eliminazione: ${e.message}`);
    }
  }

  handleProfileSwitch() {
    this.closeProfileSettingsModal();
    this.showProfileSelectorModal();
  }

  async onUserLogin(user) {
    this.updateHeaderProfileBadge(user);
    this.showToast(`Benvenuto/a, ${user.username}! ${user.avatar_emoji || '🍿'}`);
    await StorageService.syncFromCloud();
    this.renderContinueWatchingRow();
    if (this.currentSection === 'watchlist') {
      this.renderWatchlist();
    }
  }

  // =========================================================================
  // Search View (Unified TMDB + AnimeSaturn Search with DUB Priority)
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

    const trimmed = (query || '').trim();
    if (!trimmed) {
      grid.innerHTML = `<div style="color: var(--text-muted); font-size: 1.2rem; grid-column: 1/-1;">Inizia a digitare per cercare tra film, serie TV e anime...</div>`;
      return;
    }

    const currentSearchId = ++this.searchRequestId;
    grid.innerHTML = `<div style="color: var(--primary-indigo-light); font-size: 1.2rem; grid-column: 1/-1;">Ricerca in corso per "${trimmed}"...</div>`;

    const currentResults = [];

    const updateAndRender = (newItems) => {
      if (this.searchRequestId !== currentSearchId) return;

      // Merge newItems into currentResults, deduplicating by item id
      const seen = new Set(currentResults.map(i => String(i.id)));
      newItems.forEach(item => {
        if (!seen.has(String(item.id))) {
          seen.add(String(item.id));
          currentResults.push(item);
        }
      });

      // Sort: DUB Anime first, then TMDB/available contents, then SUB anime
      currentResults.sort((a, b) => {
        const aIsSaturn = (a.source === 'animesaturn' || String(a.id).startsWith('saturn_'));
        const bIsSaturn = (b.source === 'animesaturn' || String(b.id).startsWith('saturn_'));

        if (aIsSaturn && a.isDub && (!bIsSaturn || !b.isDub)) return -1;
        if (bIsSaturn && b.isDub && (!aIsSaturn || !a.isDub)) return 1;

        if (aIsSaturn && !a.isDub && !bIsSaturn) return 1;
        if (bIsSaturn && !b.isDub && !aIsSaturn) return -1;

        return 0;
      });

      if (currentResults.length === 0) {
        grid.innerHTML = `<div style="color: var(--text-muted); font-size: 1.2rem; grid-column: 1/-1;">Nessun risultato trovato per "${trimmed}".</div>`;
        return;
      }

      grid.innerHTML = currentResults.map(item => this.getMediaCardHtml(item)).join('');

      // Reattach click listeners
      grid.querySelectorAll('.media-card').forEach(card => {
        const rawId = card.getAttribute('data-id');
        const item = currentResults.find(i => String(i.id) === String(rawId));
        if (item) {
          const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
          const playBtn = card.querySelector('.card-play-indicator');
          if (playBtn) {
            playBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (!isSaturn && !CatalogService.isItemAvailable(item)) {
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
    };

    // 1. Launch TMDB search -> update immediately upon response
    TMDBService.search(trimmed).then(tmdbRes => {
      if (Array.isArray(tmdbRes) && tmdbRes.length > 0) {
        updateAndRender(tmdbRes);
      }
    }).catch(err => console.warn('[Roxy] TMDB search warning:', err));

    // 2. Launch AnimeSaturn search -> update & reorder immediately upon response
    AnimeSaturnService.search(trimmed).then(saturnRes => {
      if (Array.isArray(saturnRes) && saturnRes.length > 0) {
        updateAndRender(saturnRes);
      }
    }).catch(err => console.warn('[Roxy] AnimeSaturn search warning:', err));
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
          <div style="font-size: 1rem; color: var(--text-muted); margin-top: 8px;">Aggiungi film, serie TV e anime per ritrovarli facilmente qui.</div>
        </div>
      `;
      return;
    }

    grid.innerHTML = list.map(item => this.getMediaCardHtml(item)).join('');

    grid.querySelectorAll('.media-card').forEach(card => {
      const rawId = card.getAttribute('data-id');
      const item = list.find(i => String(i.id) === String(rawId));
      if (item) {
        const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
        const playBtn = card.querySelector('.card-play-indicator');
        if (playBtn) {
          playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!isSaturn && !CatalogService.isItemAvailable(item)) {
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
