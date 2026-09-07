/**
 * ApiClient
 *
 * Backward-compatible façade over the domain gateways.
 *
 * New code should import the relevant gateway directly (ModelGateway,
 * SearchGateway, AssistantGateway, DocumentGateway, AuthGateway,
 * ExternalApiGateway). ApiClient is kept for older code and external
 * callers that still rely on it.
 */

const ApiClient = (() => {
    function getDocumentFileUrl(documentId) {
        return DocumentGateway.getFileUrl(documentId);
    }

    function getDocumentVisualizeUrl(documentId) {
        return DocumentGateway.getVisualizeUrl(documentId);
    }

    return {
        postSearch: SearchGateway.postSearch,
        getTags: SearchGateway.getTags,
        getDocumentFileUrl,
        getDocumentVisualizeUrl,
        importModéliseurFile: ModelGateway.importFile,
        importAndSaveModel: ModelGateway.importAndSave,
        importAssistantModel: ModelGateway.importAssistantModel,
        importDocumentAsAssistantModel: ModelGateway.importDocumentAsAssistantModel,
        getModelSvg: ModelGateway.openSvg,
        createEmptyModel: ModelGateway.createEmpty,
        getModels: ModelGateway.getModels,
        saveSearch: SearchGateway.saveSearch,
        getSearches: SearchGateway.getSearches,
        deleteSearch: SearchGateway.deleteSearch,
        touchSearch: SearchGateway.touchSearch,
        me: AuthGateway.me,
        login: AuthGateway.login,
        register: AuthGateway.register,
        logout: AuthGateway.logout,
        streamChat: DocumentGateway.streamChat,
        streamAssistant: AssistantGateway.streamAssistant,
        getAssistantSessions: AssistantGateway.getAssistantSessions,
        getAssistantSessionsAll: AssistantGateway.getAssistantSessionsAll,
        findAssistantSessionByModel: AssistantGateway.findAssistantSessionByModel,
        getAssistantHistory: AssistantGateway.getAssistantHistory,
        deleteAssistantSession: AssistantGateway.deleteAssistantSession,
        touchAssistantSession: AssistantGateway.touchAssistantSession,
        exportModel: ModelGateway.exportAsBlob,
        getUsage: AuthGateway.getUsage,
    };
})();

window.ApiClient = ApiClient;
