export function createSearchExportModule(deps) {
    const {
        host, doc, prefix, maxResults, getSettings, getContext, getChat,
        messageId, messageName, messageText, setMessageText, isUserMessage,
        currentChatName, chatKey, normalizeBlankLines, collapseExtraBlankLines,
        escapeHTML, escapeXml, escapeRegex, escapeCss, saveChat,
        verifySavedEntries, refreshVisibleMessage, emitMessageEdited,
        emitMessageUpdated, download, notify, renderPanel, closePanel,
        getRoot, infoButton, confirmState,
    } = deps;
    const PREFIX = prefix;
    const MAX_RESULTS = maxResults;

    let results = [];
    let currentResultIndex = -1;
    let lastUndo = null;
    let dirtyChanges = new Map();
    let searchSaveState = { saving: false, phase: '', startedAt: 0 };
    let searchSaveTimer = null;
    const ui = {
        query: '', replacement: '', scope: 'mes', regex: false, floor: '',
        bookmarkEditing: false, bookmarkName: '', exportFilename: '',
        exportStart: '', exportEnd: '', exportTags: '', exportIncludeUser: false,
        exportShowName: true, exportShowFloor: false, exportClean: true,
        exportTagPickerOpen: false, exportTagOptions: [],
    };

    function chatRow(raw, rawIndex) {
        return {
            raw,
            rawIndex,
            id: messageId(raw, rawIndex),
            name: messageName(raw),
            text: messageText(raw),
            isUser: isUserMessage(raw),
        };
    }
    
    function* iterateRows() {
        const chat = getChat();
        for (let rawIndex = 0; rawIndex < chat.length; rawIndex += 1) {
            yield chatRow(chat[rawIndex], rawIndex);
        }
    }
    
    function maxFloor() {
        const chat = getChat();
        let max = 0;
        for (let rawIndex = 0; rawIndex < chat.length; rawIndex += 1) {
            max = Math.max(max, Number(messageId(chat[rawIndex], rawIndex)) || rawIndex);
        }
        return max;
    }
    
    function fieldValue(row, scope) {
        if (scope === 'name' || scope === 'mes') {
            const staged = dirtyChanges.get(dirtyKey(row.rawIndex, scope));
            if (staged) return staged.after;
            return scope === 'name' ? row.name : row.text;
        }
        if (scope === 'json') {
            try { return JSON.stringify(row.raw); } catch (_) { return ''; }
        }
        return row.text;
    }
    
    function compileRegex(input) {
        const raw = String(input ?? '').trim();
        if (!raw) throw new Error('请输入要查找的内容');
        const slashForm = raw.match(/^\/([\s\S]*)\/([a-z]*)$/i);
        let source = raw;
        let flags = 'gi';
        if (slashForm) {
            source = slashForm[1];
            flags = slashForm[2] || 'g';
        }
        if (!flags.includes('g')) flags += 'g';
        try { return new RegExp(source, flags); }
        catch (error) { throw new Error(`正则语法错误：${error.message}`); }
    }
    
    function previewFor(text, start, length) {
        const source = String(text ?? '');
        const left = Math.max(0, start - 22);
        const right = Math.min(source.length, start + Math.max(length, 1) + 58);
        const compact = (value) => String(value ?? '').replace(/\s+/g, ' ');
        return {
            before: compact(`${left ? '…' : ''}${source.slice(left, start)}`),
            match: compact(source.slice(start, start + length)),
            after: compact(`${source.slice(start + length, right)}${right < source.length ? '…' : ''}`),
        };
    }
    
    function executeSearch({ preserveIndex = false, silent = false } = {}) {
        const query = String(ui.query || '');
        const previousIndex = currentResultIndex;
        if (!query.trim()) {
            results = [];
            currentResultIndex = -1;
            renderPanel();
            if (!silent) notify('请输入要查找的内容', 'warning');
            return;
        }
    
        try {
            const found = [];
            const regex = ui.regex ? compileRegex(query) : null;
            for (const row of iterateRows()) {
                const value = fieldValue(row, ui.scope);
                if (!value) continue;
                let occurrence = 0;
                if (regex) {
                    regex.lastIndex = 0;
                    for (const match of value.matchAll(regex)) {
                        const matched = match[0] ?? '';
                        const start = match.index ?? 0;
                        occurrence += 1;
                        found.push({ ...row, scope: ui.scope, start, length: matched.length, match: matched, preview: previewFor(value, start, matched.length), regex: true, occurrence });
                        if (found.length >= MAX_RESULTS) break;
                        // 对空匹配留给 matchAll 的规范推进；这里避免异常输入把界面塞满。
                        if (!matched && start >= value.length) break;
                    }
                } else {
                    const needle = query.toLocaleLowerCase();
                    const haystack = value.toLocaleLowerCase();
                    let from = 0;
                    while (from <= haystack.length) {
                        const start = haystack.indexOf(needle, from);
                        if (start < 0) break;
                        const match = value.slice(start, start + query.length);
                        occurrence += 1;
                        found.push({ ...row, scope: ui.scope, start, length: match.length, match, preview: previewFor(value, start, match.length), regex: false, occurrence });
                        if (found.length >= MAX_RESULTS) break;
                        from = start + Math.max(query.length, 1);
                    }
                }
                if (found.length >= MAX_RESULTS) break;
            }
            results = found;
            currentResultIndex = found.length ? (preserveIndex ? Math.min(Math.max(previousIndex, 0), found.length - 1) : 0) : -1;
            renderPanel();
            if (!silent && !found.length) notify('没有找到匹配内容', 'info');
            else if (!silent && found.length >= MAX_RESULTS) notify(`结果超过 ${MAX_RESULTS} 条，仅显示前 ${MAX_RESULTS} 条`, 'warning');
        } catch (error) {
            results = [];
            currentResultIndex = -1;
            renderPanel();
            notify(error.message, 'error');
        }
    }
    
    function selectedResult() {
        return results[currentResultIndex] || null;
    }
    
    function selectResult(index, jump) {
        if (!results.length) return;
        currentResultIndex = (index + results.length) % results.length;
        renderPanel();
        const row = getRoot()?.querySelector(`[data-result-index="${currentResultIndex}"]`);
        row?.scrollIntoView?.({ block: 'nearest' });
        if (jump) {
            jumpToFloor(selectedResult());
            closePanel();
        }
    }
    
    function jumpToFloor(resultOrFloor) {
        const result = typeof resultOrFloor === 'object' ? resultOrFloor : null;
        const floor = result ? result.id : resultOrFloor;
        if (floor === '' || floor === undefined || floor === null) return;
        try { host.TavernHelper?.triggerSlash?.(`/chat-jump ${floor}`); } catch (_) {}
        const selector = `.mes[mesid="${escapeCss(floor)}"]`;
        const node = doc.querySelector(selector) || (result ? doc.querySelectorAll('.mes')[result.rawIndex] : null);
        if (node) {
            node.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
            node.classList.add('ctb-jump-highlight');
            host.setTimeout(() => node.classList.remove('ctb-jump-highlight'), 1300);
        }
    }
    
    
    async function refreshChangedRows(rawIndexes) {
        const total = rawIndexes.length;
        for (let start = 0; start < total; start += 20) {
            const chunk = rawIndexes.slice(start, start + 20);
            chunk.forEach((rawIndex) => {
                refreshVisibleMessage(rawIndex);
                emitMessageEdited(rawIndex);
                emitMessageUpdated(rawIndex);
            });
            searchSaveState.phase = `聊天文件已保存，正在更新页面 ${Math.min(start + chunk.length, total)} / ${total}…`;
            updateSearchSaveStatus();
            if (start + chunk.length < total) {
                await new Promise((resolve) => (host.requestAnimationFrame || ((callback) => host.setTimeout(callback, 0)))(resolve));
            }
        }
    }
    
    function dirtyKey(rawIndex, field) {
        return `${rawIndex}:${field}`;
    }
    
    function actualFieldValue(rawIndex, field) {
        const message = getChat()[rawIndex];
        return field === 'name' ? String(message?.name ?? '') : messageText(message);
    }
    
    function stageValue(rawIndex, field, value) {
        const key = dirtyKey(rawIndex, field);
        const existing = dirtyChanges.get(key);
        const before = existing ? existing.before : actualFieldValue(rawIndex, field);
        if (String(value) === String(before)) dirtyChanges.delete(key);
        else dirtyChanges.set(key, { rawIndex, field, before, after: String(value), chatKey: chatKey() });
    }
    
    function rememberUndo(entries, label, saved = false) {
        lastUndo = { entries, label, saved, at: Date.now() };
    }
    
    async function undoLast() {
        if (!lastUndo?.entries?.length) {
            notify('本次页面会话没有可撤销的操作', 'info');
            return;
        }
        const backup = lastUndo;
        if (backup.staged) {
            backup.entries.forEach((entry) => stageValue(entry.rawIndex, entry.field, entry.before));
            lastUndo = null;
            executeSearch({ preserveIndex: true, silent: true });
            notify(`已撤销暂存操作：${backup.label}`, 'success');
            return;
        }
        const chat = getChat();
        backup.entries.forEach((entry) => {
            const message = chat[entry.rawIndex];
            if (!message) return;
            if (entry.field === 'name') message.name = entry.before;
            else setMessageText(message, entry.before);
            refreshVisibleMessage(entry.rawIndex);
        });
        const saved = backup.saved ? await saveChat() : true;
        lastUndo = null;
        renderPanel();
        notify(saved ? `已撤销：${backup.label}${backup.saved ? '，并已保存' : '（尚未保存）'}` : '已撤销，但没有找到自动保存接口，请手动保存', saved ? 'success' : 'warning');
    }
    
    function resultReplacement(result) {
        const value = fieldValue(result, result.scope);
        if (value.slice(result.start, result.start + result.length) !== result.match) throw new Error('结果内容已经变化，请重新查找后再替换');
        let replacement = ui.replacement;
        if (result.regex) {
            const re = compileRegex(ui.query);
            re.lastIndex = 0;
            replacement = result.match.replace(re, ui.replacement);
        }
        const next = value.slice(0, result.start) + replacement + value.slice(result.start + result.length);
        return result.scope === 'mes' ? normalizeBlankLines(next) : next;
    }
    
    function selectNextAfterReplacement(previous) {
        if (!results.length) {
            currentResultIndex = -1;
            renderPanel();
            return;
        }
        // 如果替换文本本身仍命中查询，跳过这个仍存在的命中；否则允许后续命中因文本变短而落到相同 start。
        const sameMatch = results.findIndex((item) => item.rawIndex === previous.rawIndex && item.start === previous.start && item.match === previous.match);
        let next;
        if (sameMatch >= 0) {
            next = sameMatch + 1 < results.length ? sameMatch + 1 : 0;
        } else {
            next = results.findIndex((item) => item.rawIndex > previous.rawIndex || (item.rawIndex === previous.rawIndex && item.start >= previous.start));
            if (next < 0) next = 0;
        }
        currentResultIndex = next < 0 ? 0 : next;
        renderPanel();
        const row = getRoot()?.querySelector(`[data-result-index="${currentResultIndex}"]`);
        row?.scrollIntoView?.({ block: 'nearest' });
    }
    
    function replaceCurrent() {
        if (ui.scope === 'json') return notify('完整消息 JSON 仅用于查找，不能直接替换', 'warning');
        const result = selectedResult();
        if (!result) return notify('请先查找并选择一个结果', 'warning');
        const message = getChat()[result.rawIndex];
        if (!message) return notify('原消息已经不存在，请重新查找', 'warning');
        try {
            const next = resultReplacement(result);
            const before = fieldValue(result, result.scope);
            if (next === before) return notify('替换后内容没有变化', 'info');
            stageValue(result.rawIndex, result.scope, next);
            rememberUndo([{ rawIndex: result.rawIndex, field: result.scope, before }], `替换楼层 #${result.id}`);
            lastUndo.staged = true;
            executeSearch({ preserveIndex: false, silent: true });
            selectNextAfterReplacement(result);
            notify(`已暂存并定位到下一处；聊天界面尚未改动，当前 ${dirtyChanges.size} 条待保存`, 'success');
        } catch (error) {
            notify(error.message, 'error');
        }
    }
    
    function replaceAll() {
        if (ui.scope === 'json') return notify('完整消息 JSON 仅用于查找，不能直接替换', 'warning');
        if (!ui.query.trim()) return notify('请输入查找内容', 'warning');
        if (!results.length) return notify('没有可替换的匹配结果', 'info');
        if (!confirmState.value) {
            confirmState.value = {
                title: '确认整体替换',
                message: `确定要替换当前范围内的 ${results.length} 个匹配吗？替换只会先暂存，仍需点击“保存修改”才写入聊天文件。`,
                action: 'replace-all',
            };
            return renderPanel();
        }
        return replaceAllNow();
    }
    
    function replaceAllNow() {
        try {
            const re = ui.regex ? compileRegex(ui.query) : new RegExp(escapeRegex(ui.query), 'gi');
            const changed = [];
            for (const row of iterateRows()) {
                const current = fieldValue(row, ui.scope);
                re.lastIndex = 0;
                if (!re.test(current)) continue;
                re.lastIndex = 0;
                const replaced = current.replace(re, ui.replacement);
                const next = ui.scope === 'mes' ? normalizeBlankLines(replaced) : replaced;
                if (next === current) continue;
                changed.push({ rawIndex: row.rawIndex, field: ui.scope, before: current });
                stageValue(row.rawIndex, ui.scope, next);
            }
            if (!changed.length) return notify('替换后内容没有变化', 'info');
            rememberUndo(changed, `整体替换 ${changed.length} 条消息`);
            lastUndo.staged = true;
            executeSearch({ preserveIndex: true, silent: true });
            notify(`已暂存 ${changed.length} 条消息；聊天界面尚未改动，确认后点击“保存修改”`, 'success');
        } catch (error) {
            notify(error.message, 'error');
        }
    }
    
    function stageBlankLineCleanup() {
        const changed = [];
        for (const row of iterateRows()) {
            const current = fieldValue(row, 'mes');
            const next = collapseExtraBlankLines(current);
            if (next === current) continue;
            changed.push({ rawIndex: row.rawIndex, field: 'mes', before: current });
            stageValue(row.rawIndex, 'mes', next);
        }
        if (!changed.length) return notify('当前聊天没有三个及以上的连续换行', 'info');
        rememberUndo(changed, `去除多余空行 ${changed.length} 条消息`);
        lastUndo.staged = true;
        if (ui.scope === 'mes' && ui.query.trim()) executeSearch({ preserveIndex: true, silent: true });
        else renderPanel();
        notify(`已把 ${changed.length} 条消息中的多余空行暂存为一个空行；确认后点击“保存修改”`, 'success');
    }
    
    async function saveSearchChanges() {
        if (!dirtyChanges.size) return notify('当前没有需要保存的修改', 'info');
        if (searchSaveState.saving) return;
        const entries = Array.from(dirtyChanges.values()).map((entry) => ({ ...entry }));
        const chat = getChat();
        for (const entry of entries) {
            if (entry.chatKey !== chatKey()) return notify('当前聊天已经切换。为避免写错文件，本次暂存没有保存', 'error');
            if (!chat[entry.rawIndex]) return notify(`楼层索引 ${entry.rawIndex} 已不存在，请刷新后重新查找`, 'error');
            if (actualFieldValue(entry.rawIndex, entry.field) !== entry.before) {
                return notify(`有楼层在暂存后发生了变化。为避免覆盖新内容，本次没有保存，请重新查找`, 'error');
            }
        }
        searchSaveState = { saving: true, phase: '正在把暂存稿写入聊天内存…', startedAt: Date.now() };
        renderPanel();
        startSearchSaveClock();
        const metadata = getContext().chatMetadata;
        const previousTainted = metadata?.tainted;
        try {
            entries.forEach((entry) => {
                const message = chat[entry.rawIndex];
                if (entry.field === 'name') message.name = entry.after;
                else setMessageText(message, normalizeBlankLines(entry.after));
            });
            if (metadata && typeof metadata === 'object') metadata.tainted = true;
            searchSaveState.phase = '正在一次保存整个聊天文件…';
            updateSearchSaveStatus();
            const saved = await saveChat();
            if (!saved) throw new Error('酒馆没有返回可用的保存结果');
            searchSaveState.phase = '正在快速核验保存结果（最多 1.5 秒）…';
            updateSearchSaveStatus();
            const verified = await verifySavedEntries(entries, { timeoutMs: 1500 });
            if (verified === false) throw new Error('聊天文件回读结果与暂存稿不一致，可能是酒馆保存超时');
            const count = entries.length;
            dirtyChanges.clear();
            rememberUndo(entries.map((entry) => ({ rawIndex: entry.rawIndex, field: entry.field, before: entry.before })), `保存 ${count} 条替换`, true);
            const changedRows = [...new Set(entries.map((entry) => entry.rawIndex))];
            await refreshChangedRows(changedRows);
            searchSaveState.phase = '保存完成';
            notify(`已一次写入并保存 ${count} 条修改`, 'success');
        } catch (error) {
            entries.forEach((entry) => {
                const message = chat[entry.rawIndex];
                if (!message) return;
                if (entry.field === 'name') message.name = entry.before;
                else setMessageText(message, entry.before);
                refreshVisibleMessage(entry.rawIndex);
            });
            if (metadata && typeof metadata === 'object') metadata.tainted = previousTainted;
            notify(`保存失败，已恢复聊天内存；暂存稿仍保留：${error.message}`, 'error');
        } finally {
            stopSearchSaveClock();
            searchSaveState = { saving: false, phase: '', startedAt: 0 };
            executeSearch({ preserveIndex: true, silent: true });
        }
    }
    
    function updateSearchSaveStatus() {
        const node = getRoot()?.querySelector('#ctb-save-status');
        if (!node || !searchSaveState.saving) return;
        const seconds = Math.max(0, Math.floor((Date.now() - searchSaveState.startedAt) / 1000));
        node.textContent = `${searchSaveState.phase} 已等待 ${seconds} 秒，请勿刷新页面。`;
    }
    
    function startSearchSaveClock() {
        stopSearchSaveClock();
        updateSearchSaveStatus();
        searchSaveTimer = host.setInterval(updateSearchSaveStatus, 500);
    }
    
    function stopSearchSaveClock() {
        if (searchSaveTimer) host.clearInterval(searchSaveTimer);
        searchSaveTimer = null;
    }
    
    function currentBookmarks() {
        const key = chatKey();
        const values = getSettings().bookmarks[key];
        return Array.isArray(values) ? values : [];
    }
    
    function saveBookmark() {
        const id = Number(ui.floor);
        if (!Number.isFinite(id) || id < 0) return notify('请输入有效楼层号', 'warning');
        const list = currentBookmarks();
        const label = String(ui.bookmarkName || `楼层 ${id}`).trim() || `楼层 ${id}`;
        const existing = list.find((bookmark) => Number(bookmark.id) === id);
        if (existing) existing.label = label;
        else list.push({ id, label });
        getSettings().bookmarks[chatKey()] = list;
        ui.bookmarkEditing = false;
        renderPanel();
    }
    
    function removeBookmark(index) {
        const list = currentBookmarks();
        list.splice(index, 1);
        getSettings().bookmarks[chatKey()] = list;
        renderPanel();
    }
    
    function parseTags(value) {
        return [...new Set(String(value || '')
            .split(/[,，\n]/)
            .map((tag) => tag.trim().replace(/^<\/?|\/?>(?=$)/g, ''))
            .filter((tag) => /^[A-Za-z_\u4e00-\u9fff][\w:.\-\u4e00-\u9fff]*$/.test(tag)))];
    }
    
    function extractTags(text, tags) {
        if (!tags.length) return text;
        const parts = [];
        tags.forEach((tag) => {
            const re = new RegExp(`<${escapeRegex(tag)}(?:\\s[^<>]*)?>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`, 'gi');
            for (const match of text.matchAll(re)) parts.push({ index: match.index ?? 0, content: match[1] });
        });
        return parts.sort((a, b) => a.index - b.index).map((part) => part.content).join('\n\n');
    }
    
    function collectPairedTagOptions() {
        const ignored = new Set(['a', 'b', 'blockquote', 'body', 'code', 'details', 'div', 'em', 'head', 'html', 'i', 'li', 'ol', 'p', 'pre', 'script', 'small', 'span', 'strong', 'style', 'summary', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']);
        const map = new Map();
        for (const row of iterateRows()) {
            const text = String(row.text || '');
            const openings = new Map();
            const closings = new Map();
            for (const match of text.matchAll(/<([A-Za-z_\u4e00-\u9fff][\w:.\-\u4e00-\u9fff]*)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
                if (/\/\s*>$/.test(match[0])) continue;
                const key = match[1].toLocaleLowerCase();
                if (ignored.has(key)) continue;
                const item = openings.get(key) || { name: match[1], count: 0 };
                item.count += 1;
                openings.set(key, item);
            }
            for (const match of text.matchAll(/<\/([A-Za-z_\u4e00-\u9fff][\w:.\-\u4e00-\u9fff]*)\s*>/g)) {
                const key = match[1].toLocaleLowerCase();
                closings.set(key, (closings.get(key) || 0) + 1);
            }
            openings.forEach((item, key) => {
                const paired = Math.min(item.count, closings.get(key) || 0);
                if (!paired) return;
                const total = map.get(key) || { name: item.name, count: 0 };
                total.count += paired;
                map.set(key, total);
            });
        }
        return Array.from(map.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }
    
    function scanExportTags() {
        ui.exportTagOptions = collectPairedTagOptions();
        ui.exportTagPickerOpen = true;
    }
    
    function updateSelectedTags(value, name, selected) {
        const current = parseTags(value);
        const key = String(name).toLocaleLowerCase();
        const next = current.filter((tag) => tag.toLocaleLowerCase() !== key);
        if (selected) next.push(name);
        return next.join(', ');
    }
    
    function setExportTagSelected(name, selected) {
        ui.exportTags = updateSelectedTags(ui.exportTags, name, selected);
        const input = getRoot()?.querySelector('#ctb-export-tags');
        if (input) input.value = ui.exportTags;
    }
    
    function renderTagMultiSelector({ inputId, value, placeholder, scanAction, closeAction, dataAttribute, open, options }) {
        const selected = new Set(parseTags(value).map((tag) => tag.toLocaleLowerCase()));
        const picker = open ? `<div class="ctb-export-tag-picker">
            <div class="ctb-export-tag-picker-head"><span>当前聊天中的成对标签</span><button type="button" class="ctb-button" data-action="${closeAction}">完成</button></div>
            <div class="ctb-export-tag-options">${options.length ? options.map((item) => `<label class="ctb-export-tag-option"><input type="checkbox" ${dataAttribute}="${escapeHTML(item.name)}"${selected.has(item.name.toLocaleLowerCase()) ? ' checked' : ''}><span>${escapeHTML(item.name)}</span><small>${item.count} 处</small></label>`).join('') : '<div class="ctb-hint">当前聊天没有扫描到成对标签；仍可在上方手动填写。</div>'}</div>
        </div>` : '';
        return `<div class="ctb-export-tag-input"><input class="ctb-input" id="${inputId}" placeholder="${escapeHTML(placeholder)}" value="${escapeHTML(value)}"><button type="button" class="ctb-icon-button" data-action="${scanAction}" title="扫描当前聊天中的标签" aria-label="扫描当前聊天中的标签"><i class="fa-solid fa-wand-magic-sparkles"></i></button></div>${picker}`;
    }
    
    function cleanText(text) {
        const textarea = doc.createElement('textarea');
        let output = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(br|p|div|li|h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '');
        textarea.innerHTML = output;
        output = textarea.value;
        return output.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    
    function exportRows() {
        const start = ui.exportStart === '' ? 0 : Number(ui.exportStart);
        const end = ui.exportEnd === '' ? Infinity : Number(ui.exportEnd);
        const tags = parseTags(ui.exportTags);
        const rows = [];
        for (const row of iterateRows()) {
            const id = Number(row.id);
            if (!Number.isFinite(id) || id < start || id > end || (!ui.exportIncludeUser && row.isUser)) continue;
            const extracted = extractTags(row.text, tags);
            const text = ui.exportClean ? cleanText(extracted) : extracted.trim();
            if (text) rows.push({ ...row, text });
        }
        return rows;
    }
    
    
    function exportFilename(extension) {
        const base = String(ui.exportFilename || currentChatName()).replace(/\.(txt|epub)$/i, '').trim() || '聊天导出';
        return `${base}.${extension}`;
    }
    
    function rowExportText(row) {
        const prefixes = [];
        if (ui.exportShowFloor) prefixes.push(`#${row.id}`);
        if (ui.exportShowName) prefixes.push(`【${row.name}】`);
        return `${prefixes.length ? `${prefixes.join(' ')}\n` : ''}${row.text}`;
    }
    
    function exportTXT() {
        const rows = exportRows();
        if (!rows.length) return notify('当前条件下没有可导出的内容', 'warning');
        download(rows.map(rowExportText).join('\n\n--------------------\n\n'), exportFilename('txt'));
        notify(`已导出 TXT（${rows.length} 条消息）`, 'success');
    }
    
    function loadScript(src, id) {
        if (doc.getElementById(id)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const script = doc.createElement('script');
            script.id = id;
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            doc.head.appendChild(script);
        });
    }
    
    async function exportEPUB() {
        const rows = exportRows();
        if (!rows.length) return notify('当前条件下没有可导出的内容', 'warning');
        if (!host.JSZip) {
            notify('正在加载 EPUB 打包组件…', 'info');
            try { await loadScript('https://unpkg.com/jszip@3.10.1/dist/jszip.min.js', `${PREFIX}-jszip`); }
            catch (_) { return notify('EPUB 打包组件加载失败，请检查网络后重试', 'error'); }
        }
        if (!host.JSZip) return notify('没有找到 EPUB 打包组件', 'error');
        const title = String(ui.exportFilename || currentChatName()).replace(/\.(txt|epub)$/i, '') || '聊天导出';
        const author = host.SillyTavern?.name1 || 'SillyTavern User';
        const chapters = rows.map((row, index) => ({
            title: `第 ${index + 1} 节`,
            content: rowExportText(row).split(/\n{2,}/).filter(Boolean).map((paragraph) => `<p>${escapeXml(paragraph).replace(/\n/g, '<br/>')}</p>`).join('\n'),
        }));
        try {
            const zip = new host.JSZip();
            const uuid = `urn:uuid:${Date.now()}-${Math.random().toString(36).slice(2)}`;
            zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
            zip.folder('META-INF').file('container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
            const oebps = zip.folder('OEBPS');
            oebps.file('cover.xhtml', `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(title)}</title><style>body{text-align:center;margin-top:30%;font-family:sans-serif}h1{font-size:2.2em}</style></head><body><h1>${escapeXml(title)}</h1><p>${escapeXml(author)}</p></body></html>`);
            let manifest = '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>';
            let spine = '<itemref idref="cover"/>';
            let nav = '<navPoint id="cover" playOrder="1"><navLabel><text>封面</text></navLabel><content src="cover.xhtml"/></navPoint>';
            chapters.forEach((chapter, index) => {
                const id = `chapter-${index + 1}`;
                const filename = `chapter-${index + 1}.xhtml`;
                const chapterTitle = escapeXml(chapter.title);
                oebps.file(filename, `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapterTitle}</title><style>body{font-family:serif;padding:5%;line-height:1.7}h2{text-align:center;border-bottom:1px solid #aaa;padding-bottom:.5em}p{text-indent:2em;margin:.7em 0}</style></head><body><h2>${chapterTitle}</h2>${chapter.content}</body></html>`);
                manifest += `<item id="${id}" href="${filename}" media-type="application/xhtml+xml"/>`;
                spine += `<itemref idref="${id}"/>`;
                nav += `<navPoint id="nav-${id}" playOrder="${index + 2}"><navLabel><text>${chapterTitle}</text></navLabel><content src="${filename}"/></navPoint>`;
            });
            oebps.file('content.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(title)}</dc:title><dc:creator>${escapeXml(author)}</dc:creator><dc:language>zh-CN</dc:language><dc:identifier id="BookID">${escapeXml(uuid)}</dc:identifier></metadata><manifest>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`);
            oebps.file('toc.ncx', `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escapeXml(uuid)}"/></head><docTitle><text>${escapeXml(title)}</text></docTitle><navMap>${nav}</navMap></ncx>`);
            const blob = await zip.generateAsync({ type: 'blob' });
            download(blob, exportFilename('epub'), 'application/epub+zip');
            notify(`已导出 EPUB（${rows.length} 节）`, 'success');
        } catch (error) {
            console.error('[聊天工具箱] EPUB 导出失败', error);
            notify(`EPUB 导出失败：${error.message}`, 'error');
        }
    }
    
    
    function searchScopeLabel() {
        return ({ mes: '正文 mes', name: '发言者 name', json: '完整消息 JSON（只搜索）' }[ui.scope]);
    }
    
    function renderSearchTab() {
        const bookmarkRows = currentBookmarks();
        const list = results.length ? `
            <div class="ctb-results" id="ctb-results">
                <div class="ctb-results-title">找到 ${results.length}${results.length >= MAX_RESULTS ? '+' : ''} 条结果（点击跳转）</div>
                ${results.map((result, index) => `<button type="button" class="ctb-result-row${index === currentResultIndex ? ' is-active' : ''}" data-action="jump-result" data-result-index="${index}">
                    <span class="ctb-result-meta"><span>${escapeHTML(result.name)}</span><span>#${escapeHTML(result.id)}${result.occurrence > 1 ? ` · 第 ${result.occurrence} 处` : ''}</span></span>
                    <span class="ctb-result-text"><span class="ctb-result-before">${escapeHTML(result.preview.before)}</span><mark>${escapeHTML(result.preview.match || '∅')}</mark><span class="ctb-result-after">${escapeHTML(result.preview.after)}</span></span>
                </button>`).join('')}
            </div>` : `<div class="ctb-results ctb-results-empty">${ui.query.trim() ? '没有找到匹配内容。' : '输入内容后点击“查找”，结果会显示在这里。'}</div>`;
        const canReplace = ui.scope !== 'json';
        return `
            <section class="ctb-section">
                <div class="ctb-section-title">楼层跳转 & 书签 <span>当前最高 #${maxFloor()}</span></div>
                <div class="ctb-inline">
                    <input class="ctb-input" id="ctb-floor" type="number" min="0" placeholder="楼层号" value="${escapeHTML(ui.floor)}">
                    <button type="button" class="ctb-icon-button ctb-primary" data-action="jump-floor" title="跳转"><i class="fa-solid fa-paper-plane"></i></button>
                    <button type="button" class="ctb-icon-button" data-action="open-bookmark" title="添加书签"><i class="fa-solid fa-bookmark"></i></button>
                </div>
                ${ui.bookmarkEditing ? `<div class="ctb-inline ctb-bookmark-editor"><input class="ctb-input" id="ctb-bookmark-name" placeholder="书签名称" value="${escapeHTML(ui.bookmarkName)}"><button type="button" class="ctb-button ctb-primary" data-action="save-bookmark">保存</button><button type="button" class="ctb-button" data-action="cancel-bookmark">取消</button></div>` : ''}
                ${bookmarkRows.length ? `<div class="ctb-bookmarks">${bookmarkRows.map((bookmark, index) => `<span class="ctb-bookmark"><button type="button" data-action="jump-bookmark" data-floor="${escapeHTML(bookmark.id)}">${escapeHTML(bookmark.label)} <small>#${escapeHTML(bookmark.id)}</small></button><button type="button" data-action="remove-bookmark" data-bookmark-index="${index}" title="删除书签">×</button></span>`).join('')}</div>` : ''}
            </section>
            <div class="ctb-divider"></div>
            <section class="ctb-section">
                <div class="ctb-section-title">查找与替换 <span>${searchScopeLabel()}</span></div>
                <div class="ctb-scope-row">
                    <button type="button" class="ctb-scope${ui.scope === 'mes' ? ' is-active' : ''}" data-action="set-scope" data-scope="mes">正文 mes</button>
                    <button type="button" class="ctb-scope ctb-clean-blanks" data-action="remove-extra-blank-lines" title="把正文中的三个及以上连续换行压缩成两个换行；修改只暂存，需另行保存">去除多余空行</button>
                    <button type="button" class="ctb-scope${ui.scope === 'name' ? ' is-active' : ''}" data-action="set-scope" data-scope="name">发言者 name</button>
                    <button type="button" class="ctb-scope${ui.scope === 'json' ? ' is-active' : ''}" data-action="set-scope" data-scope="json">完整消息 JSON</button>
                </div>
                <div class="ctb-inline ctb-search-row">
                    <input class="ctb-input" id="ctb-query" placeholder="输入要查找的内容…" value="${escapeHTML(ui.query)}">
                    <label class="ctb-check"><input id="ctb-regex" type="checkbox"${ui.regex ? ' checked' : ''}> 正则</label>
                    <button type="button" class="ctb-button ctb-primary" data-action="find"><i class="fa-solid fa-magnifying-glass"></i> 查找</button>
                </div>
                <div class="ctb-inline ctb-nav-row">
                    <button type="button" class="ctb-icon-button" data-action="previous-result" ${results.length ? '' : 'disabled'} title="上一条"><i class="fa-solid fa-arrow-up"></i></button>
                    <button type="button" class="ctb-icon-button" data-action="next-result" ${results.length ? '' : 'disabled'} title="下一条"><i class="fa-solid fa-arrow-down"></i></button>
                    <span class="ctb-result-counter">${results.length ? `${currentResultIndex + 1} / ${results.length}` : '0 / 0'}</span>
                    ${infoButton('search-results')}
                </div>
                ${canReplace ? `<div class="ctb-inline ctb-replace-row"><input class="ctb-input" id="ctb-replacement" placeholder="替换为（可以留空）" value="${escapeHTML(ui.replacement)}"${searchSaveState.saving ? ' disabled' : ''}><button type="button" class="ctb-button" data-action="replace-current"${searchSaveState.saving ? ' disabled' : ''}>替换当前</button><button type="button" class="ctb-button ctb-danger" data-action="replace-all"${searchSaveState.saving ? ' disabled' : ''}>整体替换</button><button type="button" class="ctb-button ctb-save" data-action="save-search-changes"${dirtyChanges.size && !searchSaveState.saving ? '' : ' disabled'}>${searchSaveState.saving ? '正在保存…' : `保存修改${dirtyChanges.size ? ` (${dirtyChanges.size})` : ''}`}</button></div>${searchSaveState.saving ? '<div class="ctb-save-progress"><span class="ctb-save-spinner"></span><span id="ctb-save-status">正在保存，请勿刷新页面。</span></div>' : dirtyChanges.size ? `<div class="ctb-staged-note">已暂存 ${dirtyChanges.size} 条消息；保存前聊天界面和聊天文件都不会变化。</div>` : ''}` : `<div class="ctb-info-line">${infoButton('json-readonly')}</div>`}
                ${lastUndo ? `<div class="ctb-undo-row"><span>可撤销：${escapeHTML(lastUndo.label)}</span>${infoButton('undo')}<button type="button" class="ctb-button" data-action="undo">撤销上次</button></div>` : ''}
            </section>
            ${list}`;
    }
    
    function renderExportTab() {
        const tagSelector = renderTagMultiSelector({
            inputId: 'ctb-export-tags',
            value: ui.exportTags,
            placeholder: '例如 content, options',
            scanAction: 'scan-export-tags',
            closeAction: 'close-export-tags',
            dataAttribute: 'data-export-tag',
            open: ui.exportTagPickerOpen,
            options: ui.exportTagOptions,
        });
        return `
            <section class="ctb-section">
                <div class="ctb-section-title">导出文件名</div>
                <input class="ctb-input" id="ctb-export-filename" placeholder="留空使用当前聊天名" value="${escapeHTML(ui.exportFilename)}">
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">导出范围 ${infoButton('export-range')}</div>
                <div class="ctb-inline"><input class="ctb-input" id="ctb-export-start" type="number" min="0" placeholder="起始楼层" value="${escapeHTML(ui.exportStart)}"><span>—</span><input class="ctb-input" id="ctb-export-end" type="number" min="0" placeholder="结束楼层" value="${escapeHTML(ui.exportEnd)}"></div>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">正文标签提取 ${infoButton('export-tags')}</div>
                ${tagSelector}
                <div class="ctb-option-grid">
                    <label class="ctb-check"><input id="ctb-export-clean" type="checkbox"${ui.exportClean ? ' checked' : ''}> 阅读模式（去标签）</label>
                    <label class="ctb-check"><input id="ctb-export-user" type="checkbox"${ui.exportIncludeUser ? ' checked' : ''}> 包含用户发言</label>
                    <label class="ctb-check"><input id="ctb-export-name" type="checkbox"${ui.exportShowName ? ' checked' : ''}> 显示发送者</label>
                    <label class="ctb-check"><input id="ctb-export-floor" type="checkbox"${ui.exportShowFloor ? ' checked' : ''}> 显示楼层号</label>
                </div>
            </section>
            <div class="ctb-export-actions"><button type="button" class="ctb-button ctb-export-txt" data-action="export-txt"><i class="fa-solid fa-file-lines"></i> 导出 TXT</button><span class="ctb-export-epub-combo"><button type="button" class="ctb-button ctb-export-epub" data-action="export-epub"><i class="fa-solid fa-book-open"></i> 导出 EPUB</button>${infoButton('export-epub', 'ctb-export-info ctb-info-on-button', true)}</span></div>`;
    }

    function handleInput(target) {
        const id = target?.id;
        if (id === 'ctb-query') ui.query = target.value;
        else if (id === 'ctb-replacement') ui.replacement = target.value;
        else if (id === 'ctb-floor') ui.floor = target.value;
        else if (id === 'ctb-bookmark-name') ui.bookmarkName = target.value;
        else if (id === 'ctb-export-filename') ui.exportFilename = target.value;
        else if (id === 'ctb-export-start') ui.exportStart = target.value;
        else if (id === 'ctb-export-end') ui.exportEnd = target.value;
        else if (id === 'ctb-export-tags') ui.exportTags = target.value;
        else return false;
        return true;
    }

    function handleChange(target) {
        const id = target?.id;
        if (id === 'ctb-regex') ui.regex = target.checked;
        else if (id === 'ctb-export-clean') ui.exportClean = target.checked;
        else if (id === 'ctb-export-user') ui.exportIncludeUser = target.checked;
        else if (id === 'ctb-export-name') ui.exportShowName = target.checked;
        else if (id === 'ctb-export-floor') ui.exportShowFloor = target.checked;
        else if (target?.dataset?.exportTag !== undefined) setExportTagSelected(target.dataset.exportTag, target.checked);
        else return false;
        return true;
    }

    async function handleAction(action, data = {}) {
        switch (action) {
            case 'jump-floor': jumpToFloor(ui.floor); return true;
            case 'open-bookmark': ui.bookmarkEditing = true; ui.bookmarkName = ui.bookmarkName || (ui.floor !== '' ? `楼层 ${ui.floor}` : ''); renderPanel(); return true;
            case 'cancel-bookmark': ui.bookmarkEditing = false; renderPanel(); return true;
            case 'save-bookmark': saveBookmark(); return true;
            case 'jump-bookmark': jumpToFloor(data.floor); return true;
            case 'remove-bookmark': removeBookmark(Number(data.bookmarkIndex)); return true;
            case 'set-scope': ui.scope = data.scope; results = []; currentResultIndex = -1; renderPanel(); return true;
            case 'remove-extra-blank-lines': stageBlankLineCleanup(); return true;
            case 'find': executeSearch(); return true;
            case 'previous-result': selectResult(currentResultIndex - 1, false); return true;
            case 'next-result': selectResult(currentResultIndex + 1, false); return true;
            case 'jump-result': selectResult(Number(data.resultIndex), true); return true;
            case 'replace-current': replaceCurrent(); return true;
            case 'replace-all': replaceAll(); return true;
            case 'save-search-changes': await saveSearchChanges(); return true;
            case 'undo': await undoLast(); return true;
            case 'export-txt': exportTXT(); return true;
            case 'export-epub': await exportEPUB(); return true;
            case 'scan-export-tags': scanExportTags(); renderPanel(); return true;
            case 'close-export-tags': ui.exportTagPickerOpen = false; renderPanel(); return true;
            default: return false;
        }
    }

    function handleKeydown(event) {
        if (event.key !== 'Enter' || event.target?.id !== 'ctb-query') return false;
        event.preventDefault();
        executeSearch();
        return true;
    }

    return {
        renderSearchTab,
        renderExportTab,
        handleInput,
        handleChange,
        handleAction,
        handleKeydown,
        confirmReplaceAll: replaceAllNow,
        rememberUndo,
        destroy: stopSearchSaveClock,
    };
}
