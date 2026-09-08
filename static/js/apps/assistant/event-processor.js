/**
 * AssistantEventProcessor
 * Stateless helper that maps a single assistant SSE event to renderer/app side effects.
 * It does not own state but receives a context object with all dependencies.
 */

const AssistantEventProcessor = (() => {
    const toolStatusLabels = {
        plan_workflow_with_tools: 'Planification en cours...',
        retrieve_documents: 'Recherche de contexte...',
        add_class: 'Création de la classe...',
        add_attribute: "Ajout d'un attribut...",
        add_connector: 'Création de la relation...',
        style_guide_check: 'Synthèse de la réponse...',
    };

    function toolStatusLabel(name) {
        return toolStatusLabels[name] || `${name}...`;
    }

    function toolSummary(result) {
        if (!result || typeof result !== 'object') return '';
        const toolResults = result.tool_results;
        if (!toolResults || typeof toolResults !== 'object') return '';
        if (Array.isArray(toolResults) && toolResults.length > 0) {
            return ` (${toolResults.length} résultats)`;
        }
        if (Object.keys(toolResults).length > 0) {
            return ` (${Object.keys(toolResults).length} entrées)`;
        }
        return '';
    }

    function processEvent(event, ctx) {
        const {
            renderer,
            ui,
            escape,
            markdown,
            embedded,
            linkedModelerInstanceId,
            modelNames,
            onModelAttached,
            onSvgRefresh,
            getCurrentStreamingText,
            setCurrentStreamingText,
            getSession,
            setSession,
            saveHtmlSnapshot,
            typewriter,
            placeholderRef,
            streamAliveTimeoutRef,
            abortController,
        } = ctx;

        if (streamAliveTimeoutRef?.timeout) {
            clearTimeout(streamAliveTimeoutRef.timeout);
        }
        if (streamAliveTimeoutRef && abortController) {
            streamAliveTimeoutRef.timeout = setTimeout(() => {
                abortController.abort();
            }, 120000);
        }

        if (event.kind === 'user') {
            if (event.session) setSession(event.session);
            renderer.freezeCurrentSvgCard();
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'thinking') {
            renderer.hideAllSparkles();
            renderer.removeThinkingPlaceholder();
            placeholderRef.value = renderer.appendThinkingPlaceholder('Réflexion...');
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'assistant_text') {
            if (typewriter && typewriter.append) {
                // Let the typewriter create and own the active bubble (and its
                // sparkle). Do not call renderer.ensureAssistantBubble() here to
                // avoid a duplicate empty bubble with a stale sparkle.
                typewriter.append(event.content || '');
                typewriter.start();
            } else {
                const bubble = renderer.ensureAssistantBubble();
                const next = (getCurrentStreamingText() || '') + (event.content || '');
                setCurrentStreamingText(next);
                bubble.innerHTML = markdown(next, false);
            }
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'assistant_tool_calls') {
            typewriter?.stop?.();
            typewriter?.flush?.();
            typewriter?.reset?.();
            renderer.closeAssistantBubble();
            renderer.hideAllSparkles();
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'tool_start') {
            typewriter?.stop?.();
            typewriter?.flush?.();
            typewriter?.reset?.();
            renderer.closeAssistantBubble();
            renderer.hideAllSparkles();
            if (event.name === 'retrieve_documents') {
                renderer.appendSearchCard(event.arguments?.search_terms || '', null);
            }
            placeholderRef.value = renderer.appendThinkingPlaceholder(toolStatusLabel(event.name));
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'progress_start') {
            typewriter?.stop?.();
            typewriter?.flush?.();
            typewriter?.reset?.();
            renderer.closeAssistantBubble();
            renderer.hideAllSparkles();
            renderer.appendProgressCard(event.card_id, event.tool_name);
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'progress_update') {
            renderer.updateProgressCard(event.card_id, event.percent, event.message);
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'progress_done') {
            renderer.completeProgressCard(event.card_id);
            renderer.removeProgressStatus(event.card_id);
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'tool_result') {
            typewriter?.stop?.();
            typewriter?.flush?.();
            typewriter?.reset?.();
            renderer.closeAssistantBubble();
            if (event.name === 'plan_workflow_with_tools') {
                renderer.renderPlan(event.result);
            } else if (event.name === 'retrieve_documents') {
                const display = event.display || {};
                const results = display.results || [];
                const resultsHtml = ui.buildResultsHtml(results, display.result_count || results.length, { hideEmpty: false });
                renderer.fillSearchCard(display.query || '', resultsHtml);
            } else {
                renderer.fillToolResult(event.name, event.result, event.display, { toolSummary });
            }
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'loop_done') {
            typewriter?.stop?.();
            typewriter?.flush?.();
            typewriter?.reset?.();
            renderer.closeAssistantBubble();
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'model_svg') {
            if (linkedModelerInstanceId && modelNames?.length) {
                onSvgRefresh(linkedModelerInstanceId);
            } else if (!embedded) {
                const rawName = event.model_name || event.label || '';
                const label = rawName
                    ? (rawName.includes('__') ? rawName.split('__').slice(0, -1).join('__') : rawName)
                    : 'Visualisation du modèle';
                renderer.updateCurrentSvgCard(event.svg, label);
            }
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'model_attached') {
            const attachedName = event.model_name;
            if (attachedName && !modelNames.includes(attachedName)) {
                modelNames.push(attachedName);
                onModelAttached(attachedName);
            }
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'assistant_done') {
            typewriter?.stop?.();
            typewriter?.flush?.();
            typewriter?.reset?.();
            renderer.closeAssistantBubble();
            renderer.removeThinkingPlaceholder();
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'error') {
            typewriter?.stop?.();
            typewriter?.flush?.();
            typewriter?.reset?.();
            renderer.closeAssistantBubble();
            const bubble = renderer.ensureAssistantBubble();
            bubble.innerHTML += `<br><em class="text-red-600">Erreur : ${escape(event.message || '')}</em>`;
            saveHtmlSnapshot();
            return;
        }
    }

    return {
        toolStatusLabel,
        toolSummary,
        processEvent,
    };
})();

window.AssistantEventProcessor = AssistantEventProcessor;
