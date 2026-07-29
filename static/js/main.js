/**
 * Main entrypoint
 * Bootstraps the shell, window manager, and registers all apps.
 */

(async function() {
    // Register apps
    AppState.registerApp(SearchApp);
    AppState.registerApp(ModelerApp);
    AppState.registerApp(PreviewApp);
    AppState.registerApp(ChatApp);

    // Auth state + pending import manager
    await AuthManager.init();

    // Create shell
    const appShell = document.getElementById('app-shell');
    const splitRoot = document.createElement('div');
    splitRoot.className = 'h-full w-full';

    const shell = new Shell(appShell, null);
    shell.setAuthManager(AuthManager);
    const contentArea = shell.getContentArea();

    // History panel attached to the dedicated overlay area so it survives tab mounts.
    const historyPanel = new HistoryPanel(shell.getOverlayArea());
    shell.setHistoryPanel(historyPanel);

    // Split manager for shell content
    const splitManager = new SplitManager(contentArea, {
        onEmpty: async () => {
            // When no split leaves, show active tab app
            const active = AppState.getActiveInstance();
            if (active) {
                const inst = AppState.getInstance(active);
                if (inst) {
                    contentArea.innerHTML = '';
                    const pane = document.createElement('div');
                    pane.className = 'h-full w-full';
                    contentArea.appendChild(pane);
                    await inst.mount(pane);
                }
            }
        }
    });

    // Window manager
    const windowManager = new WindowManager(contentArea, splitManager);
    window.historyPanel = historyPanel;
    window.windowManager = windowManager;

    // Wire shell buttons to window manager
    shell.windowManager = windowManager;

    // Add tab buttons
    shell.addAppButton(SearchApp);
    shell.addAppButton(ModelerApp);

    shell.renderAuthActions(AuthManager.getUser());

    // Persist a pending import only if its Modéliseur instance is still open when login happens.
    function isPendingImportStillOpen() {
        const pending = AuthManager.getPendingImport();
        if (!pending || !pending.svgText) return false;
        const instances = AppState.listInstances();
        return instances.some((i) => i.appId === "modeler" && AppState.getInstance(i.instanceId)?.svgText === pending.svgText);
    }

    async function flushPendingImport() {
        if (!isPendingImportStillOpen()) {
            AuthManager.clearPendingImport();
            return;
        }
        const pending = AuthManager.getPendingImport();
        try {
            await ApiClient.importAndSaveModel(pending.file, pending.fileName);
            AuthManager.clearPendingImport();
            historyPanel.load();
        } catch (err) {
            console.error("Flush pending import error", err);
        }
    }

    AuthManager.onLogin(async (user) => {
        shell.renderAuthActions(user);
        await flushPendingImport();
        historyPanel.load();
    });

    AuthManager.onLogout(() => {
        shell.renderAuthActions(null);
        historyPanel.close();
    });

    // Auth modal: show when not authenticated, but allow browsing search without login.
    // Wait until the initial search tab is mounted so the UI is not empty behind the modal.
    if (!AuthManager.isLoggedIn()) {
        setTimeout(() => AuthManager.showModal(), 0);
    }

    // Global helper
    window.AuthManager = AuthManager;

    // Event bus handlers
    EventBus.on('open-preview', ({ docId, documentId, name }) => {
        windowManager.open('preview', {
            mode: 'float',
            docId,
            documentId,
            name,
        });
    });

    EventBus.on('open-chat', ({ documentId, name }) => {
        windowManager.open('chat', {
            mode: 'float',
            documentId,
            name,
        });
    });

    // Initialize glow effects
    GlowEffects.init();

    // Initial app: search
    await windowManager.open('search', { mode: 'tab' });

    // Window resize handling for centering
    window.addEventListener('resize', () => {
        const active = AppState.getActiveInstance();
        const inst = active ? AppState.getInstance(active) : null;
        if (inst && inst._applyCentering) inst._applyCentering();
    });
})();
