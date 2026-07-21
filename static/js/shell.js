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
                <div class="flex items-center gap-2">
                    <button id="btn-float-active" class="nav-tab" title="Fenêtre flottante">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                    </button>
                    <button id="btn-split-active" class="nav-tab" title="Split view">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"></path></svg>
                    </button>
                </div>
            </div>
            <div id="shell-content" class="flex-1 relative overflow-hidden"></div>
        `;
        this.tabBar = this.container.querySelector('#tab-bar');
        this.contentArea = this.container.querySelector('#shell-content');

        this.container.querySelector('#btn-float-active').addEventListener('click', () => {
            const active = AppState.getActiveInstance();
            if (active) this.windowManager.moveToFloat(active);
        });
        this.container.querySelector('#btn-split-active').addEventListener('click', () => {
            const active = AppState.getActiveInstance();
            if (active) this.windowManager.moveToSplit(active);
        });
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
