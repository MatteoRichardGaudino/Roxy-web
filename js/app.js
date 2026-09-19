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
    this.bindFeedbackEvents();
    this.bindUserProfileEvents();

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
        this.renderHomeWatchlistRow();
      }).catch(() => {});
    } else {
      setTimeout(() => this.showProfileSelectorModal(), 400);
    }

    // 4. Background fetch of community social activity (updates card viewer stacks eagerly)
    if (window.SupabaseService && typeof SupabaseService.loadGlobalSocialActivity === 'function') {
      SupabaseService.loadGlobalSocialActivity().then(() => {
        this.updateCardsSocialStacks();
      }).catch(() => {});
    }

    // 5. Load initial home page catalog progressively
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

    // Mobile bottom navigation items
    const mobileNavItems = document.querySelectorAll('.mobile-nav-item');
    mobileNavItems.forEach(item => {
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

    // Update active desktop nav button
    document.querySelectorAll('.nav-item').forEach(btn => {
      if (btn.getAttribute('data-section') === sectionName) {
        btn.classList.add('nav-active');
      } else {
        btn.classList.remove('nav-active');
      }
    });

    // Update active mobile bottom nav button
    document.querySelectorAll('.mobile-nav-item').forEach(btn => {
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
    } else if (sectionName === 'users') {
      this.loadUsersSection();
    } else if (sectionName === 'feedback') {
      this.loadFeedbackSection();
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

      // 1b. Render Community feed row
      this.renderCommunityRow();

      // 1c. Render Home Watchlist row
      this.renderHomeWatchlistRow();

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

  // =========================================================================
  // Horizontal Carousel Scroll Chevrons
  // =========================================================================
  setupCarouselArrows(container) {
    if (!container) return;
    const carousel = container.querySelector('.row-carousel');
    if (!carousel) return;

    let wrapper = carousel.parentElement;
    if (!wrapper || !wrapper.classList.contains('carousel-wrapper')) {
      wrapper = document.createElement('div');
      wrapper.className = 'carousel-wrapper';
      carousel.parentNode.insertBefore(wrapper, carousel);
      wrapper.appendChild(carousel);

      const btnLeft = document.createElement('button');
      btnLeft.className = 'carousel-arrow carousel-arrow-left';
      btnLeft.setAttribute('aria-label', 'Scorri indietro');
      btnLeft.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>`;

      const btnRight = document.createElement('button');
      btnRight.className = 'carousel-arrow carousel-arrow-right';
      btnRight.setAttribute('aria-label', 'Scorri avanti');
      btnRight.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;

      wrapper.insertBefore(btnLeft, carousel);
      wrapper.appendChild(btnRight);

      btnLeft.addEventListener('click', (e) => {
        e.stopPropagation();
        carousel.scrollBy({ left: -Math.floor(carousel.clientWidth * 0.75), behavior: 'smooth' });
      });

      btnRight.addEventListener('click', (e) => {
        e.stopPropagation();
        carousel.scrollBy({ left: Math.floor(carousel.clientWidth * 0.75), behavior: 'smooth' });
      });
    }

    const btnLeft = wrapper.querySelector('.carousel-arrow-left');
    const btnRight = wrapper.querySelector('.carousel-arrow-right');

    const updateArrowVisibility = () => {
      if (!carousel || !btnLeft || !btnRight) return;
      const canScrollLeft = carousel.scrollLeft > 10;
      const canScrollRight = (carousel.scrollWidth - carousel.clientWidth - carousel.scrollLeft) > 10;

      btnLeft.classList.toggle('is-visible', canScrollLeft);
      btnRight.classList.toggle('is-visible', canScrollRight);
    };

    carousel.addEventListener('scroll', updateArrowVisibility, { passive: true });
    wrapper.addEventListener('mouseenter', updateArrowVisibility);

    setTimeout(updateArrowVisibility, 150);
    setTimeout(updateArrowVisibility, 600);
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

    // Ensure social viewer avatar stack is up to date and attach scroll arrows
    this.updateCardsSocialStacks(slotElement);
    this.setupCarouselArrows(slotElement);

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
      const typeLabel = (item.media_type === 'tv' || (item.media_type !== 'movie' && item.name && !item.title)) ? 'SERIE TV' : 'FILM';

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
    const mediaLabel = isSaturn ? (item.anime_type || 'Anime') : ((item.media_type === 'tv' || (item.media_type !== 'movie' && item.name && !item.title)) ? 'Serie TV' : 'Film');

    // Stacked social viewers on card (friends who are watching or have watched)
    const socialViewers = (window.SupabaseService && typeof SupabaseService.getMediaSocialActivity === 'function')
      ? SupabaseService.getMediaSocialActivity(item.id)
      : [];

    const socialStackHtml = this.generateSocialStackHtml(socialViewers);

    return `
      <div class="media-card navigable ${isAvailable ? '' : 'unavailable'}" tabindex="0" data-id="${item.id}" data-type="${item.media_type || (isSaturn ? 'anime' : 'movie')}" data-source="${item.source || 'tmdb'}">
        ${topLeftBadges ? `<div class="card-badge-top-left">${topLeftBadges}</div>` : ''}
        <div class="card-badge-top">${topBadges}</div>
        ${socialStackHtml}
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

  generateSocialStackHtml(socialViewers) {
    if (!socialViewers || socialViewers.length === 0) return '';
    const maxShown = 3;
    const displayViewers = socialViewers.slice(0, maxShown);
    const remaining = socialViewers.length - maxShown;

    const avatarsHtml = displayViewers.map(v => {
      const isCompleted = v.status === 'completed';
      const isDropped = v.status === 'dropped';
      let titleTooltip = `${v.username}: Sta guardando`;
      let statusClass = 'is-watching';

      if (isDropped) {
        titleTooltip = `${v.username}: Ha droppato`;
        statusClass = 'is-dropped';
      } else if (isCompleted) {
        titleTooltip = `${v.username}: Ha visto`;
        statusClass = 'is-completed';
      }

      const avatarContent = v.avatar_url
        ? `<img src="${v.avatar_url}" class="stacked-avatar-img" alt="${this.escapeHtml(v.username)}" onerror="this.outerHTML='${this.escapeHtml(v.avatar_emoji || '🍿')}'" />`
        : this.escapeHtml(v.avatar_emoji || '🍿');

      return `
        <div class="card-social-avatar ${statusClass}" title="${this.escapeHtml(titleTooltip)}">
          ${avatarContent}
        </div>
      `;
    }).join('');

    const remainingBadge = remaining > 0 ? `<div class="card-social-avatar card-social-more">+${remaining}</div>` : '';

    return `
      <div class="card-social-stack">
        ${avatarsHtml}
        ${remainingBadge}
      </div>
    `;
  }

  updateCardsSocialStacks(container = document) {
    if (!window.SupabaseService || typeof SupabaseService.getMediaSocialActivity !== 'function') return;

    const cards = container.querySelectorAll ? container.querySelectorAll('.media-card[data-id]') : [];
    cards.forEach(card => {
      const mediaId = card.getAttribute('data-id');
      if (!mediaId) return;

      const socialViewers = SupabaseService.getMediaSocialActivity(mediaId);
      const existingStack = card.querySelector('.card-social-stack');

      if (socialViewers && socialViewers.length > 0) {
        const stackHtml = this.generateSocialStackHtml(socialViewers);
        if (existingStack) {
          existingStack.outerHTML = stackHtml;
        } else {
          const img = card.querySelector('img');
          if (img) {
            img.insertAdjacentHTML('beforebegin', stackHtml);
          } else {
            card.insertAdjacentHTML('afterbegin', stackHtml);
          }
        }
      } else if (existingStack) {
        existingStack.remove();
      }
    });
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
          const currentSecs = (item.currentTime || 0) % 60;
          const timeText = (durMins > 0) 
            ? (currentMins > 0 ? `${currentMins}/${durMins} min` : `${currentSecs}s/${durMins}m`) 
            : (currentMins > 0 ? `${currentMins} min` : `${currentSecs}s`);
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

    this.setupCarouselArrows(container);

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
  // Community Row (Friend comments, recommendations & watching activity)
  // =========================================================================
  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 60) return 'poco fa';
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins}m fa`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h fa`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}g fa`;
    return new Date(timestamp).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  }

  async renderCommunityRow() {
    if (this._communityRowPromise) {
      return this._communityRowPromise;
    }
    this._communityRowPromise = this._executeRenderCommunityRow().finally(() => {
      this._communityRowPromise = null;
    });
    return this._communityRowPromise;
  }

  async _executeRenderCommunityRow() {
    const rowsWrapper = document.getElementById('home-rows-container');
    if (!rowsWrapper) return;

    // Purge any preexisting duplicate community rows
    const staleRows = rowsWrapper.querySelectorAll('#community-row');
    if (staleRows.length > 1) {
      for (let i = 1; i < staleRows.length; i++) {
        staleRows[i].remove();
      }
    }

    try {
      const feedItems = await SupabaseService.getCommunityFeed();

      // Whenever fresh community feed arrives, refresh social stack avatars across all cards!
      this.updateCardsSocialStacks();

      const currentWrapper = document.getElementById('home-rows-container');
      if (!currentWrapper) return;

      const currentRows = currentWrapper.querySelectorAll('#community-row');
      if (!feedItems || feedItems.length === 0) {
        currentRows.forEach(el => el.remove());
        return;
      }

      // Keep at most 1 community row element
      if (currentRows.length > 1) {
        for (let i = 1; i < currentRows.length; i++) {
          currentRows[i].remove();
        }
      }

      let container = currentWrapper.querySelector('#community-row');
      if (!container) {
        container = document.createElement('div');
        container.id = 'community-row';
        container.className = 'content-row';
      }

      // Position right after continue-watching-row if present, or as first element in rows container
      const contRow = document.getElementById('continue-watching-row');
      if (contRow && contRow.nextSibling !== container) {
        currentWrapper.insertBefore(container, contRow.nextSibling);
      } else if (!contRow && currentWrapper.firstChild !== container) {
        currentWrapper.insertBefore(container, currentWrapper.firstChild);
      }

      container.innerHTML = `
        <div class="row-header">
          <h2 class="row-title">
            <span>👥 Community</span>
            <span style="font-size: 0.85rem; color: var(--text-muted); font-weight: 500;">Attività e consigli degli amici</span>
          </h2>
        </div>
        <div class="row-carousel" id="carousel-community">
          ${feedItems.map(item => {
            const timeAgo = this.formatTimeAgo(item.timestamp);
            const isRec = item.feedType === 'recommendation';
            const isWatching = item.feedType === 'watching';
            const isSaturn = (item.source === 'animesaturn' || String(item.mediaId).startsWith('saturn_'));
            const cleanTitle = isSaturn ? (window.AnimeSaturnService?.cleanAnimeTitle(item.title) || item.title) : item.title;

            const posterUrl = (item.posterPath || item.backdropPath || '');
            const imgUrl = (posterUrl.startsWith('http')) 
              ? posterUrl 
              : (posterUrl ? TMDBService.getPosterUrl(posterUrl, 'w185') : 'assets/icon.png');

            let actionText = 'ha commentato';
            let actionClass = '';
            let bodyContent = `<div class="community-card-body">"${this.escapeHtml(item.text || '')}"</div>`;

            if (isRec) {
              actionText = 'consiglia assolutamente';
              actionClass = 'is-rec';
              bodyContent = `
                <div class="community-card-body rec-body">
                  <span>★ Da vedere assolutamente!</span>
                </div>
              `;
            } else if (isWatching) {
              const isCompleted = item.watchStatus === 'completed';
              const isDropped = item.watchStatus === 'dropped';
              actionText = item.actionText || (isDropped ? 'ha droppato' : (isCompleted ? 'ha visto' : 'sta guardando'));
              actionClass = item.actionClass || (isDropped ? 'is-dropped' : (isCompleted ? 'is-completed' : 'is-watching'));
              const defaultText = isDropped ? 'Ha abbandonato la visione (non piaciuto)' : (isCompleted ? 'Ha completato la visione' : 'In riproduzione');
              const bodyColor = isDropped ? '#f59e0b' : 'var(--text-med)';
              bodyContent = `<div class="community-card-body" style="color: ${bodyColor}; font-size: 0.88rem;">${this.escapeHtml(item.text || defaultText)}</div>`;
            }

            const avatarHtml = item.avatar_url 
              ? `<img src="${item.avatar_url}" class="profile-avatar-img" alt="${this.escapeHtml(item.username)}" onerror="this.outerHTML='${this.escapeHtml(item.avatar_emoji || '🍿')}'" />`
              : this.escapeHtml(item.avatar_emoji || '🍿');

            const cardTypeClass = isRec 
              ? 'type-recommendation' 
              : (item.watchStatus === 'dropped' ? 'type-dropped' : (item.watchStatus === 'completed' ? 'type-completed' : 'type-watching'));

            return `
              <div class="community-feed-card navigable focus-compact ${cardTypeClass}" tabindex="0" data-media-id="${item.mediaId}" data-source="${item.source || 'tmdb'}" data-media-type="${item.mediaType || 'movie'}" data-slug="${item.slug || ''}">
                <div class="community-card-top">
                  <div class="community-user-info">
                    <div class="community-user-avatar">${avatarHtml}</div>
                    <div class="community-user-text">
                      <div class="community-user-name">${this.escapeHtml(item.username || 'Amico')}</div>
                      <div class="community-action-tag ${actionClass}">${actionText}</div>
                    </div>
                  </div>
                  <div class="community-time-ago">${timeAgo}</div>
                </div>

                ${bodyContent}

                <div class="community-card-media-chip">
                  <img src="${imgUrl}" alt="${this.escapeHtml(cleanTitle)}" class="community-media-thumb" loading="lazy" />
                  <div class="community-media-meta">
                    <div class="community-media-title">${isSaturn ? '🪐 ' : ''}${this.escapeHtml(cleanTitle)}</div>
                    <div class="community-media-sub">${isSaturn ? 'Anime' : (item.mediaType === 'tv' ? 'Serie TV' : 'Film')}</div>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;

      this.setupCarouselArrows(container);

      // Attach click events: opening the media details modal
      container.querySelectorAll('.community-feed-card').forEach(card => {
        card.addEventListener('click', () => {
          const mediaId = card.getAttribute('data-media-id');
          const source = card.getAttribute('data-source');
          const mediaType = card.getAttribute('data-media-type');
          const slug = card.getAttribute('data-slug');
          this.lastFocusedElement = card;
          this.openDetailsModal({
            id: mediaId,
            source: source,
            media_type: mediaType,
            slug: slug
          });
        });
      });
    } catch (e) {
      console.warn('[Roxy] Failed to render community row:', e);
      if (container) container.remove();
    }
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
    this.updateCardsSocialStacks(row);
    this.setupCarouselArrows(row);

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
      const mediaType = item.media_type || (item.name && !item.title ? 'tv' : 'movie');
      const fullDetails = await TMDBService.getDetails(item.id, mediaType);
      data = fullDetails || item;
      // Ensure media_type is explicitly retained
      if (!data.media_type) data.media_type = mediaType;
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
        const isTvModal = (data.media_type === 'tv' || (data.media_type !== 'movie' && (data.number_of_seasons !== undefined || (data.name && !data.title))));

        badgesEl.innerHTML = `
          <span class="badge-indigo">${isTvModal ? 'SERIE TV' : 'FILM'}</span>
          ${!isAvailable ? `<span class="badge-unavailable">NON DISPONIBILE</span>` : ''}
          <span class="badge-rating">★ ${rating}</span>
          ${duration ? `<span class="badge-quality">${duration}</span>` : ''}
          ${year ? `<span style="color: var(--text-med); font-weight: 600;">${year}</span>` : ''}
        `;
      }
    }

    // Populate compact social viewers strip before overview
    const modalSocialViewers = document.getElementById('modal-social-viewers');
    const refreshModalSocialViewers = async () => {
      if (!modalSocialViewers) return;
      let viewers = (window.SupabaseService && typeof SupabaseService.getMediaSocialActivity === 'function')
        ? [...SupabaseService.getMediaSocialActivity(data.id, true)]
        : [];

      // Check recommendations
      let recUsers = [];
      try {
        if (window.SupabaseService && typeof SupabaseService.getCommentsForMedia === 'function') {
          const allComments = await SupabaseService.getCommentsForMedia(data.id);
          recUsers = allComments.filter(c => c.comment_type === 'recommendation');
        }
      } catch (e) {}

      const activeUser = (window.SupabaseService && typeof SupabaseService.getActiveUser === 'function')
        ? SupabaseService.getActiveUser()
        : null;

      if (activeUser) {
        const activeUserId = String(activeUser.id);
        const myProgress = StorageService.getItemProgress(data.id);
        const myDropped = StorageService.isDropped(data.id);
        const myCont = StorageService.getContinueWatching().some(i => String(i.id) === String(data.id));
        const myCompleted = !!(myProgress && (myProgress.progress >= 95 || myProgress.isCompleted));
        const myStarted = !!(myProgress && (myProgress.currentTime > 5 || myProgress.progress > 0)) || myCont;
        const myRec = recUsers.some(r => String(r.user_id) === activeUserId);

        const existingIdx = viewers.findIndex(v => v.userId === activeUserId);
        if (myDropped || myCompleted || myStarted || myRec) {
          const myStatus = myRec ? 'recommended' : (myDropped ? 'dropped' : (myCompleted ? 'completed' : 'watching'));
          const myEntry = {
            userId: activeUserId,
            username: activeUser.username || 'Tu',
            avatar_emoji: activeUser.avatar_emoji || '🍿',
            avatar_url: activeUser.avatar_url || null,
            status: myStatus,
            isRecommended: myRec,
            progress: myProgress ? myProgress.progress : 0
          };
          if (existingIdx >= 0) {
            viewers[existingIdx] = myEntry;
          } else {
            viewers.unshift(myEntry);
          }
        } else if (existingIdx >= 0) {
          viewers.splice(existingIdx, 1);
        }
      }

      // Add other friends who recommended this title
      for (const rec of recUsers) {
        const rUserId = String(rec.user_id);
        const existing = viewers.find(v => v.userId === rUserId);
        if (existing) {
          existing.isRecommended = true;
        } else {
          viewers.push({
            userId: rUserId,
            username: rec.username || 'Amico',
            avatar_emoji: rec.avatar_emoji || '🍿',
            avatar_url: rec.avatar_url || null,
            status: 'recommended',
            isRecommended: true,
            progress: 0
          });
        }
      }

      const commentsCount = (document.getElementById('modal-comments-count')?.textContent) || '0';

      if (viewers && viewers.length > 0) {
        modalSocialViewers.style.display = 'flex';
        modalSocialViewers.innerHTML = `
          <div class="social-viewers-header">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="social-viewers-icon">👥</span>
              <span class="social-viewers-title">Amici & Community (${viewers.length})</span>
            </div>
            <button id="modal-btn-jump-comments" class="btn-jump-comments navigable focus-compact" type="button" title="Scorri rapidamente ai commenti">
              💬 Commenti <span class="jump-comments-count-pill" id="modal-jump-comments-count">${commentsCount}</span>
            </button>
          </div>
          <div class="social-viewers-list">
            ${viewers.map(v => {
              const isRec = v.isRecommended || v.status === 'recommended';
              const isDropped = v.status === 'dropped';
              const isCompleted = v.status === 'completed';
              const avatarHtml = v.avatar_url
                ? `<img src="${v.avatar_url}" class="social-viewer-avatar-img" alt="${this.escapeHtml(v.username)}" onerror="this.outerHTML='${this.escapeHtml(v.avatar_emoji || '🍿')}'" />`
                : this.escapeHtml(v.avatar_emoji || '🍿');

              let statusClass = 'status-watching';
              let badgeClass = 'badge-watching';
              let statusLabel = '▶ Sta guardando';

              if (isRec) {
                statusClass = 'status-recommended';
                badgeClass = 'badge-recommended';
                statusLabel = '★ Consigliato';
              } else if (isDropped) {
                statusClass = 'status-dropped';
                badgeClass = 'badge-dropped';
                statusLabel = '👎 Ha droppato';
              } else if (isCompleted) {
                statusClass = 'status-completed';
                badgeClass = 'badge-completed';
                statusLabel = '✓ Ha visto';
              }

              return `
                <div class="social-viewer-pill ${statusClass}">
                  <div class="social-viewer-avatar">${avatarHtml}</div>
                  <span class="social-viewer-name">${this.escapeHtml(v.username)}</span>
                  <span class="social-viewer-badge ${badgeClass}">
                    ${statusLabel}
                  </span>
                </div>
              `;
            }).join('')}
          </div>
        `;

        const jumpBtn = modalSocialViewers.querySelector('#modal-btn-jump-comments');
        if (jumpBtn) {
          jumpBtn.onclick = (e) => {
            e.stopPropagation();
            const commentsSec = document.querySelector('.modal-comments-section');
            if (commentsSec) {
              commentsSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          };
        }
      } else {
        modalSocialViewers.style.display = 'none';
        modalSocialViewers.innerHTML = '';
      }
    };
    refreshModalSocialViewers();

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
            ${data.episodes.map(ep => {
              const epProg = StorageService.getItemProgress(data.id, 1, ep.episode_number);
              const hasProg = epProg && epProg.progress > 0;
              const isComp = epProg && epProg.progress >= 95;
              return `
              <div class="episode-card navigable" tabindex="0" data-episode="${ep.episode_number}">
                <div class="episode-thumb-wrap">
                  <img src="${(ep.still_path && ep.still_path.startsWith('http')) ? ep.still_path : (data.backdrop_path || data.poster_path)}" alt="${ep.name}" loading="lazy" />
                  ${hasProg ? `
                    <div class="episode-progress-bar">
                      <div class="episode-progress-fill" style="width: ${isComp ? 100 : epProg.progress}%;"></div>
                    </div>
                  ` : ''}
                </div>
                <div class="episode-info">
                  <div class="episode-title-row">
                    <div class="episode-number-title">${ep.episode_number}. ${ep.name || `Episodio ${ep.episode_number}`}</div>
                    <div style="display:flex; align-items:center; gap:8px;">
                      <span class="${data.isDub ? 'badge-dub' : 'badge-sub'}">${data.isDub ? 'DUB' : 'SUB'}</span>
                      ${isComp ? `<span class="episode-badge-completed">✓ Visto</span>` : ''}
                    </div>
                  </div>
                  <div class="episode-overview">${ep.overview || `Episodio ${ep.episode_number}`}</div>
                </div>
              </div>
            `;}).join('')}
          </div>
        `;

        // Episode click handlers
        episodesContainer.querySelectorAll('.episode-card').forEach(epCard => {
          epCard.addEventListener('click', () => {
            const epNum = parseInt(epCard.getAttribute('data-episode'));
            const epData = data.episodes.find(e => e.episode_number === epNum);
            const epSaved = StorageService.getItemProgress(data.id, 1, epNum);
            const epResumeSec = (epSaved && epSaved.currentTime > 5 && epSaved.progress < 95) ? epSaved.currentTime : null;
            this.closeModal();
            PlayerController.play({
              ...data,
              source: 'animesaturn',
              slug: data.slug || item.slug,
              episode: epNum,
              episode_name: epData ? epData.name : `Episodio ${epNum}`
            }, null, epResumeSec);
          });
        });
      } else if (!isSaturn && (data.media_type === 'tv' || (data.media_type !== 'movie' && (data.name && !data.title))) && data.seasons && data.seasons.length > 0) {
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
            const epProg = StorageService.getItemProgress(data.id, seasonNum, ep.episode_number);
            const hasProg = epProg && epProg.progress > 0;
            const isComp = epProg && epProg.progress >= 95;
            return `
            <div class="episode-card navigable ${epAvail ? '' : 'unavailable'}" tabindex="0" data-season="${seasonNum}" data-episode="${ep.episode_number}" data-avail="${epAvail}">
              <div class="episode-thumb-wrap">
                <img src="${TMDBService.getBackdropUrl(ep.still_path || data.backdrop_path, 'w500')}" alt="${ep.name}" loading="lazy" />
                ${hasProg ? `
                  <div class="episode-progress-bar">
                    <div class="episode-progress-fill" style="width: ${isComp ? 100 : epProg.progress}%;"></div>
                  </div>
                ` : ''}
              </div>
              <div class="episode-info">
                <div class="episode-title-row">
                  <div class="episode-number-title">${ep.episode_number}. ${ep.name || `Episodio ${ep.episode_number}`}</div>
                  <div style="display:flex; align-items:center; gap:8px;">
                    ${!epAvail ? `<span class="badge-unavailable">Non disp.</span>` : ''}
                    ${isComp ? `<span class="episode-badge-completed">✓ Visto</span>` : ''}
                    <div class="episode-runtime">${ep.runtime ? `${ep.runtime} min` : ''}</div>
                  </div>
                </div>
                <div class="episode-overview">${ep.overview || 'Nessuna descrizione disponibile.'}</div>
              </div>
            </div>
          `;}).join('');

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
              const epSaved = StorageService.getItemProgress(data.id, sNum, eNum);
              const epResumeSec = (epSaved && epSaved.currentTime > 5 && epSaved.progress < 95) ? epSaved.currentTime : null;
              this.closeModal();
              PlayerController.play({
                ...data,
                media_type: 'tv',
                season: sNum,
                episode: eNum,
                episode_name: epData ? epData.name : ''
              }, null, epResumeSec);
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

    // Modal Action Buttons (Handle Available / Unavailable State & Smart Resume)
    if (btnPlay) {
      if (isAvailable) {
        btnPlay.className = 'btn-primary-play navigable';
        
        const isTv = !isSaturn && (data.media_type === 'tv' || (data.media_type !== 'movie' && (data.number_of_seasons !== undefined || (!!data.name && !data.title))));
        const savedProgress = StorageService.getItemProgress(data.id);
        
        let playBtnLabel = isSaturn ? 'Riproduci Ep. 1' : 'Riproduci';
        let playPayload = isSaturn ? { ...data, episode: 1 } : (isTv ? { ...data, media_type: 'tv', season: 1, episode: 1 } : { ...data, media_type: 'movie', season: 0, episode: 0 });
        let playResumeTime = null;

        if (savedProgress && savedProgress.currentTime > 5 && savedProgress.progress < 95) {
          const currentMins = Math.floor(savedProgress.currentTime / 60);
          playResumeTime = savedProgress.currentTime;

          if (isSaturn) {
            playBtnLabel = `Riprendi Ep. ${savedProgress.episode || 1} (${currentMins}m)`;
            playPayload = { ...data, episode: savedProgress.episode || 1 };
          } else if (isTv) {
            playBtnLabel = `Riprendi S${savedProgress.season || 1}:E${savedProgress.episode || 1} (${currentMins}m)`;
            playPayload = { ...data, media_type: 'tv', season: savedProgress.season || 1, episode: savedProgress.episode || 1 };
          } else {
            playBtnLabel = `Riprendi da ${currentMins}m`;
            playPayload = { ...data, media_type: 'movie', season: 0, episode: 0 };
          }
        }

        btnPlay.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> ${playBtnLabel}`;
        btnPlay.onclick = () => {
          this.closeModal();
          PlayerController.play(playPayload, null, playResumeTime);
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
        this.renderWatchlist();
        this.renderHomeWatchlistRow();
      };
    }

    const mediaId = String(data.id);

    // "Rimuovi da Continua a guardare" Button Handler
    const btnRemoveContinue = document.getElementById('modal-btn-remove-continue');
    const isContinueWatching = StorageService.getContinueWatching().some(i => String(i.id) === mediaId);
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

    // "Droppa" (Pollice in giù / Giallo-Arancione) Button Handler
    // Mostrato solo se l'utente sta già guardando il contenuto, o l'ha già visto/droppato
    const btnDrop = document.getElementById('modal-btn-drop');
    if (btnDrop) {
      const dropLabel = btnDrop.querySelector('.drop-label');
      const itemProgress = StorageService.getItemProgress(mediaId);
      const hasProgress = !!(itemProgress && itemProgress.currentTime > 0);
      let isDropped = StorageService.isDropped(mediaId);
      const activeUser = (window.SupabaseService && typeof SupabaseService.getActiveUser === 'function')
        ? SupabaseService.getActiveUser()
        : null;
      const activeUserId = activeUser ? String(activeUser.id) : null;
      const userActivity = (activeUserId && typeof SupabaseService.getMediaSocialActivity === 'function')
        ? (SupabaseService.getMediaSocialActivity(mediaId, true) || []).find(v => v.userId === activeUserId)
        : null;

      const isUserWatchingOrWatched = hasProgress || isContinueWatching || isDropped || !!userActivity;

      const updateDropUI = (dropped) => {
        if (dropped) {
          btnDrop.classList.add('is-dropped');
          if (dropLabel) dropLabel.textContent = 'Droppato';
          btnDrop.setAttribute('title', 'Contenuto droppato (clicca per ripristinare)');
        } else {
          btnDrop.classList.remove('is-dropped');
          if (dropLabel) dropLabel.textContent = 'Droppa';
          btnDrop.setAttribute('title', 'Droppa contenuto (non piaciuto)');
        }
      };

      if (isUserWatchingOrWatched) {
        btnDrop.style.display = 'inline-flex';
        updateDropUI(isDropped);

        if (activeUser) {
          SupabaseService.isMediaDropped(mediaId).then(cloudDropped => {
            if (typeof cloudDropped === 'boolean' && cloudDropped !== isDropped) {
              isDropped = cloudDropped;
              StorageService.setMediaDropped(mediaId, cloudDropped);
              updateDropUI(cloudDropped);
              refreshModalSocialViewers();
            }
          }).catch(() => {});
        }

        btnDrop.onclick = async () => {
          btnDrop.disabled = true;
          try {
            const nextDropped = !isDropped;
            isDropped = nextDropped;
            StorageService.setMediaDropped(mediaId, nextDropped);
            updateDropUI(nextDropped);

            if (activeUser) {
              await SupabaseService.setMediaDropped(mediaId, nextDropped, data);
            }

            if (nextDropped) {
              this.showToast(`Hai droppato "${data.title || data.name}". 👎`);
              if (btnRemoveContinue) {
                btnRemoveContinue.style.display = 'none';
              }
            } else {
              this.showToast(`Rimosso lo stato droppato per "${data.title || data.name}".`);
            }

            this.renderContinueWatchingRow();
            this.renderCommunityRow();
            this.updateCardsSocialStacks();
            refreshModalSocialViewers();
            if (typeof refreshModalProgressButtons === 'function') refreshModalProgressButtons();
          } catch (err) {
            console.error('[Roxy] Error updating dropped status:', err);
            this.showToast('Errore durante l\'aggiornamento dello stato.');
          } finally {
            btnDrop.disabled = false;
          }
        };
      } else {
        btnDrop.style.display = 'none';
      }
    }

    // "Segna come finito" and "Segna come Da guardare" (Azzera progressi) Handlers
    const btnMarkFinished = document.getElementById('modal-btn-mark-finished');
    const btnResetProgress = document.getElementById('modal-btn-reset-progress');

    const refreshModalProgressButtons = () => {
      const p = StorageService.getItemProgress(mediaId);
      const isCont = StorageService.getContinueWatching().some(i => String(i.id) === mediaId);
      const currDropped = StorageService.isDropped(mediaId);
      const currStarted = !!(p && (p.currentTime > 5 || p.progress > 0)) || isCont;
      const isSaturnItem = (data.source === 'animesaturn' || mediaId.startsWith('saturn_'));
      const isTvItem = !isSaturnItem && (data.media_type === 'tv' || (data.media_type !== 'movie' && (data.number_of_seasons !== undefined || (!!data.name && !data.title))));
      const isSeriesItem = isTvItem || isSaturnItem || data.media_type === 'anime';
      const currCompleted = !!(p && (p.isCompleted || (!isSeriesItem && p.progress >= 95) || (isSeriesItem && p.isLastEpisode && p.progress >= 95)));

      if (btnMarkFinished) {
        if (!currCompleted) {
          btnMarkFinished.style.display = 'inline-flex';
        } else {
          btnMarkFinished.style.display = 'none';
        }
      }

      if (btnResetProgress) {
        if (currStarted || currCompleted || currDropped) {
          btnResetProgress.style.display = 'inline-flex';
        } else {
          btnResetProgress.style.display = 'none';
        }
      }
    };

    refreshModalProgressButtons();

    if (btnMarkFinished) {
      btnMarkFinished.onclick = async () => {
        btnMarkFinished.disabled = true;
        try {
          StorageService.setMediaCompleted(mediaId, true, data);
          this.showToast(`"${data.title || data.name}" segnato come finito! ✓`);
          refreshModalProgressButtons();
          refreshModalSocialViewers();
          if (btnRemoveContinue) btnRemoveContinue.style.display = 'none';
          this.renderContinueWatchingRow();
          this.renderCommunityRow();
          this.updateCardsSocialStacks();
        } catch (e) {
          console.error('[Roxy] Error marking as finished:', e);
        } finally {
          btnMarkFinished.disabled = false;
        }
      };
    }

    if (btnResetProgress) {
      btnResetProgress.onclick = async () => {
        btnResetProgress.disabled = true;
        try {
          StorageService.resetMediaProgress(mediaId);
          this.showToast(`Progressi azzerati per "${data.title || data.name}". Segnato come Da guardare.`);
          refreshModalProgressButtons();
          refreshModalSocialViewers();
          if (btnRemoveContinue) btnRemoveContinue.style.display = 'none';
          this.renderContinueWatchingRow();
          this.renderCommunityRow();
          this.updateCardsSocialStacks();
        } catch (e) {
          console.error('[Roxy] Error resetting progress:', e);
        } finally {
          btnResetProgress.disabled = false;
        }
      };
    }

    // =========================================================================
    // Community: Recommendation ("Da vedere assolutamente") & Comments
    // =========================================================================
    const btnRec = document.getElementById('modal-btn-recommend');
    const commentUserAvatar = document.getElementById('comment-current-user-avatar');
    const commentInput = document.getElementById('comment-input-text');
    const commentCharCounter = document.getElementById('comment-char-counter');
    const btnSubmitComment = document.getElementById('btn-submit-comment');
    const modalCommentsList = document.getElementById('modal-comments-list');
    const modalCommentsCount = document.getElementById('modal-comments-count');

    // 1. Set current user avatar preview in comment input
    const activeUser = SupabaseService.getActiveUser();
    if (commentUserAvatar) {
      if (activeUser) {
        this.setAvatarElement(commentUserAvatar, activeUser);
      } else {
        commentUserAvatar.textContent = '🍿';
      }
    }

    // 2. Reset comment input state & bind character counter
    if (commentInput) {
      commentInput.value = '';
      commentInput.maxLength = 300;
      if (commentCharCounter) {
        commentCharCounter.textContent = '0/300';
        commentCharCounter.style.color = 'var(--text-dim)';
      }
      commentInput.oninput = () => {
        const len = commentInput.value.length;
        if (commentCharCounter) {
          commentCharCounter.textContent = `${len}/300`;
          commentCharCounter.style.color = len >= 290 ? '#ef4444' : 'var(--text-dim)';
        }
      };
      commentInput.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
          e.preventDefault();
          if (btnSubmitComment) btnSubmitComment.click();
        }
      };
    }

    // 3. Comments loader helper for this media
    const loadModalComments = async () => {
      if (!modalCommentsList) return;
      modalCommentsList.innerHTML = '<div class="comments-loading">Caricamento commenti community...</div>';

      try {
        const comments = await SupabaseService.getCommentsForMedia(mediaId);
        if (modalCommentsCount) {
          modalCommentsCount.textContent = String(comments.length);
        }
        const jumpCount = document.getElementById('modal-jump-comments-count');
        if (jumpCount) {
          jumpCount.textContent = String(comments.length);
        }

        if (comments.length === 0) {
          modalCommentsList.innerHTML = '<div class="comments-empty">Nessun commento finora. Lascia il primo commento per i tuoi amici! 🍿</div>';
          return;
        }

        const activeUser = SupabaseService.getActiveUser();

        modalCommentsList.innerHTML = comments.map(c => {
          const isRec = c.comment_type === 'recommendation';
          const isOwn = activeUser && String(activeUser.id) === String(c.user_id);
          const timeAgo = this.formatTimeAgo(new Date(c.created_at).getTime());
          const avatarHtml = c.avatar_url
            ? `<img src="${c.avatar_url}" class="profile-avatar-img" alt="${this.escapeHtml(c.username)}" onerror="this.outerHTML='${this.escapeHtml(c.avatar_emoji || '🍿')}'" />`
            : this.escapeHtml(c.avatar_emoji || '🍿');

          return `
            <div class="comment-card ${isRec ? 'is-recommendation' : ''}">
              <div class="comment-card-avatar">${avatarHtml}</div>
              <div class="comment-card-body">
                <div class="comment-card-header">
                  <div class="comment-author-name">
                    <span>${this.escapeHtml(c.username || 'Amico')}</span>
                    ${isRec ? '<span class="badge-rec-star">★ Consigliato</span>' : ''}
                  </div>
                  <div class="comment-header-right">
                    <div class="comment-time">${timeAgo}</div>
                    ${isOwn ? `
                      <button class="btn-delete-comment navigable focus-compact" data-comment-id="${c.id}" data-is-rec="${isRec}" title="Elimina commento" aria-label="Elimina commento">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <polyline points="3 6 5 6 21 6"></polyline>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                      </button>
                    ` : ''}
                  </div>
                </div>
                <div class="comment-card-text">${this.escapeHtml(c.comment_text)}</div>
              </div>
            </div>
          `;
        }).join('');

        // Wire up delete handlers for user's own comments
        modalCommentsList.querySelectorAll('.btn-delete-comment').forEach(delBtn => {
          delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const commentId = delBtn.getAttribute('data-comment-id');
            const isRecComment = delBtn.getAttribute('data-is-rec') === 'true';
            if (!commentId) return;

            const confirmMsg = isRecComment
              ? 'Vuoi rimuovere questo consiglio da "Da vedere assolutamente"?'
              : 'Sei sicuro di voler cancellare questo commento?';

            if (!window.confirm(confirmMsg)) return;

            delBtn.disabled = true;
            try {
              await SupabaseService.deleteComment(commentId);
              this.showToast('Commento eliminato con successo.');
              await loadModalComments();
              this.renderCommunityRow();

              // If recommendation was deleted, update recommend button state
              if (btnRec && isRecComment) {
                const stillRec = await SupabaseService.hasUserRecommended(mediaId);
                if (!stillRec) {
                  btnRec.classList.remove('recommended');
                  const recLabel = btnRec.querySelector('.recommend-label');
                  if (recLabel) recLabel.textContent = 'Da vedere assolutamente';
                }
              }
            } catch (err) {
              console.error('[Roxy] Error deleting comment:', err);
              this.showToast('Errore durante l\'eliminazione del commento.');
            } finally {
              delBtn.disabled = false;
            }
          });
        });
      } catch (err) {
        console.warn('[Roxy] Error loading modal comments:', err);
        modalCommentsList.innerHTML = '<div class="comments-empty">Impossibile caricare i commenti in questo momento.</div>';
      }
    };

    loadModalComments();

    // 4. Recommendation Button ("Da vedere assolutamente")
    if (btnRec) {
      const recLabel = btnRec.querySelector('.recommend-label');
      btnRec.classList.remove('recommended');
      if (recLabel) recLabel.textContent = 'Da vedere assolutamente';

      SupabaseService.hasUserRecommended(mediaId).then(hasRec => {
        if (hasRec) {
          btnRec.classList.add('recommended');
          if (recLabel) recLabel.textContent = 'Consigliato da te';
        }
      }).catch(() => {});

      btnRec.onclick = async () => {
        const user = SupabaseService.getActiveUser();
        if (!user) {
          this.showToast('Accedi o crea un profilo per consigliare i contenuti!');
          return;
        }

        btnRec.disabled = true;
        try {
          const res = await SupabaseService.toggleRecommendation(data);
          if (res && res.recommended) {
            btnRec.classList.add('recommended');
            if (recLabel) recLabel.textContent = 'Consigliato da te';
            this.showToast('Aggiunto a "Da vedere assolutamente" per la Community!');
          } else {
            btnRec.classList.remove('recommended');
            if (recLabel) recLabel.textContent = 'Da vedere assolutamente';
            this.showToast('Rimosso da "Da vedere assolutamente".');
          }
          await loadModalComments();
          this.renderCommunityRow();
        } catch (err) {
          console.error('[Roxy] Error toggling recommendation:', err);
          this.showToast('Errore durante l\'aggiornamento del consiglio.');
        } finally {
          btnRec.disabled = false;
        }
      };
    }

    // 5. Community Privacy Toggle ("Nascondi alla community")
    const btnCommVis = document.getElementById('modal-btn-community-visibility');
    if (btnCommVis) {
      const visLabel = btnCommVis.querySelector('.community-visibility-label');
      const isHidden = StorageService.isCommunityHidden(mediaId);

      const updateVisibilityUI = (hidden) => {
        if (hidden) {
          btnCommVis.classList.add('is-hidden-community');
          if (visLabel) visLabel.textContent = 'Nascosto alla community';
          btnCommVis.setAttribute('title', 'Nascosto alla community (clicca per mostrare)');
        } else {
          btnCommVis.classList.remove('is-hidden-community');
          if (visLabel) visLabel.textContent = 'Nascondi alla community';
          btnCommVis.setAttribute('title', 'Nascondi alla community');
        }
      };

      updateVisibilityUI(isHidden);

      // Verify remote cloud state if user profile is logged in
      if (SupabaseService.getActiveUser()) {
        SupabaseService.isMediaCommunityHidden(mediaId).then(cloudHidden => {
          if (typeof cloudHidden === 'boolean' && cloudHidden !== isHidden) {
            StorageService.setCommunityHidden(mediaId, cloudHidden);
            updateVisibilityUI(cloudHidden);
          }
        }).catch(() => {});
      }

      btnCommVis.onclick = () => {
        const newHidden = StorageService.toggleCommunityHidden(mediaId);
        updateVisibilityUI(newHidden);
        if (newHidden) {
          this.showToast('Contenuto nascosto alla sezione Community degli altri!');
        } else {
          this.showToast('Contenuto ora visibile alla sezione Community degli altri.');
        }
        this.renderCommunityRow();
      };
    }

    // 6. Submit Comment Button
    if (btnSubmitComment && commentInput) {
      btnSubmitComment.onclick = async () => {
        const user = SupabaseService.getActiveUser();
        if (!user) {
          this.showToast('Accedi o crea un profilo per commentare!');
          return;
        }

        const text = commentInput.value.trim();
        if (!text) {
          this.showToast('Scrivi un commento prima di inviare.');
          return;
        }

        btnSubmitComment.disabled = true;
        try {
          await SupabaseService.addComment(data, text);
          commentInput.value = '';
          if (commentCharCounter) {
            commentCharCounter.textContent = '0/300';
            commentCharCounter.style.color = 'var(--text-dim)';
          }
          this.showToast('Commento pubblicato nella Community! 💬');
          await loadModalComments();
          this.renderCommunityRow();
        } catch (err) {
          console.error('[Roxy] Error posting comment:', err);
          this.showToast('Errore durante l\'invio del commento.');
        } finally {
          btnSubmitComment.disabled = false;
        }
      };
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
        const user = SupabaseService.getActiveUser();
        if (user) {
          this.openUserProfile(user.id);
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

    // Create Profile Avatar Selector (Emoji vs Photo)
    this.createAvatarType = 'emoji';
    this.createPhotoData = null;
    this.selectedNewEmoji = '🍿';

    const createTabEmoji = document.getElementById('create-tab-emoji');
    const createTabPhoto = document.getElementById('create-tab-photo');
    const createContentEmoji = document.getElementById('create-content-emoji');
    const createContentPhoto = document.getElementById('create-content-photo');

    if (createTabEmoji && createTabPhoto) {
      createTabEmoji.addEventListener('click', () => {
        this.createAvatarType = 'emoji';
        createTabEmoji.classList.add('active');
        createTabPhoto.classList.remove('active');
        if (createContentEmoji) createContentEmoji.style.display = 'block';
        if (createContentPhoto) createContentPhoto.style.display = 'none';
      });

      createTabPhoto.addEventListener('click', () => {
        this.createAvatarType = 'photo';
        createTabPhoto.classList.add('active');
        createTabEmoji.classList.remove('active');
        if (createContentPhoto) createContentPhoto.style.display = 'block';
        if (createContentEmoji) createContentEmoji.style.display = 'none';
      });
    }

    // Create Profile Emoji Picker
    const emojiBtns = document.querySelectorAll('#emoji-picker .emoji-btn');
    emojiBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        emojiBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedNewEmoji = btn.getAttribute('data-emoji') || '🍿';
      });
    });

    // Create Profile Photo Upload
    const createPhotoInput = document.getElementById('create-photo-input');
    const btnCreateChoosePhoto = document.getElementById('btn-create-choose-photo');
    const createPhotoPreview = document.getElementById('create-photo-preview');
    const btnCreateRemovePhoto = document.getElementById('btn-create-remove-photo');
    const createPhotoHint = document.getElementById('create-photo-hint');

    const triggerCreatePhotoSelect = () => {
      if (createPhotoInput) createPhotoInput.click();
    };

    if (btnCreateChoosePhoto) btnCreateChoosePhoto.addEventListener('click', triggerCreatePhotoSelect);
    if (createPhotoPreview) createPhotoPreview.addEventListener('click', triggerCreatePhotoSelect);

    if (createPhotoInput) {
      createPhotoInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (createPhotoHint) createPhotoHint.textContent = 'Elaborazione e compressione in corso...';
        try {
          const compressed = await SupabaseService.compressImage(file, 256, 0.82);
          this.createPhotoData = compressed;
          if (createPhotoPreview) {
            createPhotoPreview.innerHTML = `<img src="${compressed.dataUrl}" class="profile-avatar-img" alt="Anteprima" />`;
          }
          if (btnCreateRemovePhoto) btnCreateRemovePhoto.style.display = 'inline-flex';
          const sizeKb = Math.round(compressed.blob.size / 1024);
          if (createPhotoHint) createPhotoHint.textContent = `Foto pronta (${sizeKb} KB, ottimizzata)`;
        } catch (err) {
          console.error('[Roxy] Errore compressione immagine:', err);
          this.showToast(err.message || 'Errore elaborazione immagine.');
          if (createPhotoHint) createPhotoHint.textContent = 'Errore nel caricamento della foto.';
        }
      });
    }

    if (btnCreateRemovePhoto) {
      btnCreateRemovePhoto.addEventListener('click', () => {
        this.createPhotoData = null;
        if (createPhotoInput) createPhotoInput.value = '';
        if (createPhotoPreview) createPhotoPreview.innerHTML = '<span class="photo-placeholder-icon">📷</span>';
        btnCreateRemovePhoto.style.display = 'none';
        if (createPhotoHint) createPhotoHint.textContent = 'Foto quadrata compressa automaticamente (WebP)';
      });
    }

    // Settings Profile Avatar Selector (Emoji vs Photo)
    this.settingsAvatarType = 'emoji';
    this.settingsPhotoData = null;
    this.settingsPhotoRemoved = false;
    this.selectedSettingsEmoji = '🍿';

    const settingsTabEmoji = document.getElementById('settings-tab-emoji');
    const settingsTabPhoto = document.getElementById('settings-tab-photo');
    const settingsContentEmoji = document.getElementById('settings-content-emoji');
    const settingsContentPhoto = document.getElementById('settings-content-photo');

    if (settingsTabEmoji && settingsTabPhoto) {
      settingsTabEmoji.addEventListener('click', () => {
        this.settingsAvatarType = 'emoji';
        settingsTabEmoji.classList.add('active');
        settingsTabPhoto.classList.remove('active');
        if (settingsContentEmoji) settingsContentEmoji.style.display = 'block';
        if (settingsContentPhoto) settingsContentPhoto.style.display = 'none';
        const avatarBig = document.getElementById('settings-current-avatar');
        if (avatarBig) avatarBig.textContent = this.selectedSettingsEmoji || '🍿';
      });

      settingsTabPhoto.addEventListener('click', () => {
        this.settingsAvatarType = 'photo';
        settingsTabPhoto.classList.add('active');
        settingsTabEmoji.classList.remove('active');
        if (settingsContentPhoto) settingsContentPhoto.style.display = 'block';
        if (settingsContentEmoji) settingsContentEmoji.style.display = 'none';
        const avatarBig = document.getElementById('settings-current-avatar');
        const user = SupabaseService.getActiveUser();
        if (this.settingsPhotoData) {
          if (avatarBig) avatarBig.innerHTML = `<img src="${this.settingsPhotoData.dataUrl}" class="profile-avatar-img" />`;
        } else if (user && user.avatar_url && !this.settingsPhotoRemoved) {
          if (avatarBig) avatarBig.innerHTML = `<img src="${user.avatar_url}" class="profile-avatar-img" />`;
        }
      });
    }

    // Settings Profile Emoji Picker
    const settingsEmojiBtns = document.querySelectorAll('#settings-emoji-picker .settings-emoji-btn');
    settingsEmojiBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        settingsEmojiBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedSettingsEmoji = btn.getAttribute('data-emoji') || '🍿';
        if (this.settingsAvatarType === 'emoji') {
          const avatarBig = document.getElementById('settings-current-avatar');
          if (avatarBig) avatarBig.textContent = this.selectedSettingsEmoji;
        }
      });
    });

    // Settings Profile Photo Upload
    const settingsPhotoInput = document.getElementById('settings-photo-input');
    const btnSettingsChoosePhoto = document.getElementById('btn-settings-choose-photo');
    const settingsPhotoPreview = document.getElementById('settings-photo-preview');
    const btnSettingsRemovePhoto = document.getElementById('btn-settings-remove-photo');
    const settingsPhotoHint = document.getElementById('settings-photo-hint');

    const triggerSettingsPhotoSelect = () => {
      if (settingsPhotoInput) settingsPhotoInput.click();
    };

    if (btnSettingsChoosePhoto) btnSettingsChoosePhoto.addEventListener('click', triggerSettingsPhotoSelect);
    if (settingsPhotoPreview) settingsPhotoPreview.addEventListener('click', triggerSettingsPhotoSelect);

    if (settingsPhotoInput) {
      settingsPhotoInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (settingsPhotoHint) settingsPhotoHint.textContent = 'Elaborazione e compressione in corso...';
        try {
          const compressed = await SupabaseService.compressImage(file, 256, 0.82);
          this.settingsPhotoData = compressed;
          this.settingsPhotoRemoved = false;
          if (settingsPhotoPreview) {
            settingsPhotoPreview.innerHTML = `<img src="${compressed.dataUrl}" class="profile-avatar-img" alt="Anteprima" />`;
          }
          const avatarBig = document.getElementById('settings-current-avatar');
          if (avatarBig) {
            avatarBig.innerHTML = `<img src="${compressed.dataUrl}" class="profile-avatar-img" alt="Avatar" />`;
          }
          if (btnSettingsRemovePhoto) btnSettingsRemovePhoto.style.display = 'inline-flex';
          const sizeKb = Math.round(compressed.blob.size / 1024);
          if (settingsPhotoHint) settingsPhotoHint.textContent = `Foto pronta (${sizeKb} KB, ottimizzata)`;
        } catch (err) {
          console.error('[Roxy] Errore compressione immagine settings:', err);
          this.showToast(err.message || 'Errore elaborazione immagine.');
          if (settingsPhotoHint) settingsPhotoHint.textContent = 'Errore nel caricamento della foto.';
        }
      });
    }

    if (btnSettingsRemovePhoto) {
      btnSettingsRemovePhoto.addEventListener('click', () => {
        this.settingsPhotoData = null;
        this.settingsPhotoRemoved = true;
        if (settingsPhotoInput) settingsPhotoInput.value = '';
        if (settingsPhotoPreview) settingsPhotoPreview.innerHTML = '<span class="photo-placeholder-icon">📷</span>';
        btnSettingsRemovePhoto.style.display = 'none';
        if (settingsPhotoHint) settingsPhotoHint.textContent = 'Foto rimossa. Scegline un\'altra o torna a Emoji.';
        // Revert header avatar to emoji
        const avatarBig = document.getElementById('settings-current-avatar');
        if (avatarBig) avatarBig.textContent = this.selectedSettingsEmoji || '🍿';
        // Auto-switch to emoji tab
        if (settingsTabEmoji) settingsTabEmoji.click();
      });
    }

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

    // Physical / Remote keyboard numbers for PIN (Capture phase stops webOS TV channel switching)
    window.addEventListener('keydown', (e) => {
      const pinModal = document.getElementById('pin-modal');
      if (pinModal && pinModal.style.display !== 'none') {
        const code = e.keyCode || e.which;
        let digit = null;
        if (code >= 48 && code <= 57) digit = String(code - 48);
        else if (code >= 96 && code <= 105) digit = String(code - 96);
        else if (e.key >= '0' && e.key <= '9') digit = e.key;

        if (digit !== null) {
          e.preventDefault();
          e.stopPropagation();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          this.handlePinDigit(digit);
          return false;
        } else if (code === 8 || e.key === 'Backspace') {
          e.preventDefault();
          e.stopPropagation();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          this.handlePinDelete();
          return false;
        } else if (code === 27 || code === 461 || e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          this.closePinModal();
          return false;
        }
      }
    }, true);
  }

  renderAvatarHtml(user, className = 'profile-avatar-img', fallbackEmoji = '🍿') {
    if (user && user.avatar_url) {
      return `<img src="${user.avatar_url}" class="${className}" alt="Avatar" onerror="this.outerHTML='${user.avatar_emoji || fallbackEmoji}'" />`;
    }
    return (user && user.avatar_emoji) ? user.avatar_emoji : fallbackEmoji;
  }

  setAvatarElement(el, user, className = 'profile-avatar-img', fallbackEmoji = '🍿') {
    if (!el) return;
    if (user && user.avatar_url) {
      el.innerHTML = `<img src="${user.avatar_url}" class="${className}" alt="Avatar" onerror="this.outerHTML='${user.avatar_emoji || fallbackEmoji}'" />`;
    } else {
      el.textContent = (user && user.avatar_emoji) ? user.avatar_emoji : fallbackEmoji;
    }
  }

  updateHeaderProfileBadge(user) {
    const avatarEl = document.getElementById('header-user-avatar');
    const nameEl = document.getElementById('header-user-name');
    if (avatarEl && nameEl) {
      if (user) {
        this.setAvatarElement(avatarEl, user);
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
            <div class="profile-avatar-circle">${this.renderAvatarHtml(p)}</div>
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

    if (avatar) this.setAvatarElement(avatar, profile);
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

    // Reset avatar type to emoji
    this.createAvatarType = 'emoji';
    this.createPhotoData = null;
    const createTabEmoji = document.getElementById('create-tab-emoji');
    const createTabPhoto = document.getElementById('create-tab-photo');
    const createContentEmoji = document.getElementById('create-content-emoji');
    const createContentPhoto = document.getElementById('create-content-photo');
    const createPhotoInput = document.getElementById('create-photo-input');
    const createPhotoPreview = document.getElementById('create-photo-preview');
    const btnCreateRemovePhoto = document.getElementById('btn-create-remove-photo');
    const createPhotoHint = document.getElementById('create-photo-hint');

    if (createTabEmoji) createTabEmoji.classList.add('active');
    if (createTabPhoto) createTabPhoto.classList.remove('active');
    if (createContentEmoji) createContentEmoji.style.display = 'block';
    if (createContentPhoto) createContentPhoto.style.display = 'none';
    if (createPhotoInput) createPhotoInput.value = '';
    if (createPhotoPreview) createPhotoPreview.innerHTML = '<span class="photo-placeholder-icon">📷</span>';
    if (btnCreateRemovePhoto) btnCreateRemovePhoto.style.display = 'none';
    if (createPhotoHint) createPhotoHint.textContent = 'Foto quadrata compressa automaticamente (WebP)';

    // Reset emoji selection
    this.selectedNewEmoji = '🍿';
    const emojiBtns = document.querySelectorAll('#create-emoji-picker .profile-emoji-btn');
    emojiBtns.forEach(btn => {
      if (btn.getAttribute('data-emoji') === '🍿') {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

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
    const submitBtn = document.getElementById('btn-submit-create-profile');

    const username = nameInput ? nameInput.value.trim() : '';
    const pin = pinInput ? pinInput.value.trim() : '';
    const emoji = this.selectedNewEmoji || '🍿';

    if (errorMsg) errorMsg.style.display = 'none';

    try {
      if (submitBtn) submitBtn.disabled = true;

      let avatarUrl = null;
      if (this.createAvatarType === 'photo' && this.createPhotoData && this.createPhotoData.blob) {
        if (errorMsg) {
          errorMsg.textContent = 'Caricamento foto in corso...';
          errorMsg.style.display = 'block';
          errorMsg.style.color = 'var(--primary-indigo-light)';
        }
        const ext = this.createPhotoData.format || 'webp';
        avatarUrl = await SupabaseService.uploadAvatar(this.createPhotoData.blob, ext);
      }

      const newUser = await SupabaseService.createProfile(username, pin, emoji, avatarUrl);
      const modal = document.getElementById('create-profile-modal');
      if (modal) modal.style.display = 'none';
      this.closeProfileSelectorModal();
      this.onUserLogin(newUser);
    } catch (e) {
      if (errorMsg) {
        errorMsg.textContent = e.message || 'Errore durante la creazione del profilo.';
        errorMsg.style.display = 'block';
        errorMsg.style.color = '#ef4444';
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
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
    this.setAvatarElement(avatarEl, user);
    if (titleEl) titleEl.textContent = `Profilo di ${user.username}`;
    if (nameInput) nameInput.value = user.username || '';
    if (pinInput) pinInput.value = '';
    if (errorMsg) errorMsg.style.display = 'none';

    // Reset settings photo state
    this.settingsPhotoData = null;
    this.settingsPhotoRemoved = false;

    const settingsTabEmoji = document.getElementById('settings-tab-emoji');
    const settingsTabPhoto = document.getElementById('settings-tab-photo');
    const settingsContentEmoji = document.getElementById('settings-content-emoji');
    const settingsContentPhoto = document.getElementById('settings-content-photo');
    const settingsPhotoInput = document.getElementById('settings-photo-input');
    const settingsPhotoPreview = document.getElementById('settings-photo-preview');
    const btnSettingsRemovePhoto = document.getElementById('btn-settings-remove-photo');
    const settingsPhotoHint = document.getElementById('settings-photo-hint');

    if (settingsPhotoInput) settingsPhotoInput.value = '';

    if (user.avatar_url) {
      // User currently has a custom photo
      this.settingsAvatarType = 'photo';
      if (settingsTabPhoto) settingsTabPhoto.classList.add('active');
      if (settingsTabEmoji) settingsTabEmoji.classList.remove('active');
      if (settingsContentPhoto) settingsContentPhoto.style.display = 'block';
      if (settingsContentEmoji) settingsContentEmoji.style.display = 'none';
      if (settingsPhotoPreview) {
        settingsPhotoPreview.innerHTML = `<img src="${user.avatar_url}" class="profile-avatar-img" alt="Foto attuale" />`;
      }
      if (btnSettingsRemovePhoto) btnSettingsRemovePhoto.style.display = 'inline-flex';
      if (settingsPhotoHint) settingsPhotoHint.textContent = 'Foto profilo attiva. Clicca per cambiarla o rimuoverla.';
    } else {
      // User has emoji avatar
      this.settingsAvatarType = 'emoji';
      if (settingsTabEmoji) settingsTabEmoji.classList.add('active');
      if (settingsTabPhoto) settingsTabPhoto.classList.remove('active');
      if (settingsContentEmoji) settingsContentEmoji.style.display = 'block';
      if (settingsContentPhoto) settingsContentPhoto.style.display = 'none';
      if (settingsPhotoPreview) {
        settingsPhotoPreview.innerHTML = '<span class="photo-placeholder-icon">📷</span>';
      }
      if (btnSettingsRemovePhoto) btnSettingsRemovePhoto.style.display = 'none';
      if (settingsPhotoHint) settingsPhotoHint.textContent = 'Foto quadrata compressa automaticamente (WebP)';
    }

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
    const saveBtn = document.getElementById('btn-settings-save');

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

    try {
      if (saveBtn) saveBtn.disabled = true;

      // Handle Avatar changes
      if (this.settingsAvatarType === 'photo') {
        if (this.settingsPhotoData && this.settingsPhotoData.blob) {
          // A new photo was chosen
          if (errorMsg) {
            errorMsg.textContent = 'Caricamento nuova foto...';
            errorMsg.style.display = 'block';
            errorMsg.style.color = 'var(--primary-indigo-light)';
          }
          const ext = this.settingsPhotoData.format || 'webp';
          const newUrl = await SupabaseService.uploadAvatar(this.settingsPhotoData.blob, ext, user.id);
          updates.avatar_url = newUrl;
        }
      } else {
        // User switched back to emoji or clicked remove photo
        if (user.avatar_url) {
          updates.avatar_url = null;
        }
      }

      if (Object.keys(updates).length === 0) {
        this.closeProfileSettingsModal();
        return;
      }

      const updatedUser = await SupabaseService.updateProfile(user.id, updates);
      this.updateHeaderProfileBadge(updatedUser || SupabaseService.getActiveUser());
      this.closeProfileSettingsModal();
      this.showToast('Profilo aggiornato con successo! ✨');
    } catch (e) {
      if (errorMsg) {
        errorMsg.textContent = e.message || 'Errore durante l\'aggiornamento del profilo.';
        errorMsg.style.display = 'block';
        errorMsg.style.color = '#ef4444';
      }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
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
      this.renderCommunityRow();
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
    this.renderCommunityRow();
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
  // Feedback & Feature Requests Controller
  // =========================================================================
  bindFeedbackEvents() {
    this.currentFeedbackType = 'bug';
    this.currentFeedbackFilter = 'all';

    const form = document.getElementById('feedback-form');
    const typeButtons = document.querySelectorAll('.type-toggle-btn');
    const titleInput = document.getElementById('feedback-input-title');
    const descInput = document.getElementById('feedback-input-desc');
    const charCounter = document.getElementById('feedback-char-count');
    const submitBtn = document.getElementById('btn-submit-feedback');
    const filterButtons = document.querySelectorAll('.feed-filter-btn');

    typeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        typeButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentFeedbackType = btn.getAttribute('data-type') || 'bug';
        if (titleInput) {
          titleInput.placeholder = this.currentFeedbackType === 'bug'
            ? 'Es. Errore streaming anime / Player bloccato...'
            : 'Es. Aggiungi filtro per anno / Modalità offline...';
        }
      });
    });

    if (descInput && charCounter) {
      descInput.addEventListener('input', () => {
        const len = descInput.value.length;
        charCounter.textContent = `${len}/600`;
        charCounter.style.color = len >= 580 ? '#ef4444' : 'var(--text-dim)';
      });
    }

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const activeUser = SupabaseService.getActiveUser();
        if (!activeUser) {
          this.showToast('Seleziona prima il tuo profilo per inviare feedback!');
          this.showProfileSelectorModal();
          return;
        }

        const title = titleInput ? titleInput.value.trim() : '';
        const desc = descInput ? descInput.value.trim() : '';
        if (!desc) {
          this.showToast('Inserisci una descrizione valida.');
          return;
        }

        if (submitBtn) submitBtn.disabled = true;
        try {
          await SupabaseService.createFeedbackEntry({
            type: this.currentFeedbackType,
            title: title,
            description: desc
          });
          this.showToast('Segnalazione inviata con successo! Grazie per il supporto 🍿');
          if (titleInput) titleInput.value = '';
          if (descInput) descInput.value = '';
          if (charCounter) charCounter.textContent = '0/600';
          this.loadFeedbackSection();
        } catch (err) {
          console.error('[Roxy] Error submitting feedback:', err);
          this.showToast(err.message || 'Errore durante l\'invio del feedback.');
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }

    filterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        filterButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentFeedbackFilter = btn.getAttribute('data-filter') || 'all';
        this.loadFeedbackSection();
      });
    });
  }

  async loadFeedbackSection() {
    const listContainer = document.getElementById('feedback-list-container');
    const totalCountBadge = document.getElementById('feedback-total-count');
    if (!listContainer) return;

    listContainer.innerHTML = '<div class="feedback-loading">Caricamento bacheca feedback...</div>';

    try {
      const entries = await SupabaseService.getFeedbackEntries();
      if (totalCountBadge) {
        totalCountBadge.textContent = String(entries.length);
      }

      let filtered = entries;
      if (this.currentFeedbackFilter === 'bug') {
        filtered = entries.filter(e => e.type === 'bug');
      } else if (this.currentFeedbackFilter === 'feature') {
        filtered = entries.filter(e => e.type === 'feature');
      }

      if (filtered.length === 0) {
        listContainer.innerHTML = '<div class="feedback-empty-state">Nessuna segnalazione presente in questa categoria. Lascia tu la prima! 🍿</div>';
        return;
      }

      const activeUser = SupabaseService.getActiveUser();
      const currentUserId = activeUser ? String(activeUser.id) : null;

      listContainer.innerHTML = filtered.map(item => {
        const isBug = item.type === 'bug';
        const isCompleted = item.isCompleted;
        const isOwn = currentUserId && String(item.userId) === currentUserId;
        const timeAgo = this.formatTimeAgo(item.createdAt);

        const authorAvatarHtml = item.avatar_url
          ? `<img src="${item.avatar_url}" alt="${this.escapeHtml(item.username)}" onerror="this.outerHTML='${this.escapeHtml(item.avatar_emoji || '🍿')}'" />`
          : this.escapeHtml(item.avatar_emoji || '🍿');

        // Upvoters avatars stack
        const maxAvatars = 5;
        const displayUpvoters = (item.upvoters || []).slice(0, maxAvatars);
        const remainingUpvoters = (item.upvoters || []).length - maxAvatars;

        const upvotersHtml = displayUpvoters.map(u => {
          const uAvatar = u.avatar_url
            ? `<img src="${u.avatar_url}" alt="${this.escapeHtml(u.username)}" onerror="this.outerHTML='${this.escapeHtml(u.avatar_emoji || '🍿')}'" />`
            : this.escapeHtml(u.avatar_emoji || '🍿');
          return `<div class="feedback-upvoter-avatar" title="${this.escapeHtml(u.username)}">${uAvatar}</div>`;
        }).join('');

        const remainingHtml = remainingUpvoters > 0
          ? `<div class="feedback-upvoter-avatar feedback-upvoters-more">+${remainingUpvoters}</div>`
          : '';

        return `
          <div class="feedback-card ${isCompleted ? 'is-completed-card' : ''}" data-id="${item.id}">
            <div class="feedback-card-top">
              <div class="feedback-author-meta">
                <div class="feedback-author-avatar">${authorAvatarHtml}</div>
                <div>
                  <div class="feedback-author-name">${this.escapeHtml(item.username)}</div>
                  <div class="feedback-time-ago">${timeAgo}</div>
                </div>
              </div>
              <div class="feedback-card-tags">
                <span class="${isBug ? 'tag-type-bug' : 'tag-type-feature'}">${isBug ? '🐞 Bug' : '✨ Feature'}</span>
                ${isCompleted ? `<span class="tag-completed">✓ ${isBug ? 'Risolto' : 'Completato'}</span>` : ''}
                ${isOwn ? `
                  <button class="btn-delete-feedback navigable focus-compact" data-id="${item.id}" title="Elimina la tua segnalazione" aria-label="Elimina">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                ` : ''}
              </div>
            </div>

            <div class="feedback-card-body">
              <div class="feedback-card-title">${this.escapeHtml(item.title)}</div>
              <div class="feedback-card-desc">${this.escapeHtml(item.description)}</div>
            </div>

            <div class="feedback-card-footer">
              <button class="btn-upvote navigable focus-compact ${item.hasUpvoted ? 'has-upvoted' : ''}" data-id="${item.id}" title="Vota questa richiesta">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="${item.hasUpvoted ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
                <span>${item.hasUpvoted ? 'Votato' : 'Vota'}</span>
                <strong class="upvote-count">${item.upvotesCount}</strong>
              </button>

              ${(item.upvoters && item.upvoters.length > 0) ? `
                <div class="feedback-upvoters-stack" title="${item.upvoters.map(u => u.username).join(', ')}">
                  ${upvotersHtml}
                  ${remainingHtml}
                </div>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');

      // Bind Upvote click handlers
      listContainer.querySelectorAll('.btn-upvote').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const activeUser = SupabaseService.getActiveUser();
          if (!activeUser) {
            this.showToast('Seleziona prima il tuo profilo per votare!');
            this.showProfileSelectorModal();
            return;
          }
          const id = btn.getAttribute('data-id');
          btn.disabled = true;
          try {
            await SupabaseService.toggleFeedbackUpvote(id);
            this.loadFeedbackSection();
          } catch (err) {
            this.showToast(err.message || 'Errore durante il voto.');
          } finally {
            btn.disabled = false;
          }
        });
      });

      // Bind Delete click handlers
      listContainer.querySelectorAll('.btn-delete-feedback').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          if (!window.confirm('Sei sicuro di voler eliminare questa segnalazione?')) return;
          btn.disabled = true;
          try {
            await SupabaseService.deleteFeedbackEntry(id);
            this.showToast('Segnalazione eliminata.');
            this.loadFeedbackSection();
          } catch (err) {
            this.showToast(err.message || 'Errore durante l\'eliminazione.');
          } finally {
            btn.disabled = false;
          }
        });
      });

    } catch (err) {
      console.error('[Roxy] Error loading feedback section:', err);
      listContainer.innerHTML = '<div class="feedback-empty-state">Errore durante il caricamento dei feedback.</div>';
    }
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

  // =========================================================================
  // Home Watchlist Row
  // =========================================================================
  renderHomeWatchlistRow() {
    const rowsWrapper = document.getElementById('home-rows-container');
    if (!rowsWrapper) return;

    const list = StorageService.getWatchlist();
    let container = document.getElementById('home-watchlist-row');

    if (!list || list.length === 0) {
      if (container) container.remove();
      return;
    }

    if (!container) {
      container = document.createElement('div');
      container.id = 'home-watchlist-row';
      container.className = 'content-row';
    }

    // Position right after community-row or continue-watching-row
    const commRow = document.getElementById('community-row');
    const contRow = document.getElementById('continue-watching-row');
    const anchor = commRow || contRow;

    if (anchor && anchor.nextSibling !== container) {
      rowsWrapper.insertBefore(container, anchor.nextSibling);
    } else if (!anchor && rowsWrapper.firstChild !== container) {
      rowsWrapper.insertBefore(container, rowsWrapper.firstChild);
    }

    container.innerHTML = `
      <div class="row-header">
        <h2 class="row-title">
          <span>📑 La Mia Lista</span>
          <span style="font-size: 0.85rem; color: var(--text-muted); font-weight: 500;">${list.length} ${list.length === 1 ? 'titolo' : 'titoli'}</span>
        </h2>
      </div>
      <div class="row-carousel" id="carousel-home-watchlist">
        ${list.map(item => this.getMediaCardHtml(item)).join('')}
      </div>
    `;

    this.setupCarouselArrows(container);

    container.querySelectorAll('.media-card').forEach(card => {
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
  // Community Users Catalog & Profiles
  // =========================================================================
  async loadUsersSection() {
    const grid = document.getElementById('users-grid');
    if (!grid) return;

    grid.innerHTML = '<div class="feedback-loading">Caricamento utenti community...</div>';

    try {
      const activeUser = SupabaseService.getActiveUser();
      const currentUserId = activeUser ? String(activeUser.id) : null;

      const [profiles, watchRows, commentsRows] = await Promise.all([
        SupabaseService.getProfiles(),
        SupabaseService.restRequest('watch_progress?community_hidden=eq.false&select=user_id,media_id,is_completed,progress,is_last_episode,source,media_type,season').catch(() => []),
        SupabaseService.restRequest('comments?select=user_id,comment_type').catch(() => [])
      ]);

      if (!Array.isArray(profiles) || profiles.length === 0) {
        grid.innerHTML = '<div class="empty-state">Nessun utente registrato.</div>';
        return;
      }

      const statsMap = new Map();
      profiles.forEach(p => {
        statsMap.set(String(p.id), { watched: new Set(), recs: 0, comments: 0 });
      });

      if (Array.isArray(watchRows)) {
        for (const r of watchRows) {
          const uId = String(r.user_id);
          const userStat = statsMap.get(uId);
          if (!userStat) continue;

          const isSaturn = (r.source === 'animesaturn' || String(r.media_id).startsWith('saturn_'));
          const isTv = !isSaturn && (r.media_type === 'tv' || (r.media_type !== 'movie' && Number(r.season) > 0));
          const isSeries = isTv || isSaturn || r.media_type === 'anime';
          const prog = Number(r.progress || 0);

          const isCompleted = r.is_completed === true || (!isSeries && prog >= 95) || (isSeries && r.is_last_episode === true && prog >= 95);
          if (isCompleted) {
            userStat.watched.add(String(r.media_id));
          }
        }
      }

      if (Array.isArray(commentsRows)) {
        for (const c of commentsRows) {
          const uId = String(c.user_id);
          const userStat = statsMap.get(uId);
          if (!userStat) continue;
          if (c.comment_type === 'recommendation') {
            userStat.recs++;
          } else {
            userStat.comments++;
          }
        }
      }

      grid.innerHTML = profiles.map(p => {
        const uId = String(p.id);
        const isMe = currentUserId === uId;
        const stat = statsMap.get(uId) || { watched: new Set(), recs: 0, comments: 0 };
        const watchedCount = stat.watched.size;
        const recCount = stat.recs;
        const commentCount = stat.comments;

        const avatarHtml = p.avatar_url
          ? `<img src="${p.avatar_url}" class="profile-avatar-img" alt="${this.escapeHtml(p.username)}" onerror="this.outerHTML='${this.escapeHtml(p.avatar_emoji || '🍿')}'" />`
          : this.escapeHtml(p.avatar_emoji || '🍿');

        const bioText = p.bio ? this.escapeHtml(p.bio) : '<span style="color: var(--text-dim); font-style: italic;">Nessuna biografia inserita</span>';

        return `
          <div class="user-card navigable focus-compact ${isMe ? 'is-current-user' : ''}" tabindex="0" data-user-id="${uId}">
            <div class="user-card-top">
              <div class="user-card-avatar">${avatarHtml}</div>
              <div class="user-card-identity">
                <div class="user-card-name-row">
                  <h3 class="user-card-username">${this.escapeHtml(p.username)}</h3>
                  ${isMe ? '<span class="badge-user-you">Tu</span>' : ''}
                </div>
                <div class="user-card-bio">${bioText}</div>
              </div>
            </div>
            <div class="user-card-stats">
              <div class="user-stat-badge">
                <span class="user-stat-val">🎬 ${watchedCount}</span>
                <span class="user-stat-lbl">visti</span>
              </div>
              <div class="user-stat-badge">
                <span class="user-stat-val">★ ${recCount}</span>
                <span class="user-stat-lbl">consigli</span>
              </div>
              <div class="user-stat-badge">
                <span class="user-stat-val">💬 ${commentCount}</span>
                <span class="user-stat-lbl">commenti</span>
              </div>
            </div>
          </div>
        `;
      }).join('');

      grid.querySelectorAll('.user-card').forEach(card => {
        card.addEventListener('click', () => {
          const uId = card.getAttribute('data-user-id');
          if (uId) {
            this.openUserProfile(uId);
          }
        });
      });
    } catch (e) {
      console.error('[Roxy] Error loading users section:', e);
      grid.innerHTML = '<div class="empty-state">Errore nel caricamento dei profili utente.</div>';
    }
  }

  async openUserProfile(userId) {
    if (!userId) return;

    if (this.currentSection && this.currentSection !== 'user-profile') {
      this.previousSectionBeforeProfile = this.currentSection;
    }

    this.switchSection('user-profile');

    const usernameEl = document.getElementById('profile-page-username');
    const avatarEl = document.getElementById('profile-page-avatar');
    const badgeYouEl = document.getElementById('profile-page-badge-you');
    const bioEl = document.getElementById('profile-page-bio');
    const statWatchedEl = document.getElementById('profile-stat-watched');
    const statRecsEl = document.getElementById('profile-stat-recommended');
    const statCommentsEl = document.getElementById('profile-stat-comments');
    const tabWatchedCount = document.getElementById('tab-count-watched');
    const tabRecsCount = document.getElementById('tab-count-recommended');
    const tabCommentsCount = document.getElementById('tab-count-comments');
    const ownerActions = document.getElementById('profile-owner-actions');
    const editPanel = document.getElementById('profile-edit-panel');

    if (editPanel) editPanel.style.display = 'none';
    if (usernameEl) usernameEl.textContent = 'Caricamento profilo...';

    const data = await SupabaseService.getUserProfileData(userId);
    if (!data || !data.profile) {
      this.showToast('Impossibile caricare il profilo utente.');
      this.switchSection('users');
      return;
    }

    this.viewedProfileData = data;
    const { profile, isOwner, watched, recommendations, comments } = data;

    if (usernameEl) usernameEl.textContent = profile.username;
    if (avatarEl) {
      avatarEl.innerHTML = profile.avatar_url
        ? `<img src="${profile.avatar_url}" class="profile-avatar-img" alt="${this.escapeHtml(profile.username)}" onerror="this.outerHTML='${this.escapeHtml(profile.avatar_emoji || '🍿')}'" />`
        : this.escapeHtml(profile.avatar_emoji || '🍿');
    }
    if (badgeYouEl) badgeYouEl.style.display = isOwner ? 'inline-block' : 'none';
    if (ownerActions) ownerActions.style.display = isOwner ? 'block' : 'none';

    if (bioEl) {
      bioEl.innerHTML = profile.bio
        ? this.escapeHtml(profile.bio)
        : `<span style="color: var(--text-dim); font-style: italic;">${isOwner ? 'Nessuna biografia inserita. Clicca su "Modifica Info" per aggiungerne una!' : 'Nessuna biografia inserita.'}</span>`;
    }

    if (statWatchedEl) statWatchedEl.textContent = watched.length;
    if (statRecsEl) statRecsEl.textContent = recommendations.length;
    if (statCommentsEl) statCommentsEl.textContent = comments.length;

    if (tabWatchedCount) tabWatchedCount.textContent = watched.length;
    if (tabRecsCount) tabRecsCount.textContent = recommendations.length;
    if (tabCommentsCount) tabCommentsCount.textContent = comments.length;

    // Render Watched Titles Grid
    const watchedGrid = document.getElementById('profile-watched-grid');
    if (watchedGrid) {
      if (watched.length === 0) {
        watchedGrid.innerHTML = `<div class="empty-state" style="padding: 40px 0;"><div style="font-size: 2.5rem; margin-bottom: 8px;">🎬</div>Nessun titolo completato ${isOwner ? 'nella tua cronologia' : 'da mostrare'}.</div>`;
      } else {
        watchedGrid.innerHTML = watched.map(item => {
          const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
          const posterUrl = item.poster_path || item.backdrop_path || '';
          const imgUrl = posterUrl.startsWith('http') ? posterUrl : (posterUrl ? TMDBService.getPosterUrl(posterUrl, 'w342') : 'assets/icon.png');
          const cleanTitle = isSaturn ? (window.AnimeSaturnService?.cleanAnimeTitle(item.title) || item.title) : item.title;

          return `
            <div class="media-card navigable focus-compact" tabindex="0" data-id="${item.id}" data-type="${item.media_type}" data-source="${item.source || 'tmdb'}" data-slug="${item.slug || ''}">
              <div class="card-poster-wrap">
                <img src="${imgUrl}" alt="${this.escapeHtml(cleanTitle)}" class="card-poster" loading="lazy" />
                <div class="card-play-indicator">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
                </div>
                ${item.community_hidden ? '<div class="badge-hidden-private" title="Nascosto alla community">🔒 Nascosto</div>' : ''}
              </div>
              <div class="card-meta">
                <div class="card-title">${isSaturn ? '🪐 ' : ''}${this.escapeHtml(cleanTitle)}</div>
                <div class="card-sub">${isSaturn ? 'Anime' : (item.media_type === 'tv' ? 'Serie TV' : 'Film')}</div>
              </div>
            </div>
          `;
        }).join('');

        watchedGrid.querySelectorAll('.media-card').forEach(card => {
          const rawId = card.getAttribute('data-id');
          const item = watched.find(i => String(i.id) === String(rawId));
          if (item) {
            card.addEventListener('click', () => {
              this.lastFocusedElement = card;
              this.openDetailsModal(item);
            });
          }
        });
      }
    }

    // Render Recommendations List
    const recsList = document.getElementById('profile-recommended-list');
    if (recsList) {
      if (recommendations.length === 0) {
        recsList.innerHTML = `<div class="empty-state" style="padding: 40px 0;"><div style="font-size: 2.5rem; margin-bottom: 8px;">★</div>Nessun titolo consigliato.</div>`;
      } else {
        recsList.innerHTML = recommendations.map(item => {
          const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
          const posterUrl = item.poster_path || item.backdrop_path || '';
          const imgUrl = posterUrl.startsWith('http') ? posterUrl : (posterUrl ? TMDBService.getPosterUrl(posterUrl, 'w185') : 'assets/icon.png');
          const cleanTitle = isSaturn ? (window.AnimeSaturnService?.cleanAnimeTitle(item.title) || item.title) : item.title;
          const timeAgo = this.formatTimeAgo(new Date(item.created_at).getTime());

          return `
            <div class="profile-rec-card navigable focus-compact" tabindex="0" data-media-id="${item.media_id}" data-source="${item.source || 'tmdb'}" data-media-type="${item.media_type || 'movie'}" data-slug="${item.slug || ''}">
              <img src="${imgUrl}" alt="${this.escapeHtml(cleanTitle)}" class="profile-item-thumb" loading="lazy" />
              <div class="profile-item-content">
                <div class="profile-item-header">
                  <span class="profile-item-title">${isSaturn ? '🪐 ' : ''}${this.escapeHtml(cleanTitle)}</span>
                  <span class="profile-item-time">${timeAgo}</span>
                </div>
                <div class="badge-rec-star" style="display: inline-flex; margin-bottom: 6px;">★ Consigliato assolutamente</div>
                ${item.comment_text ? `<div class="profile-item-text">"${this.escapeHtml(item.comment_text)}"</div>` : ''}
              </div>
            </div>
          `;
        }).join('');

        recsList.querySelectorAll('.profile-rec-card').forEach(card => {
          card.addEventListener('click', () => {
            const mId = card.getAttribute('data-media-id');
            const source = card.getAttribute('data-source');
            const mediaType = card.getAttribute('data-media-type');
            const slug = card.getAttribute('data-slug');
            this.lastFocusedElement = card;
            this.openDetailsModal({ id: mId, source, media_type: mediaType, slug });
          });
        });
      }
    }

    // Render Comments List
    const commList = document.getElementById('profile-comments-list');
    if (commList) {
      if (comments.length === 0) {
        commList.innerHTML = `<div class="empty-state" style="padding: 40px 0;"><div style="font-size: 2.5rem; margin-bottom: 8px;">💬</div>Nessun commento scritto.</div>`;
      } else {
        commList.innerHTML = comments.map(item => {
          const isSaturn = (item.source === 'animesaturn' || String(item.id).startsWith('saturn_'));
          const posterUrl = item.poster_path || item.backdrop_path || '';
          const imgUrl = posterUrl.startsWith('http') ? posterUrl : (posterUrl ? TMDBService.getPosterUrl(posterUrl, 'w185') : 'assets/icon.png');
          const cleanTitle = isSaturn ? (window.AnimeSaturnService?.cleanAnimeTitle(item.title) || item.title) : item.title;
          const timeAgo = this.formatTimeAgo(new Date(item.created_at).getTime());

          return `
            <div class="profile-comment-card navigable focus-compact" tabindex="0" data-media-id="${item.media_id}" data-source="${item.source || 'tmdb'}" data-media-type="${item.media_type || 'movie'}" data-slug="${item.slug || ''}">
              <img src="${imgUrl}" alt="${this.escapeHtml(cleanTitle)}" class="profile-item-thumb" loading="lazy" />
              <div class="profile-item-content">
                <div class="profile-item-header">
                  <span class="profile-item-title">${isSaturn ? '🪐 ' : ''}${this.escapeHtml(cleanTitle)}</span>
                  <span class="profile-item-time">${timeAgo}</span>
                </div>
                <div class="profile-item-text">"${this.escapeHtml(item.comment_text)}"</div>
              </div>
            </div>
          `;
        }).join('');

        commList.querySelectorAll('.profile-comment-card').forEach(card => {
          card.addEventListener('click', () => {
            const mId = card.getAttribute('data-media-id');
            const source = card.getAttribute('data-source');
            const mediaType = card.getAttribute('data-media-type');
            const slug = card.getAttribute('data-slug');
            this.lastFocusedElement = card;
            this.openDetailsModal({ id: mId, source, media_type: mediaType, slug });
          });
        });
      }
    }

    // Populate Edit Form if owner
    if (isOwner) {
      const editName = document.getElementById('profile-edit-name');
      const editBio = document.getElementById('profile-edit-bio');
      const bioCounter = document.getElementById('profile-bio-char-count');
      const editPin = document.getElementById('profile-edit-pin');

      if (editName) editName.value = profile.username || '';
      if (editBio) {
        editBio.value = profile.bio || '';
        if (bioCounter) bioCounter.textContent = `${(profile.bio || '').length}/250`;
      }
      if (editPin) editPin.value = '';

      this.profileEditAvatarType = profile.avatar_url ? 'photo' : 'emoji';
      this.profileEditSelectedEmoji = profile.avatar_emoji || '🍿';
      this.profileEditPhotoData = profile.avatar_url || null;

      const tabEmoji = document.getElementById('profile-edit-tab-emoji');
      const tabPhoto = document.getElementById('profile-edit-tab-photo');
      const contentEmoji = document.getElementById('profile-edit-content-emoji');
      const contentPhoto = document.getElementById('profile-edit-content-photo');
      const photoPreview = document.getElementById('profile-edit-photo-preview');
      const btnRemovePhoto = document.getElementById('btn-profile-remove-photo');

      if (this.profileEditAvatarType === 'photo' && profile.avatar_url) {
        if (tabEmoji) tabEmoji.classList.remove('active');
        if (tabPhoto) tabPhoto.classList.add('active');
        if (contentEmoji) contentEmoji.style.display = 'none';
        if (contentPhoto) contentPhoto.style.display = 'block';
        if (photoPreview) photoPreview.innerHTML = `<img src="${profile.avatar_url}" class="photo-preview-img" alt="Preview" />`;
        if (btnRemovePhoto) btnRemovePhoto.style.display = 'inline-block';
      } else {
        if (tabEmoji) tabEmoji.classList.add('active');
        if (tabPhoto) tabPhoto.classList.remove('active');
        if (contentEmoji) contentEmoji.style.display = 'block';
        if (contentPhoto) contentPhoto.style.display = 'none';
        if (btnRemovePhoto) btnRemovePhoto.style.display = 'none';
      }

      document.querySelectorAll('#profile-edit-emoji-picker .settings-emoji-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-emoji') === this.profileEditSelectedEmoji);
      });
    }
  }

  bindUserProfileEvents() {
    const btnBack = document.getElementById('btn-back-to-users');
    if (btnBack) {
      btnBack.addEventListener('click', () => {
        const dest = this.previousSectionBeforeProfile || 'users';
        this.switchSection(dest);
      });
    }

    const profileTabs = document.querySelectorAll('.profile-tab-btn');
    profileTabs.forEach(btn => {
      btn.addEventListener('click', () => {
        profileTabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.getAttribute('data-tab');

        document.querySelectorAll('.profile-tab-panel').forEach(panel => {
          panel.style.display = 'none';
          panel.classList.remove('active');
        });

        const targetPanel = document.getElementById(`profile-tab-${tab}`);
        if (targetPanel) {
          targetPanel.style.display = 'block';
          targetPanel.classList.add('active');
        }
      });
    });

    const btnToggleEdit = document.getElementById('btn-profile-toggle-edit');
    const btnCloseEdit = document.getElementById('btn-profile-close-edit');
    const editPanel = document.getElementById('profile-edit-panel');

    if (btnToggleEdit && editPanel) {
      btnToggleEdit.addEventListener('click', () => {
        editPanel.style.display = editPanel.style.display === 'none' ? 'block' : 'none';
        if (editPanel.style.display === 'block') {
          editPanel.scrollIntoView({ behavior: 'smooth' });
          const firstInput = editPanel.querySelector('input');
          if (firstInput) firstInput.focus();
        }
      });
    }

    if (btnCloseEdit && editPanel) {
      btnCloseEdit.addEventListener('click', () => {
        editPanel.style.display = 'none';
      });
    }

    const bioTextarea = document.getElementById('profile-edit-bio');
    const bioCounter = document.getElementById('profile-bio-char-count');
    if (bioTextarea && bioCounter) {
      bioTextarea.addEventListener('input', () => {
        bioCounter.textContent = `${bioTextarea.value.length}/250`;
      });
    }

    const tabEmoji = document.getElementById('profile-edit-tab-emoji');
    const tabPhoto = document.getElementById('profile-edit-tab-photo');
    const contentEmoji = document.getElementById('profile-edit-content-emoji');
    const contentPhoto = document.getElementById('profile-edit-content-photo');

    if (tabEmoji && tabPhoto) {
      tabEmoji.addEventListener('click', () => {
        tabEmoji.classList.add('active');
        tabPhoto.classList.remove('active');
        if (contentEmoji) contentEmoji.style.display = 'block';
        if (contentPhoto) contentPhoto.style.display = 'none';
        this.profileEditAvatarType = 'emoji';
      });

      tabPhoto.addEventListener('click', () => {
        tabPhoto.classList.add('active');
        tabEmoji.classList.remove('active');
        if (contentPhoto) contentPhoto.style.display = 'block';
        if (contentEmoji) contentEmoji.style.display = 'none';
        this.profileEditAvatarType = 'photo';
      });
    }

    document.querySelectorAll('#profile-edit-emoji-picker .settings-emoji-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#profile-edit-emoji-picker .settings-emoji-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.profileEditSelectedEmoji = btn.getAttribute('data-emoji') || '🍿';
      });
    });

    const fileInput = document.getElementById('profile-edit-photo-input');
    const btnChoosePhoto = document.getElementById('btn-profile-choose-photo');
    const btnRemovePhoto = document.getElementById('btn-profile-remove-photo');
    const photoPreview = document.getElementById('profile-edit-photo-preview');

    if (btnChoosePhoto && fileInput) {
      btnChoosePhoto.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const compressed = await this.compressAvatarImage(file);
          this.profileEditPhotoData = compressed;
          if (photoPreview) {
            photoPreview.innerHTML = `<img src="${compressed}" class="photo-preview-img" alt="Preview" />`;
          }
          if (btnRemovePhoto) btnRemovePhoto.style.display = 'inline-block';
        } catch (err) {
          this.showToast('Errore nel caricamento della foto.');
        }
      });
    }

    if (btnRemovePhoto) {
      btnRemovePhoto.addEventListener('click', () => {
        this.profileEditPhotoData = null;
        if (photoPreview) photoPreview.innerHTML = '<span class="photo-placeholder-icon">📷</span>';
        btnRemovePhoto.style.display = 'none';
        if (fileInput) fileInput.value = '';
      });
    }

    const btnSwitchUser = document.getElementById('btn-profile-switch-user');
    if (btnSwitchUser) {
      btnSwitchUser.addEventListener('click', () => {
        if (editPanel) editPanel.style.display = 'none';
        this.showProfileSelectorModal();
      });
    }

    const btnDeleteUser = document.getElementById('btn-profile-delete-user');
    if (btnDeleteUser) {
      btnDeleteUser.addEventListener('click', async () => {
        const user = SupabaseService.getActiveUser();
        if (!user) return;
        if (confirm(`Sei sicuro di voler eliminare definitivamente il profilo "${user.username}"? Tutti i tuoi progressi verranno cancellati.`)) {
          try {
            await SupabaseService.deleteProfile(user.id);
            this.showToast('Profilo eliminato con successo.');
            if (editPanel) editPanel.style.display = 'none';
            this.showProfileSelectorModal();
          } catch (err) {
            this.showToast('Errore durante l\'eliminazione del profilo.');
          }
        }
      });
    }

    const form = document.getElementById('profile-edit-form');
    const errorMsg = document.getElementById('profile-edit-error');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = SupabaseService.getActiveUser();
        if (!user) return;

        const newName = document.getElementById('profile-edit-name')?.value?.trim();
        const newBio = document.getElementById('profile-edit-bio')?.value?.trim() || '';
        const newPin = document.getElementById('profile-edit-pin')?.value?.trim();

        if (errorMsg) {
          errorMsg.style.display = 'none';
          errorMsg.textContent = '';
        }

        if (newPin && !/^\d{4}$/.test(newPin)) {
          if (errorMsg) {
            errorMsg.textContent = 'Il PIN deve essere esattamente di 4 cifre numeriche.';
            errorMsg.style.display = 'block';
          }
          return;
        }

        const updates = {
          username: newName,
          bio: newBio
        };
        if (newPin) updates.pin = newPin;

        if (this.profileEditAvatarType === 'photo' && this.profileEditPhotoData) {
          if (this.profileEditPhotoData.startsWith('data:')) {
            try {
              const uploadedUrl = await SupabaseService.uploadAvatarPhoto(user.id, this.profileEditPhotoData);
              updates.avatar_url = uploadedUrl;
            } catch (err) {
              if (errorMsg) {
                errorMsg.textContent = 'Caricamento foto fallito, riprova.';
                errorMsg.style.display = 'block';
              }
              return;
            }
          } else {
            updates.avatar_url = this.profileEditPhotoData;
          }
        } else {
          updates.avatar_url = null;
          updates.avatar_emoji = this.profileEditSelectedEmoji || '🍿';
        }

        try {
          const updatedUser = await SupabaseService.updateProfile(user.id, updates);
          this.showToast('Profilo aggiornato con successo!');
          if (editPanel) editPanel.style.display = 'none';
          this.updateHeaderProfileBadge(updatedUser);
          this.openUserProfile(user.id);
        } catch (err) {
          if (errorMsg) {
            errorMsg.textContent = err.message || 'Errore durante l\'aggiornamento.';
            errorMsg.style.display = 'block';
          }
        }
      });
    }
  }
}

// Instantiate application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.App = new RoxyApp();
});
