/**
 * SearchGateway
 *
 * Encapsulates all search and tag HTTP calls.
 */

const SearchGateway = (() => {
    async function postSearch(query, tags = [], limit = 20) {
        const res = await fetch("api/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q: query, tags, limit }),
        });
        if (!res.ok) throw new Error(`Search failed: ${res.status}`);
        return res.json();
    }

    async function getTags() {
        const res = await fetch("api/search/tags");
        if (!res.ok) throw new Error(`Tags failed: ${res.status}`);
        return res.json();
    }

    async function saveSearch(query, tags = []) {
        const res = await fetch("api/searches", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ query, tags }),
        });
        if (!res.ok) {
            if (res.status === 401) throw new Error("not_authenticated");
            throw new Error(`Save search failed: ${res.status}`);
        }
        return res.json();
    }

    async function getSearches() {
        const res = await fetch("api/searches", { credentials: "same-origin" });
        if (!res.ok) throw new Error(`Searches list failed: ${res.status}`);
        return res.json();
    }

    async function deleteSearch(searchId) {
        const res = await fetch(`api/searches/${searchId}`, {
            method: "DELETE",
            credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`Delete search failed: ${res.status}`);
        return res.json();
    }

    async function touchSearch(searchId) {
        const res = await fetch(`api/searches/${searchId}/open`, {
            method: "POST",
            credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`Touch search failed: ${res.status}`);
        return res.json();
    }

    return {
        postSearch,
        getTags,
        saveSearch,
        getSearches,
        deleteSearch,
        touchSearch,
    };
})();

window.SearchGateway = SearchGateway;
