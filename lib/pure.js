// Pure utility functions shared between the content script and unit tests.
//
// This file MUST stay free of DOM, chrome.*, and any browser-only globals so
// that Node's test runner can `require()` it directly. content.js loads this
// first via the manifest's content_scripts[].js array; it exposes the
// helpers on `globalThis.AIToolboxPure`.

(function (root, factory) {
    const lib = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = lib;
    }
    if (typeof globalThis !== 'undefined') {
        globalThis.AIToolboxPure = lib;
    } else if (typeof window !== 'undefined') {
        window.AIToolboxPure = lib;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    // djb2 — fast non-cryptographic hash. Used to detect "is this the same
    // message content" across DOM re-renders. Collisions are harmless because
    // they only cause a scroll to the wrong message, and an index is also
    // carried as a primary key.
    function hashText(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        }
        return String(h);
    }

    // Parse a CSS color value (rgb/rgba) and return Rec. 601 luma in [0, 1].
    // Returns null for unrecognized or fully-transparent colors so the caller
    // can fall through to other heuristics.
    function bgLuminance(str) {
        if (!str) return null;
        const m = str.match(/rgba?\(([^)]+)\)/i);
        if (!m) return null;
        const parts = m[1].split(',').map(s => parseFloat(s.trim()));
        const [r, g, b, a = 1] = parts;
        if (!Number.isFinite(r) || a === 0) return null;
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }

    // Per-site URL → conversation id extractors. Pulled out of the site
    // adapters so we can unit-test the regex behavior without bringing in
    // the rest of the bookmark engine.
    const conversationIdExtractors = {
        chatgpt(pathname) {
            const m = pathname.match(/\/c\/([0-9a-f-]+)/i);
            return m ? m[1] : null;
        },
        claude(pathname) {
            const m = pathname.match(/\/chat\/([0-9a-f-]+)/i);
            return m ? m[1] : null;
        },
        gemini(pathname) {
            const m = pathname.match(/\/app\/([^/?#]+)/i);
            return m ? m[1] : null;
        },
    };

    // Whitespace-flexible substring match. The bookmark store normalizes
    // whitespace at save time (\s+ → ' '), but Gemini's DOM preserves \n\t
    // between block elements; an exact indexOf would miss in that case. This
    // returns the index + matched length in `haystack`, or { index: -1 } if
    // no match.
    function findFlexibleMatch(haystack, needle) {
        if (!needle) return { index: -1, length: 0 };
        const lowerHay = haystack.toLowerCase();
        const lowerNeedle = needle.toLowerCase();
        const exact = lowerHay.indexOf(lowerNeedle);
        if (exact !== -1) return { index: exact, length: needle.length };

        const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const loose = escaped.replace(/\s+/g, '\\s+');
        const re = new RegExp(loose, 'i');
        const match = haystack.match(re);
        if (!match) return { index: -1, length: 0 };
        return { index: match.index, length: match[0].length };
    }

    // ----- History search ------------------------------------------------
    //
    // Score a conversation index entry against a query. Combines a strong
    // title-hit signal (the most likely thing users remember) with weaker
    // body-hit weighting and gentle recency decay so newer conversations
    // win ties. Returns 0 when nothing matches so callers can filter.
    //
    // Item shape: { id, title, allText?, updatedAt }
    //   - title is always present (scraped from the conversation list)
    //   - allText may be empty if the user hasn't opened that chat yet
    //     (we only index full text on visit) — title-only matches still
    //     score, just much lower
    //   - updatedAt is a Unix ms timestamp
    function scoreItem(item, normalizedQuery, now) {
        if (!normalizedQuery) return 0;
        const title = (item.title || '').toLowerCase();
        const body = (item.allText || '').toLowerCase();
        let score = 0;

        if (title.includes(normalizedQuery)) {
            score += 10;
            if (title.startsWith(normalizedQuery)) score += 5;
        }
        if (body) {
            // Count up to 5 body occurrences — diminishing returns past
            // that, and avoids letting a giant transcript dominate ranking.
            let bodyHits = 0;
            let from = 0;
            while (bodyHits < 5) {
                const idx = body.indexOf(normalizedQuery, from);
                if (idx === -1) break;
                bodyHits++;
                from = idx + normalizedQuery.length;
            }
            score += bodyHits;
        }

        if (score === 0) return 0;

        // Recency decay: half-life of 14 days. Caps at the score a body
        // match would add, so recency never overwhelms a clear text hit.
        const ageDays = Math.max(0, (now - (item.updatedAt || 0)) / 86400000);
        const recencyBoost = Math.min(2, 2 / Math.pow(2, ageDays / 14));
        return score + recencyBoost;
    }

    // Build a short context snippet around the first body match, e.g.
    // "...the standout feature was Postgres replication..." — used by the
    // search UI to show why a result ranked. Falls back to the title-only
    // case (return null so caller decides; usually shows the title alone).
    function buildSnippet(allText, normalizedQuery, contextChars = 60) {
        if (!allText || !normalizedQuery) return null;
        const lower = allText.toLowerCase();
        const idx = lower.indexOf(normalizedQuery);
        if (idx === -1) return null;
        const start = Math.max(0, idx - contextChars);
        const end = Math.min(allText.length, idx + normalizedQuery.length + contextChars);
        const prefix = start > 0 ? '…' : '';
        const suffix = end < allText.length ? '…' : '';
        // Collapse whitespace so multi-line transcripts don't render with
        // weird gaps in the snippet.
        const slice = allText.slice(start, end).replace(/\s+/g, ' ').trim();
        return `${prefix}${slice}${suffix}`;
    }

    // Run a search across an array of indexed items. Returns the top N
    // matches sorted by score then recency, each annotated with the
    // computed score and a snippet.
    function searchIndex(items, query, options = {}) {
        const limit = options.limit ?? 10;
        const now = options.now ?? Date.now();
        const normalizedQuery = (query || '').toLowerCase().trim();
        if (!normalizedQuery) return [];

        const scored = [];
        for (const item of items) {
            const score = scoreItem(item, normalizedQuery, now);
            if (score === 0) continue;
            scored.push({
                ...item,
                score,
                snippet: buildSnippet(item.allText, normalizedQuery),
            });
        }
        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return (b.updatedAt || 0) - (a.updatedAt || 0);
        });
        return scored.slice(0, limit);
    }

    // ----- History index storage helpers --------------------------------

    // Merge a batch of newly-scraped entries into an existing index.
    //
    // Rules:
    // - Index is keyed by id. Incoming entries with a matching id update
    //   the existing record; new ids append.
    // - allText is sticky: a full-conversation scrape sets it, but a later
    //   list-only scrape (which doesn't have allText) must not wipe it.
    // - title always takes the freshest value — Gemini in particular renames
    //   a conversation after the first AI reply.
    // - updatedAt is the freshest non-null timestamp; falls back to existing
    //   when incoming omits it.
    function mergeHistoryEntries(existing, incoming) {
        const map = new Map();
        for (const e of existing || []) {
            if (e && e.id) map.set(e.id, { ...e });
        }
        for (const inc of incoming || []) {
            if (!inc || !inc.id) continue;
            const prev = map.get(inc.id);
            if (!prev) {
                map.set(inc.id, {
                    ...inc,
                    title: inc.title || '',
                    allText: inc.allText || '',
                    updatedAt: inc.updatedAt || Date.now(),
                });
                continue;
            }
            // Spread prev first so any auxiliary fields (e.g. Gemini's
            // accountIndex) survive when an incoming list-scrape doesn't
            // include them. Then apply the freshness rules for known fields.
            map.set(inc.id, {
                ...prev,
                ...inc,
                title: inc.title ?? prev.title,
                // Preserve full text when incoming carries only a list-scrape title.
                allText: inc.allText ? inc.allText : prev.allText,
                updatedAt: inc.updatedAt ?? prev.updatedAt,
            });
        }
        return Array.from(map.values());
    }

    // Cap the index to the N most-recently-updated entries. Local storage has
    // ~5MB per extension; even at 5KB per conversation, 500 entries fits with
    // headroom. Sorting + slicing here means callers don't have to think
    // about it.
    function trimHistoryEntries(entries, maxSize) {
        if (!Array.isArray(entries)) return [];
        if (entries.length <= maxSize) return entries.slice();
        const sorted = entries.slice().sort(
            (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
        );
        return sorted.slice(0, maxSize);
    }

    // ----- Folders ---------------------------------------------------------
    //
    // Folders are cross-site (one folder can hold conversations from any of
    // the three AI services). Storage shape:
    //
    //   folders = [{ id, name, color, createdAt }]
    //   conversationFolders:{site} = { conversationId: folderId, ... }
    //
    // The pure helpers below operate on plain JS values so they can be unit-
    // tested. Side-effectful storage I/O lives in popup.js / content.js.

    // Apple system color palette — keeps folder colors recognizable across
    // light/dark themes and avoids a free-form picker.
    const FOLDER_COLORS = [
        '#FF3B30', // red
        '#FF9F0A', // orange
        '#FFD60A', // yellow
        '#34C759', // green
        '#30B0C7', // teal
        '#007AFF', // blue
        '#AF52DE', // purple
        '#8E8E93', // gray
    ];

    function generateFolderId() {
        return 'f_' + Date.now().toString(36) + '_' +
            Math.random().toString(36).slice(2, 8);
    }

    // Returns a new folders array with the given folder appended. Throws on
    // empty name (callers should pre-validate); duplicates are allowed —
    // users sometimes intentionally have two same-named folders for
    // different scopes.
    function createFolder(folders, name, color) {
        const trimmed = (name || '').trim();
        if (!trimmed) throw new Error('Folder name cannot be empty');
        const safeColor = FOLDER_COLORS.includes(color) ? color : FOLDER_COLORS[5];
        return [
            ...(folders || []),
            {
                id: generateFolderId(),
                name: trimmed,
                color: safeColor,
                createdAt: Date.now(),
            },
        ];
    }

    function renameFolder(folders, id, name) {
        const trimmed = (name || '').trim();
        if (!trimmed) throw new Error('Folder name cannot be empty');
        return (folders || []).map(f =>
            f && f.id === id ? { ...f, name: trimmed } : f
        );
    }

    function recolorFolder(folders, id, color) {
        if (!FOLDER_COLORS.includes(color)) return folders || [];
        return (folders || []).map(f =>
            f && f.id === id ? { ...f, color } : f
        );
    }

    // Remove a folder. Returns both the trimmed list AND a list of orphaned
    // conversation IDs from each site's assignment map so callers can clean
    // up the per-site assignment storage in one shot.
    function deleteFolder(folders, id, perSiteAssignments) {
        const remaining = (folders || []).filter(f => f && f.id !== id);
        const cleanedAssignments = {};
        for (const site of Object.keys(perSiteAssignments || {})) {
            const cleaned = {};
            for (const [convId, folderId] of Object.entries(perSiteAssignments[site] || {})) {
                if (folderId !== id) cleaned[convId] = folderId;
            }
            cleanedAssignments[site] = cleaned;
        }
        return { folders: remaining, assignments: cleanedAssignments };
    }

    // Assign a conversation to a folder. Pass folderId === null to remove
    // an existing assignment.
    function assignConversation(assignments, conversationId, folderId) {
        if (!conversationId) return { ...(assignments || {}) };
        const next = { ...(assignments || {}) };
        if (folderId === null || folderId === undefined) {
            delete next[conversationId];
        } else {
            next[conversationId] = folderId;
        }
        return next;
    }

    // Get all conversation IDs assigned to the given folder, across one
    // site's assignment map.
    function listFolderConversations(assignments, folderId) {
        if (!folderId) return [];
        const out = [];
        for (const [convId, fid] of Object.entries(assignments || {})) {
            if (fid === folderId) out.push(convId);
        }
        return out;
    }

    // Filter a list of history entries down to those assigned to the given
    // folder. Used by the popup search results to filter by the selected
    // folder chip. `assignmentsBySite` is the merged map of all three sites.
    function filterEntriesByFolder(entries, folderId, assignmentsBySite) {
        if (!folderId) return entries;
        return (entries || []).filter(entry => {
            const siteAssignments = (assignmentsBySite || {})[entry._site] || {};
            return siteAssignments[entry.id] === folderId;
        });
    }

    return {
        hashText,
        bgLuminance,
        conversationIdExtractors,
        findFlexibleMatch,
        scoreItem,
        buildSnippet,
        searchIndex,
        mergeHistoryEntries,
        trimHistoryEntries,
        FOLDER_COLORS,
        generateFolderId,
        createFolder,
        renameFolder,
        recolorFolder,
        deleteFolder,
        assignConversation,
        listFolderConversations,
        filterEntriesByFolder,
    };
});
