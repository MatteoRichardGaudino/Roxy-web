/**
 * Roxy - Spatial Navigation Engine for webOS Smart TV
 * Implements 2D directional navigation for remote control D-Pad & Magic Remote
 */
class SpatialNavigator {
  constructor() {
    this.currentFocused = null;
    this.isModalOpen = false;
    this.modalContainer = null;
    this.isPlayerActive = false;

    this.init();
  }

  init() {
    window.addEventListener('keydown', (e) => this.handleKeyDown(e), { passive: false });
    
    // Explicit click support for Magic Remote / Mouse without triggering unwanted carousel scroll
    document.addEventListener('click', (e) => {
      const navigable = e.target.closest('.navigable');
      if (navigable) {
        this.setFocus(navigable, false);
      }
    });

    // Deselect keyboard/D-pad focus when Magic Remote cursor / Mouse moves
    let lastMouseX = -1;
    let lastMouseY = -1;
    window.addEventListener('mousemove', (e) => {
      if (lastMouseX !== -1 && lastMouseY !== -1) {
        const dx = Math.abs(e.clientX - lastMouseX);
        const dy = Math.abs(e.clientY - lastMouseY);
        if (dx > 3 || dy > 3) {
          if (this.currentFocused) {
            this.currentFocused.classList.remove('focused');
            this.currentFocused.blur();
            this.currentFocused = null;
          }
        }
      }
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    });
  }

  setModal(isOpen, container = null) {
    this.isModalOpen = isOpen;
    this.modalContainer = container;
    if (isOpen && container) {
      const firstNav = container.querySelector('.navigable');
      if (firstNav) this.setFocus(firstNav);
    }
  }

  setPlayerActive(isActive) {
    this.isPlayerActive = isActive;
  }

  getNavigableElements() {
    let selector = '.navigable:not([disabled])';
    let root = document;

    if (this.isPlayerActive) {
      root = document.getElementById('player-view');
    } else if (this.isModalOpen && this.modalContainer) {
      root = this.modalContainer;
    } else {
      // In normal view, only consider elements in active sections or header
      root = document;
    }

    if (!root) return [];
    
    const elements = Array.from(root.querySelectorAll(selector));
    return elements.filter(el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && 
             style.visibility !== 'hidden' && 
             style.opacity !== '0' &&
             rect.width > 0 && 
             rect.height > 0;
    });
  }

  setFocus(element, scrollIntoView = true) {
    if (!element) return;

    if (this.currentFocused && this.currentFocused !== element) {
      this.currentFocused.classList.remove('focused');
      this.currentFocused.blur();
    }

    this.currentFocused = element;
    element.classList.add('focused');
    try {
      element.focus({ preventScroll: true });
    } catch (err) {
      element.focus();
    }

    if (scrollIntoView) {
      this.ensureVisible(element);
    }
  }

  ensureVisible(element) {
    // 1. Modal Dialog internal scrolling (episodes list & season tabs)
    if (this.isModalOpen && this.modalContainer) {
      // Horizontal season tabs smooth scroll
      const seasonsBar = element.closest('.seasons-bar');
      if (seasonsBar) {
        const barRect = seasonsBar.getBoundingClientRect();
        const elRect = element.getBoundingClientRect();
        const offset = (elRect.left + elRect.width / 2) - (barRect.left + barRect.width / 2);
        if (Math.abs(offset) > 4) {
          seasonsBar.scrollBy({ left: offset, behavior: 'smooth' });
        }
      }

      // Vertical modal body content smooth scroll
      const modalBody = this.modalContainer.querySelector('.modal-body-content') || this.modalContainer;
      if (modalBody) {
        const bodyRect = modalBody.getBoundingClientRect();
        const elRect = element.getBoundingClientRect();

        if (elRect.top < bodyRect.top + 30) {
          modalBody.scrollBy({ top: elRect.top - bodyRect.top - 50, behavior: 'smooth' });
        } else if (elRect.bottom > bodyRect.bottom - 30) {
          modalBody.scrollBy({ top: elRect.bottom - bodyRect.bottom + 50, behavior: 'smooth' });
        }
      }
      return;
    }

    // 2. Horizontal row carousel smooth auto-scroll
    const carousel = element.closest('.row-carousel');
    if (carousel) {
      const carouselRect = carousel.getBoundingClientRect();
      const elRect = element.getBoundingClientRect();
      const offset = (elRect.left + elRect.width / 2) - (carouselRect.left + carouselRect.width / 2);
      if (Math.abs(offset) > 4) {
        carousel.scrollBy({ left: offset, behavior: 'smooth' });
      }
    }

    // 3. Vertical main viewport smooth row-to-row animated scrolling
    const viewContainer = document.querySelector('.view-container');
    if (viewContainer && !this.isModalOpen && !this.isPlayerActive) {
      const viewRect = viewContainer.getBoundingClientRect();

      // If focusing the top navigation bar or hero billboard
      if (element.closest('.top-header') || element.closest('.hero-billboard')) {
        if (viewContainer.scrollTop > 0) {
          viewContainer.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }

      const contentRow = element.closest('.content-row');
      if (contentRow) {
        const rowRect = contentRow.getBoundingClientRect();
        // Position the target row with 105px clearance below the top header
        const targetScrollOffset = rowRect.top - viewRect.top - 105;
        if (Math.abs(targetScrollOffset) > 8) {
          viewContainer.scrollBy({ top: targetScrollOffset, behavior: 'smooth' });
        }
      } else {
        const elRect = element.getBoundingClientRect();
        if (elRect.top < viewRect.top + 100) {
          viewContainer.scrollBy({ top: elRect.top - viewRect.top - 120, behavior: 'smooth' });
        } else if (elRect.bottom > viewRect.bottom - 100) {
          viewContainer.scrollBy({ top: elRect.bottom - viewRect.bottom + 120, behavior: 'smooth' });
        }
      }
    }
  }

  handleKeyDown(e) {
    const code = e.keyCode || e.which;

    // Delegate playback keys to video player when active
    if (this.isPlayerActive && window.PlayerController) {
      if (window.PlayerController.handleKey(code, e)) {
        e.preventDefault();
        return;
      }
    }

    // Back Key Handling
    if (code === CONFIG.KEYS.BACK_WEBOS || code === CONFIG.KEYS.BACK_ESC || code === CONFIG.KEYS.BACK_BACKSPACE) {
      e.preventDefault();
      this.handleBack();
      return;
    }

    // Enter / OK Key
    if (code === CONFIG.KEYS.ENTER) {
      if (this.currentFocused) {
        e.preventDefault();
        // For 'Continua a guardare', pressing OK on remote directly starts playback!
        if (this.currentFocused.classList.contains('continue-card')) {
          const playBtn = this.currentFocused.querySelector('.card-play-indicator');
          if (playBtn) {
            playBtn.click();
            return;
          }
        }
        // Default behavior: click card or button (e.g. opens description modal for regular media cards)
        this.currentFocused.click();
      }
      return;
    }

    // Directional Navigation
    let direction = null;
    if (code === CONFIG.KEYS.LEFT) direction = 'left';
    else if (code === CONFIG.KEYS.UP) direction = 'up';
    else if (code === CONFIG.KEYS.RIGHT) direction = 'right';
    else if (code === CONFIG.KEYS.DOWN) direction = 'down';

    if (direction) {
      e.preventDefault();
      this.navigate(direction);
    }
  }

  navigate(direction) {
    const navigables = this.getNavigableElements();
    if (navigables.length === 0) return;

    if (!this.currentFocused || !navigables.includes(this.currentFocused)) {
      this.setFocus(navigables[0]);
      return;
    }

    const currentCarousel = this.currentFocused.closest('.row-carousel');

    // 1. Horizontal carousel left/right fast stepping with wrap-around
    if (currentCarousel && (direction === 'left' || direction === 'right')) {
      const items = Array.from(currentCarousel.querySelectorAll('.navigable'));
      const currentIndex = items.indexOf(this.currentFocused);
      if (direction === 'right') {
        if (currentIndex < items.length - 1) {
          this.setFocus(items[currentIndex + 1]);
        } else {
          // Wrap around to first element of the row when finishing on the right!
          this.setFocus(items[0]);
        }
        return;
      } else if (direction === 'left') {
        if (currentIndex > 0) {
          this.setFocus(items[currentIndex - 1]);
          return;
        } else {
          // Stay on first item of row when pressing left at start
          return;
        }
      }
    }

    // 2. Geometric search for nearest neighbor in target direction
    const currentRect = this.currentFocused.getBoundingClientRect();
    const currentCenter = {
      x: currentRect.left + currentRect.width / 2,
      y: currentRect.top + currentRect.height / 2
    };

    let bestCandidate = null;
    let minDistance = Infinity;

    for (const el of navigables) {
      if (el === this.currentFocused) continue;

      // CRITICAL FIX: If navigating UP or DOWN, ignore other items in the SAME row carousel
      if ((direction === 'up' || direction === 'down') && currentCarousel) {
        if (el.closest('.row-carousel') === currentCarousel) {
          continue; // Never jump to adjacent cards in the same row when moving vertically
        }
      }

      const rect = el.getBoundingClientRect();
      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };

      const dx = center.x - currentCenter.x;
      const dy = center.y - currentCenter.y;

      let isValidDirection = false;
      let score = Infinity;

      if (direction === 'left' && dx < -10) {
        isValidDirection = true;
        score = Math.abs(dx) + Math.abs(dy) * 3.0;
      } else if (direction === 'right' && dx > 10) {
        isValidDirection = true;
        score = Math.abs(dx) + Math.abs(dy) * 3.0;
      } else if (direction === 'up' && dy < -15) {
        isValidDirection = true;
        score = Math.abs(dy) * 1.0 + Math.abs(dx) * 1.8;
      } else if (direction === 'down' && dy > 15) {
        isValidDirection = true;
        score = Math.abs(dy) * 1.0 + Math.abs(dx) * 1.8;
      }

      if (isValidDirection && score < minDistance) {
        minDistance = score;
        bestCandidate = el;
      }
    }

    if (bestCandidate) {
      this.setFocus(bestCandidate);
    }
  }

  handleBack() {
    if (this.isPlayerActive && window.PlayerController) {
      window.PlayerController.close();
      return;
    }
    if (this.isModalOpen && window.App) {
      window.App.closeModal();
      return;
    }
    if (window.App && window.App.currentSection !== 'home') {
      window.App.switchSection('home');
      return;
    }
    // If on home with nothing open, trigger webOS exit or minimize
    if (window.webOS && window.webOS.platformBack) {
      window.webOS.platformBack();
    } else if (window.webOSBridge) {
      window.webOSBridge.exit();
    }
  }
}

window.SpatialNavigator = SpatialNavigator;
