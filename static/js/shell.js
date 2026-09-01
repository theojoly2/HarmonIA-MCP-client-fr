/**
 * Shell
 * Barre d'onglets + menu pour ouvrir les apps dans différents modes.
 */

class Shell {
    constructor(container, windowManager) {
        this.container = container;
        this.windowManager = windowManager;
        this.tabs = [];
        this._init();
    }

    _init() {
        this.container.innerHTML = `
            <div id="global-header" class="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-gray-200 px-4 sm:px-6 py-3 flex items-center justify-between flex-shrink-0">
                <div class="flex items-center gap-2" id="tab-bar"></div>
                <div class="flex items-center gap-2" id="shell-actions"></div>
            </div>
            <div id="shell-overlays" class="absolute inset-0 pointer-events-none z-50"></div>
            <div id="shell-content" class="flex-1 relative overflow-hidden"></div>
        `;
        this.tabBar = this.container.querySelector('#tab-bar');
        this.actionsArea = this.container.querySelector('#shell-actions');
        this.contentArea = this.container.querySelector('#shell-content');
        this.overlayArea = this.container.querySelector('#shell-overlays');
        this.authManager = null;
        this.apiKeysManager = null;
        this.historyPanel = null;
    }

    setAuthManager(authManager) {
        this.authManager = authManager;
    }

    setApiKeysManager(apiKeysManager) {
        this.apiKeysManager = apiKeysManager;
    }

    setHistoryPanel(historyPanel) {
        this.historyPanel = historyPanel;
    }

    getContentArea() {
        return this.contentArea;
    }

    getOverlayArea() {
        return this.overlayArea;
    }

    renderAuthActions(user) {
        this.actionsArea.innerHTML = '';
        if (user) {
            const historyBtn = document.createElement('button');
            historyBtn.id = 'history-toggle';
            historyBtn.className = 'history-toggle shell-tag-style shell-glow';
            historyBtn.title = 'Historique des modèles, recherches et conversations';
            historyBtn.id = 'history-toggle';
            historyBtn.innerHTML = `
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <span>Historique</span>
            `;
            historyBtn.addEventListener('click', () => {
                if (this.historyPanel) this.historyPanel.toggle();
            });

            const userMenuBtn = document.createElement('button');
            userMenuBtn.className = 'shell-tag-style shell-glow shell-round-btn';
            userMenuBtn.title = 'Menu utilisateur';
            userMenuBtn.setAttribute('aria-haspopup', 'true');
            userMenuBtn.innerHTML = `
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
            `;
            userMenuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleUserMenu(userMenuBtn, user);
            });

            this.actionsArea.appendChild(historyBtn);
            this.actionsArea.appendChild(userMenuBtn);
        } else {
            const loginBtn = document.createElement('button');
            loginBtn.id = 'login-btn';
            loginBtn.className = 'shell-submit-style';
            loginBtn.textContent = 'Connexion';
            loginBtn.addEventListener('click', () => {
                if (this.authManager) this.authManager.showModal();
            });
            this.actionsArea.appendChild(loginBtn);
        }
    }

    _formatUsageCount(n) {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.0', '')}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace('.0', '')}k`;
        return String(n);
    }

    _usageScaleLabel(scale) {
        const labels = {
            day: 'aujourd\'hui',
            week: 'cette semaine',
            month: 'ce mois',
            total: 'total',
        };
        return labels[scale] || scale;
    }

    async _loadUsageCounter(counterEl) {
        const scale = counterEl.dataset.scale || 'day';
        try {
            const data = await ApiClient.getUsage(scale);
            const prefix = data.has_estimate ? '~' : '';
            const input = this._formatUsageCount(data.prompt_tokens || 0);
            const output = this._formatUsageCount(data.completion_tokens || 0);
            const scaleShort = this._usageScaleShortLabel(data.scale || scale);
            counterEl.title = `Consommation de tokens (input/output) - période : ${this._usageScaleLabel(data.scale || scale)}. \nCliquez pour passer à la période suivante.`;
            counterEl.innerHTML = `<span class="user-usage-prefix">${prefix}</span><span>${input} / ${output} (${scaleShort})</span>`;
        } catch (err) {
            console.error('[Shell] Failed to load usage:', err);
            counterEl.innerHTML = '<span>- / -</span>';
        }
    }

    _usageScaleShortLabel(scale) {
        const labels = {
            day: 'jour',
            week: 'semaine',
            month: 'mois',
            total: 'total',
        };
        return labels[scale] || scale;
    }

    _cycleUsageScale(counterEl) {
        const scales = ['day', 'week', 'month', 'total'];
        const current = counterEl.dataset.scale || 'day';
        const next = scales[(scales.indexOf(current) + 1) % scales.length];
        counterEl.dataset.scale = next;
        this._loadUsageCounter(counterEl);
    }

    _toggleUserMenu(button, user) {
        const existing = document.querySelector('#user-menu-dropdown');
        if (existing) {
            existing.remove();
            return;
        }

        const menu = document.createElement('div');
        menu.id = 'user-menu-dropdown';
        menu.className = 'user-menu-dropdown';
        menu.innerHTML = `
            <div class="user-menu-header">
                <div class="user-menu-username">${this._escape(user.username)}</div>
                <div class="user-menu-usage-line">
                    <span class="user-usage-counter" data-scale="day" title="Consommation de tokens (input/output) - période : aujourd'hui. \nCliquez pour changer de période.">...</span>
                    <span class="user-usage-unit">tokens</span>
                </div>
            </div>
            <button type="button" class="user-menu-item" id="user-menu-api-keys">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
                </svg>
                Clés API
            </button>
            <button type="button" class="user-menu-item" id="user-menu-change-password">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <rect x="5" y="11" width="14" height="10" rx="2" ry="2" stroke-width="2"></rect>
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 11V7a5 5 0 0110 0v4"></path>
                </svg>
                Modifier le mot de passe
            </button>
            <button type="button" class="user-menu-item user-menu-logout" id="user-menu-logout">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path>
                </svg>
                Déconnexion
            </button>
        `;

        document.body.appendChild(menu);
        const rect = button.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 6}px`;
        menu.style.right = `${document.documentElement.clientWidth - rect.right}px`;

        const usageCounter = menu.querySelector('.user-usage-counter');
        if (usageCounter) {
            this._loadUsageCounter(usageCounter);
            usageCounter.addEventListener('click', (e) => {
                e.stopPropagation();
                this._cycleUsageScale(usageCounter);
            });
        }

        menu.querySelector('#user-menu-api-keys').addEventListener('click', () => {
            menu.remove();
            if (this.apiKeysManager) this.apiKeysManager.show();
        });
        menu.querySelector('#user-menu-change-password').addEventListener('click', () => {
            menu.remove();
            if (this.authManager) this.authManager.showChangePassword();
        });
        menu.querySelector('#user-menu-logout').addEventListener('click', async () => {
            menu.remove();
            if (!this.authManager) return;
            await this.authManager.logout();
            if (this.historyPanel) this.historyPanel.close();
            this.renderAuthActions(null);
        });

        const closeMenu = (e) => {
            if (!menu.contains(e.target) && e.target !== button) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        document.addEventListener('click', closeMenu);
    }

    _escape(text) {
        return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    addAppButton(appClass) {
        const btn = document.createElement('button');
        btn.className = 'nav-tab shell-tag-style shell-glow';
        btn.dataset.appId = appClass.id;
        const icon = appClass.iconSvg || '';
        btn.innerHTML = `${icon} <span>${appClass.title}</span>`;
        btn.addEventListener('click', () => {
            // Delegate instance creation/restoration entirely to the window manager
            // so the nav buttons never create duplicates or target wrong instances.
            this.windowManager.switchToApp(appClass.id);
        });
        this.tabBar.appendChild(btn);
        return btn;
    }

    setActiveTab(appId) {
        Array.from(this.tabBar.children).forEach(btn => {
            btn.classList.toggle('active', btn.dataset.appId === appId);
        });
    }
}

window.Shell = Shell;
