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
        this.historyPanel = null;
    }

    setAuthManager(authManager) {
        this.authManager = authManager;
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
            historyBtn.title = 'Historique des modèles';
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
            <div class="user-menu-header">${this._escape(user.username)}</div>
            <button type="button" class="user-menu-item" id="user-menu-change-password">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
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
            // Always reuse the most recent non-floating instance of this app, or
            // create a fresh tab if none exists. The mode (tab/split) is the
            // manager's responsibility, not the shell's.
            const existing = AppState.listInstances()
                .filter((i) => i.appId === appClass.id && i.mode !== 'float')
                .pop();
            if (existing) {
                this.windowManager.switchTab(existing.instanceId);
            } else {
                this.windowManager.open(appClass.id, { mode: 'tab' });
            }
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
