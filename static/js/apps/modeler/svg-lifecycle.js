/**
 * ModelerSvgLifecycle
 * Pure helper for ModelerApp home/viewer transitions and SVG viewer state.
 * No direct gateway calls; only DOM/viewer coordination.
 */

const ModelerSvgLifecycle = (() => {
    function measureHomeContentHeight(home) {
        let contentHeight = 0;
        for (const child of home.children) {
            const rect = child.getBoundingClientRect();
            const styles = getComputedStyle(child);
            const marginTop = parseFloat(styles.marginTop) || 0;
            const marginBottom = parseFloat(styles.marginBottom) || 0;
            contentHeight += rect.height + marginTop + marginBottom;
        }
        return Math.max(contentHeight, 360);
    }

    function updateHomeVisibility(container, svgText, skipTransition = false, _skipNextTransition = false) {
        const home = container.querySelector('#modeler-home');
        const importContainer = container.querySelector('#modeler-import-container');
        const viewer = container.querySelector('#modeler-viewer');
        if (!home || !importContainer || !viewer) return;

        if (svgText) {
            home.classList.add('modeler-top');
            home.style.paddingTop = '0px';
            importContainer.classList.add('modeler-import-hidden');
            importContainer.style.display = '';
            viewer.classList.remove('hidden');
            viewer.style.opacity = '1';
            viewer.style.transition = '';
        } else {
            const was = home.style.transition;
            if (skipTransition || _skipNextTransition) home.style.transition = 'none';
            home.classList.remove('modeler-top');
            const contentHeight = measureHomeContentHeight(home);
            const available = Math.max(container.clientHeight, contentHeight);
            const offset = Math.max(0, (available - contentHeight) / 2);
            home.style.paddingTop = offset + 'px';
            if (skipTransition || _skipNextTransition) {
                home.offsetHeight;
                home.style.transition = was;
            }
            importContainer.classList.remove('modeler-import-hidden');
            importContainer.style.display = '';
            importContainer.style.opacity = '1';
            importContainer.style.transform = 'translateY(0)';
            importContainer.style.transition = '';
            viewer.classList.add('hidden');
            viewer.style.opacity = '0';
            viewer.style.transition = '';
        }
    }

    function finalizeHomeAndCenter(container, svgController, _updateHomeVisibility) {
        if (svgController) {
            svgController.destroy();
        }
        _updateHomeVisibility(true);
    }

    function getSvgController(svgController, onTransform) {
        if (!svgController) {
            svgController = new SvgViewerController('#modeler-svg-viewer', {
                onTransform: (state) => { onTransform(state); }
            });
        }
        return svgController;
    }

    function showViewer({
        container,
        svgText,
        mainClassName,
        storedName,
        fileName,
        centerOnNextShow,
        viewerState,
        setCenterOnNextShow,
        updateAssistantToggleVisibility,
        updateExportToggleVisibility,
        updateEditButtonStates,
        setLoading,
        getSvgControllerRef,
        setSvgController,
    }) {
        const viewerPane = container.querySelector('#modeler-viewer');
        const app = container.querySelector('.modeler-app');
        const editActions = container.querySelector('#modeler-edit-actions');
        const assistantToggle = container.querySelector('#modeler-assistant-toggle');
        if (app) app.classList.remove('modeler-loading-layout');

        // Defer toggle visibility to the app because it knows split state.
        updateAssistantToggleVisibility();
        updateExportToggleVisibility();

        setLoading(true);
        let controller = getSvgControllerRef();
        const innerContainer = controller.getContainer(container);
        if (innerContainer) {
            innerContainer.classList.add('modeler-svg-hidden');
            innerContainer.style.transition = 'none';
        }

        if (controller.viewer && controller.viewer.svg && innerContainer && innerContainer.contains(controller.viewer.svg)) {
            if (viewerPane) {
                viewerPane.classList.remove('hidden');
                viewerPane.style.opacity = '1';
            }
            if (editActions) {
                editActions.classList.remove('hidden');
                updateEditButtonStates();
            }
            if (innerContainer) innerContainer.classList.remove('modeler-svg-hidden');
            setLoading(false);
            controller.observeResize(container);
            return;
        }

        controller.renderSvg(container, svgText, mainClassName, {
            shouldCenter: centerOnNextShow,
            stateToRestore: viewerState,
            onComplete: () => {
                setCenterOnNextShow(false);
                setLoading(false);
                if (viewerPane) {
                    viewerPane.style.transition = 'opacity 0.35s ease';
                    viewerPane.style.opacity = '1';
                }
                if (editActions) {
                    editActions.classList.remove('hidden');
                    updateEditButtonStates();
                }
                if (innerContainer) {
                    innerContainer.style.transition = 'opacity 0.35s ease';
                    innerContainer.classList.remove('modeler-svg-hidden');
                }
            },
        }).then(() => {
            controller.observeResize(container);
        });
    }

    function enterLoadingMode(container, setLoading) {
        const home = container.querySelector('#modeler-home');
        const importContainer = container.querySelector('#modeler-import-container');
        const dropZone = container.querySelector('#modeler-drop-zone');
        const viewer = container.querySelector('#modeler-viewer');
        if (!home || !importContainer || !viewer) return;

        const startPadding = parseFloat(getComputedStyle(home).paddingTop) || 0;
        home.style.transition = 'none';
        home.style.paddingTop = startPadding + 'px';
        home.classList.remove('modeler-top');
        void home.offsetHeight;

        home.style.transition = 'padding-top 0.55s cubic-bezier(0.4, 0, 0.2, 1)';
        home.style.paddingTop = '0px';
        importContainer.classList.add('modeler-import-hidden');
        if (dropZone) dropZone.style.display = 'none';

        viewer.classList.remove('hidden');
        viewer.style.opacity = '1';
        const svgViewer = container.querySelector('#modeler-svg-viewer');
        if (svgViewer) {
            svgViewer.classList.add('modeler-svg-hidden');
            svgViewer.style.transition = 'none';
        }
        void viewer.offsetHeight;
        setLoading(true);
    }

    function showLoadingState(container, setLoading, homeTimeoutRef, loadingTimeoutRef) {
        const home = container.querySelector('#modeler-home');
        const importContainer = container.querySelector('#modeler-import-container');
        const dropZone = container.querySelector('#modeler-drop-zone');
        const viewer = container.querySelector('#modeler-viewer');
        if (!home || !importContainer || !viewer) return;

        if (homeTimeoutRef.value) {
            clearTimeout(homeTimeoutRef.value);
            homeTimeoutRef.value = null;
        }
        if (loadingTimeoutRef.value) {
            clearTimeout(loadingTimeoutRef.value);
            loadingTimeoutRef.value = null;
        }

        importContainer.classList.add('modeler-import-hidden');
        if (dropZone) dropZone.style.display = '';
        home.classList.add('modeler-top');
        home.style.transition = 'none';
        home.style.paddingTop = '0px';
        home.style.paddingBottom = '0px';
        home.style.marginBottom = '0px';
        home.style.minHeight = 'auto';
        home.style.position = 'relative';
        home.style.zIndex = '25';

        const app = container.querySelector('.modeler-app');
        if (app) app.classList.add('modeler-loading-layout');

        viewer.classList.remove('hidden');
        viewer.style.transition = 'none';
        viewer.style.opacity = '1';
        viewer.style.display = 'flex';

        void home.offsetHeight;
        void viewer.offsetHeight;

        setLoading(true);
    }

    return {
        measureHomeContentHeight,
        updateHomeVisibility,
        finalizeHomeAndCenter,
        getSvgController,
        showViewer,
        enterLoadingMode,
        showLoadingState,
    };
})();

window.ModelerSvgLifecycle = ModelerSvgLifecycle;
