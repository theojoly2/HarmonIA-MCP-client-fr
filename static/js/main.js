/**
 * Main entrypoint
 * Bootstraps the shell, window manager, and registers all apps.
 */

(async function() {
    // Register apps
    AppState.registerApp(SearchApp);
    AppState.registerApp(VisionApp);
    AppState.registerApp(PreviewApp);
    AppState.registerApp(ChatApp);

    // Create shell
    const appShell = document.getElementById('app-shell');
    const splitRoot = document.createElement('div');
    splitRoot.className = 'h-full w-full';

    const shell = new Shell(appShell, null);
    const contentArea = shell.getContentArea();

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

    // Wire shell buttons to window manager
    shell.windowManager = windowManager;

    // Add tab buttons
    shell.addAppButton(SearchApp);
    shell.addAppButton(VisionApp);

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
