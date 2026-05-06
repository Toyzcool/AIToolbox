const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    FOLDER_COLORS,
    generateFolderId,
    createFolder,
    renameFolder,
    recolorFolder,
    deleteFolder,
    assignConversation,
    listFolderConversations,
    filterEntriesByFolder,
} = require(path.resolve(__dirname, '..', 'lib', 'pure.js'));

// ----- generateFolderId ---------------------------------------------------

test('generateFolderId: starts with f_ prefix', () => {
    assert.match(generateFolderId(), /^f_/);
});

test('generateFolderId: produces unique values across rapid calls', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(generateFolderId());
    assert.equal(ids.size, 100);
});

// ----- createFolder -------------------------------------------------------

test('createFolder: appends a new folder with given name + color', () => {
    const before = [];
    const after = createFolder(before, 'Database research', '#34C759');
    assert.equal(after.length, 1);
    assert.equal(after[0].name, 'Database research');
    assert.equal(after[0].color, '#34C759');
    assert.match(after[0].id, /^f_/);
    assert.ok(after[0].createdAt > 0);
});

test('createFolder: trims whitespace from name', () => {
    const after = createFolder([], '   Resume tips   ', '#FF9F0A');
    assert.equal(after[0].name, 'Resume tips');
});

test('createFolder: rejects empty / whitespace-only names', () => {
    assert.throws(() => createFolder([], '', '#FF3B30'));
    assert.throws(() => createFolder([], '   ', '#FF3B30'));
});

test('createFolder: defaults to blue when color is invalid', () => {
    const after = createFolder([], 'X', '#NOTACOLOR');
    assert.equal(after[0].color, '#007AFF');
});

test('createFolder: preserves existing folders (immutable)', () => {
    const before = [{ id: 'f_1', name: 'Old', color: '#FF3B30', createdAt: 1 }];
    const after = createFolder(before, 'New', '#34C759');
    assert.equal(after.length, 2);
    assert.notEqual(after, before);
    assert.deepEqual(before, [{ id: 'f_1', name: 'Old', color: '#FF3B30', createdAt: 1 }]);
});

test('createFolder: handles undefined input array', () => {
    const after = createFolder(undefined, 'New', '#34C759');
    assert.equal(after.length, 1);
});

// ----- renameFolder -------------------------------------------------------

test('renameFolder: updates name, preserves color and createdAt', () => {
    const before = [{ id: 'f_1', name: 'Old', color: '#FF3B30', createdAt: 100 }];
    const after = renameFolder(before, 'f_1', 'New name');
    assert.equal(after[0].name, 'New name');
    assert.equal(after[0].color, '#FF3B30');
    assert.equal(after[0].createdAt, 100);
});

test('renameFolder: no-op for unknown id', () => {
    const before = [{ id: 'f_1', name: 'A', color: '#FF3B30', createdAt: 1 }];
    const after = renameFolder(before, 'f_999', 'B');
    assert.deepEqual(after, before);
});

test('renameFolder: rejects empty name', () => {
    const before = [{ id: 'f_1', name: 'A', color: '#FF3B30', createdAt: 1 }];
    assert.throws(() => renameFolder(before, 'f_1', ''));
});

// ----- recolorFolder ------------------------------------------------------

test('recolorFolder: updates color in palette', () => {
    const before = [{ id: 'f_1', name: 'A', color: '#FF3B30', createdAt: 1 }];
    const after = recolorFolder(before, 'f_1', '#34C759');
    assert.equal(after[0].color, '#34C759');
});

test('recolorFolder: ignores non-palette colors', () => {
    const before = [{ id: 'f_1', name: 'A', color: '#FF3B30', createdAt: 1 }];
    const after = recolorFolder(before, 'f_1', '#abcdef');
    assert.equal(after[0].color, '#FF3B30');
});

// ----- deleteFolder -------------------------------------------------------

test('deleteFolder: removes folder + cleans assignments across all sites', () => {
    const folders = [
        { id: 'f_1', name: 'Keep', color: '#FF3B30', createdAt: 1 },
        { id: 'f_2', name: 'Drop', color: '#34C759', createdAt: 2 },
    ];
    const assignmentsBySite = {
        chatgpt: { 'c1': 'f_1', 'c2': 'f_2', 'c3': 'f_2' },
        claude: { 'cc1': 'f_2' },
        gemini: { 'g1': 'f_1' },
    };
    const result = deleteFolder(folders, 'f_2', assignmentsBySite);
    assert.equal(result.folders.length, 1);
    assert.equal(result.folders[0].id, 'f_1');
    assert.deepEqual(result.assignments.chatgpt, { 'c1': 'f_1' });
    assert.deepEqual(result.assignments.claude, {});
    assert.deepEqual(result.assignments.gemini, { 'g1': 'f_1' });
});

test('deleteFolder: no-op when id not found', () => {
    const folders = [{ id: 'f_1', name: 'X', color: '#FF3B30', createdAt: 1 }];
    const result = deleteFolder(folders, 'f_999', {});
    assert.deepEqual(result.folders, folders);
});

// ----- assignConversation -------------------------------------------------

test('assignConversation: adds new mapping', () => {
    const before = {};
    const after = assignConversation(before, 'c1', 'f_1');
    assert.equal(after['c1'], 'f_1');
});

test('assignConversation: overwrites existing mapping', () => {
    const before = { 'c1': 'f_1' };
    const after = assignConversation(before, 'c1', 'f_2');
    assert.equal(after['c1'], 'f_2');
});

test('assignConversation: null folderId removes assignment', () => {
    const before = { 'c1': 'f_1', 'c2': 'f_2' };
    const after = assignConversation(before, 'c1', null);
    assert.equal(after['c1'], undefined);
    assert.equal(after['c2'], 'f_2');
});

test('assignConversation: undefined folderId removes assignment', () => {
    const before = { 'c1': 'f_1' };
    const after = assignConversation(before, 'c1', undefined);
    assert.equal(after['c1'], undefined);
});

test('assignConversation: ignores empty conversationId', () => {
    const before = { 'c1': 'f_1' };
    const after = assignConversation(before, '', 'f_2');
    assert.deepEqual(after, before);
    assert.notEqual(after, before, 'still returns a new object');
});

// ----- listFolderConversations --------------------------------------------

test('listFolderConversations: returns all matching ids', () => {
    const assignments = { 'c1': 'f_1', 'c2': 'f_2', 'c3': 'f_1' };
    const result = listFolderConversations(assignments, 'f_1').sort();
    assert.deepEqual(result, ['c1', 'c3']);
});

test('listFolderConversations: empty when none match', () => {
    assert.deepEqual(listFolderConversations({ 'c1': 'f_1' }, 'f_999'), []);
});

test('listFolderConversations: empty for missing folderId', () => {
    assert.deepEqual(listFolderConversations({ 'c1': 'f_1' }, null), []);
});

// ----- filterEntriesByFolder ----------------------------------------------

test('filterEntriesByFolder: returns all entries when no folderId', () => {
    const entries = [
        { id: 'a', _site: 'chatgpt' },
        { id: 'b', _site: 'claude' },
    ];
    assert.deepEqual(filterEntriesByFolder(entries, null, {}), entries);
});

test('filterEntriesByFolder: keeps only assigned entries (cross-site)', () => {
    const entries = [
        { id: 'c1', _site: 'chatgpt', title: 'A' },
        { id: 'c2', _site: 'chatgpt', title: 'B' },
        { id: 'cc1', _site: 'claude', title: 'C' },
        { id: 'g1', _site: 'gemini', title: 'D' },
    ];
    const assignments = {
        chatgpt: { 'c1': 'f_research' },
        claude: { 'cc1': 'f_research' },
        gemini: {},
    };
    const result = filterEntriesByFolder(entries, 'f_research', assignments);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(r => r.id).sort(), ['c1', 'cc1']);
});

test('filterEntriesByFolder: missing site map is harmless', () => {
    const entries = [{ id: 'c1', _site: 'chatgpt' }];
    const result = filterEntriesByFolder(entries, 'f_x', {});
    assert.deepEqual(result, []);
});

// ----- FOLDER_COLORS ------------------------------------------------------

test('FOLDER_COLORS: exposes 8 distinct hex values', () => {
    assert.equal(FOLDER_COLORS.length, 8);
    assert.equal(new Set(FOLDER_COLORS).size, 8);
    for (const c of FOLDER_COLORS) assert.match(c, /^#[0-9A-F]{6}$/i);
});
