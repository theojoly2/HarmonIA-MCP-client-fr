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
            <div id="shell-content" class="flex-1 relative overflow-hidden"></div>
        `;
        this.tabBar = this.container.querySelector('#tab-bar');
        this.actionsArea = this.container.querySelector('#shell-actions');
        this.contentArea = this.container.querySelector('#shell-content');
    }

    renderAuthActions(user, historyPanel) {
        this.actionsArea.innerHTML = '';
        if (user) {
            const historyBtn = document.createElement('button');
            historyBtn.id = 'history-toggle';
            historyBtn.className = 'history-toggle';
            historyBtn.title = 'Historique des modèles';
            historyBtn.innerHTML = `
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <span>Historique</span>
            `;
            historyBtn.addEventListener('click', () => {
                if (historyPanel) historyPanel.toggle();
            });

            const userLabel = document.createElement('span');
            userLabel.className = 'shell-user-label';
            userLabel.textContent = user.username;

            const logoutBtn = document.createElement('button');
            logoutBtn.className = 'shell-action-btn';
            logoutBtn.textContent = 'Déconnexion';
            logoutBtn.addEventListener('click', () => {
                if (window.AuthManager) window.AuthManager.logout().then(() => {
                    if (historyPanel) historyPanel.close();
                });
            });

            this.actionsArea.appendChild(historyBtn);
            this.actionsArea.appendChild(userLabel);
            this.actionsArea.appendChild(logoutBtn);
        } else {
            const loginBtn = document.createElement('button');
            loginBtn.className = 'shell-action-btn primary';
            loginBtn.textContent = 'Connexion';
            loginBtn.addEventListener('click', () => EventBus.emit('show-auth'));
            this.actionsArea.appendChild(loginBtn);
        }
    }

    getContentArea() {
        return this.contentArea;
    }

    addAppButton(appClass) {
        const btn = document.createElement('button');
        btn.className = 'nav-tab';
        btn.dataset.appId = appClass.id;
        const icon = appClass.iconSvg || '';
        btn.innerHTML = `${icon} <span>${appClass.title}</span>`;
        btn.addEventListener('click', () => {
            const existing = AppState.listInstances().find(i => i.appId === appClass.id && i.mode === 'tab');
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
