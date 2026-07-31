// ==UserScript==
// @name         聊天工具箱（查找、导出与 AI 改写）
// @version      0.6.0
// @description  SillyTavern 当前聊天的楼层导航、暂存式查找替换、TXT/EPUB 导出、AI 词句修改与逐段改写
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '0.6.0';
    const PREFIX = 'ctb-v020';
    const STYLE_ID = `${PREFIX}-style`;
    const ROOT_ID = `${PREFIX}-root`;
    const FLOAT_ID = `${PREFIX}-float`;
    const ENTRY_ID = `${PREFIX}-menu-entry`;
    const INSTANCE_KEY = '__ChatToolbox_v020__';
    const STORAGE_KEY = 'chat-toolbox-v020-settings';
    const MAX_RESULTS = 2000;

    let doc = document;
    let host = window;
    try {
        if (window.parent && window.parent !== window && window.parent.document) {
            doc = window.parent.document;
            host = window.parent;
        }
    } catch (_) {}

    // 让从旧版查找替换脚本直接升级的用户不会同时留下旧的悬浮图标。
    try { host.__ChatSearchReplace_v010__?.(); } catch (_) {}
    try { host[INSTANCE_KEY]?.(); } catch (_) {}

    let root = null;
    let menuObserver = null;
    let destroyed = false;
    let activeTab = 'search';
    let results = [];
    let currentResultIndex = -1;
    let infoMessage = null;
    let lastUndo = null; // 只在本页脚本内存中保留一份；不会写入聊天文件或 localStorage。
    let dirtyChanges = new Map();
    let searchSaveState = { saving: false, phase: '', startedAt: 0 };
    let searchSaveTimer = null;
    let postEditDraft = null;
    let postEditLoading = false;
    let postEditEditing = false;
    let channelLoadingId = '';
    let channelEditor = null;
    let rewriteDraft = null;
    let rewriteLoading = false;
    let rewriteReview = [];
    let rewriteApplyLoading = false;
    let rewritePromptPreview = '';
    let rewritePreviewLoading = false;
    let rewriteWorldPickerOpen = false;
    let rewriteWorldLoading = false;
    let rewriteWorldError = '';
    let rewriteWorldBooks = [];
    let rewriteWorldBook = '';
    const rewriteWorldEntryCache = new Map();
    let initAttempts = 0;
    let settings = defaults();
    const ui = {
        query: '',
        replacement: '',
        scope: 'mes',
        regex: false,
        floor: '',
        bookmarkEditing: false,
        bookmarkName: '',
        exportFilename: '',
        exportStart: '',
        exportEnd: '',
        exportTags: '',
        exportIncludeUser: false,
        exportShowName: true,
        exportShowFloor: false,
        exportClean: true,
        exportTagPickerOpen: false,
        exportTagOptions: [],
    };

    const INFO = Object.freeze({
        'search-results': '点击某条结果会跳转到对应楼层；上、下按钮只切换当前结果。',
        'json-readonly': '完整消息 JSON 用于偶尔定位 name、is_user 等结构字段。为避免破坏聊天文件，本范围只能查找。',
        'export-range': '两个楼层留空时导出全部；只填写一个时以该端为界。',
        'export-tags': '填入 content、small_theater 等标签名可只导出标签内部文字；留空则导出整条正文。',
        'export-epub': 'EPUB 会按消息生成章节。首次使用若浏览器没有打包组件，会提示加载一次。',
        'undo': '撤销只保留本次页面会话的最后一次操作，不会写进聊天文件；刷新或重开页面后失效。',
        'post-edit-api': '生成渠道、密钥和规则预设保存在酒馆的插件设置中；酒馆设置不可用时才退回浏览器本地缓存。它们不会写进任何聊天记录。',
        'post-edit-overview': '对所选 AI 楼层做一次低成本的完整词句修订，不带入其他楼层；结果先对照审核，确认后才保存。',
        'post-edit-scope': '填写 content 时，会自动读取并只替换所选楼层 <content> 与 </content> 之间的文字；标签本身和楼层其他内容都保留。',
        'rewrite-scope': '逐段改写会结合选定的历史、角色卡、用户设定和世界书理解剧情，但 API 只返回段落补丁。每段都要由你采用或忽略，未采用的段落不会变化。',
        'rewrite-context': '发送顺序固定为：角色卡 → 用户设定 → 你手动勾选的世界书具体条目 → 所选楼层之前最近 N 楼。这里只发送明确勾选的条目，不会自动混入整本世界书或其他已触发条目。',
        'rewrite-floor-tag': '楼层决定要改写哪一条 AI 回复；正文标签只截取该楼层对应标签内的文字，标签本身与其余内容不会交给模型改写。',
        'channel-main': '“跟随酒馆主接口”不需要重复填写地址和密钥；自定义渠道通过酒馆的 OpenAI 兼容代理请求。',
    });

    function defaults() {
        return {
            bookmarks: {},
            ai: {
                channels: [],
            },
            postEdit: {
                channelId: 'main',
                tag: 'content',
                floor: '',
                rules: '',
                selectedPresetId: '',
                presetName: '',
                presets: [],
            },
            rewrite: {
                channelId: 'main',
                tag: 'content',
                floor: '',
                contextFloors: 4,
                contextTags: '',
                includeCharacter: true,
                includePersona: true,
                worldEntries: [],
                globalInstruction: '',
            },
        };
    }

    function loadSettings() {
        try {
            const contextStored = getContext()?.extensionSettings?.[STORAGE_KEY];
            const localStored = contextStored && typeof contextStored === 'object'
                ? {}
                : JSON.parse(host.localStorage?.getItem(STORAGE_KEY) || '{}');
            const stored = contextStored && typeof contextStored === 'object' ? contextStored : localStored;
            const base = defaults();
            const next = {
                bookmarks: stored.bookmarks && typeof stored.bookmarks === 'object' ? stored.bookmarks : {},
                ai: {
                    ...base.ai,
                    ...(stored.ai && typeof stored.ai === 'object' ? stored.ai : {}),
                    channels: Array.isArray(stored.ai?.channels) ? stored.ai.channels : [],
                },
                postEdit: {
                    ...base.postEdit,
                    ...(stored.postEdit && typeof stored.postEdit === 'object' ? stored.postEdit : {}),
                    presets: Array.isArray(stored.postEdit?.presets) ? stored.postEdit.presets : [],
                },
                rewrite: {
                    ...base.rewrite,
                    ...(stored.rewrite && typeof stored.rewrite === 'object' ? stored.rewrite : {}),
                    worldEntries: Array.isArray(stored.rewrite?.worldEntries)
                        ? stored.rewrite.worldEntries
                            .filter((item) => item && item.world !== undefined && item.uid !== undefined)
                            .map((item) => ({ world: String(item.world), uid: String(item.uid) }))
                        : [],
                },
            };
            if (stored.rewrite?.contextFloors === undefined && stored.rewrite?.contextRounds !== undefined) {
                next.rewrite.contextFloors = Math.max(0, Number(stored.rewrite.contextRounds) || 0) * 2;
            }
            delete next.rewrite.includeWorldInfo;
            delete next.rewrite.worldBefore;
            delete next.rewrite.worldAfter;
            delete next.rewrite.worldDepth;
            if (!next.ai.channels.length && stored.postEdit?.endpoint) {
                const legacyId = `legacy-${Date.now().toString(36)}`;
                next.ai.channels.push({
                    id: legacyId,
                    name: '原 API 设置',
                    url: String(stored.postEdit.endpoint || ''),
                    key: String(stored.postEdit.apiKey || ''),
                    model: String(stored.postEdit.model || ''),
                    models: [],
                    temperature: Number(stored.postEdit.temperature) || 0.2,
                    maxTokens: 65535,
                    timeoutSec: 120,
                });
                next.postEdit.channelId = legacyId;
            }
            return next;
        } catch (_) {
            return defaults();
        }
    }

    function saveSettings() {
        let savedToExtension = false;
        try {
            const context = getContext();
            if (context.extensionSettings && typeof context.extensionSettings === 'object') {
                context.extensionSettings[STORAGE_KEY] = JSON.parse(JSON.stringify(settings));
                context.saveSettingsDebounced?.();
                savedToExtension = true;
            }
        } catch (_) {}
        if (!savedToExtension) {
            try { host.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
        }
    }

    function notify(message, level = 'info') {
        const toastr = host.toastr;
        if (toastr && typeof toastr[level] === 'function') toastr[level](message);
        else console.log(`[聊天工具箱] ${message}`);
    }

    function infoButton(key, extraClass = '', inline = false) {
        const className = `ctb-info${extraClass ? ` ${extraClass}` : ''}`;
        const expanded = infoMessage === key;
        if (inline) {
            return `<span class="${className}" data-action="show-info" data-info-key="${key}" role="button" tabindex="0" aria-expanded="${expanded}" aria-label="${expanded ? '关闭说明' : '显示说明'}" title="${expanded ? '关闭说明' : '显示说明'}"><span aria-hidden="true">i</span></span>`;
        }
        return `<button type="button" class="${className}" data-action="show-info" data-info-key="${key}" aria-expanded="${expanded}" aria-label="${expanded ? '关闭说明' : '显示说明'}" title="${expanded ? '关闭说明' : '显示说明'}"><span aria-hidden="true">i</span></button>`;
    }

    function renderInfoPopup() {
        if (!infoMessage || !INFO[infoMessage]) return '';
        return `<div class="ctb-info-popup" role="status"><span>${escapeHTML(INFO[infoMessage])}</span><button type="button" data-action="close-info" aria-label="关闭说明">×</button></div>`;
    }

    function escapeHTML(value) {
        const node = doc.createElement('div');
        node.textContent = String(value ?? '');
        return node.innerHTML;
    }

    function escapeXml(value) {
        return String(value ?? '').replace(/[<>&'\"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char]));
    }

    function escapeRegex(value) {
        return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function escapeCss(value) {
        if (host.CSS?.escape) return host.CSS.escape(String(value));
        return String(value).replace(/["\\]/g, '\\$&');
    }

    function getContext() {
        return host.SillyTavern?.getContext?.() || {};
    }

    function getChat() {
        const context = getContext();
        if (Array.isArray(context.chat)) return context.chat;
        if (Array.isArray(host.SillyTavern?.chat)) return host.SillyTavern.chat;
        return [];
    }

    function messageId(message, index) {
        const value = message?.message_id ?? message?.mes_id ?? message?.id;
        if (value !== undefined && value !== null && value !== '') {
            const number = Number(value);
            return Number.isFinite(number) ? number : String(value);
        }
        return index;
    }

    function messageText(message) {
        return String(message?.mes ?? message?.message ?? '');
    }

    function setMessageText(message, value) {
        if (!message || typeof message !== 'object') return;
        const previous = messageText(message);
        if ('mes' in message || !('message' in message)) message.mes = value;
        if ('message' in message) message.message = value;
        if (typeof message.extra?.display_text === 'string' && message.extra.display_text === previous) {
            message.extra.display_text = value;
        }
        const swipeId = Number(message.swipe_id);
        if (Array.isArray(message.swipes) && Number.isInteger(swipeId) && swipeId >= 0 && swipeId < message.swipes.length) {
            message.swipes[swipeId] = value;
        }
    }

    function normalizeBlankLines(value) {
        return String(value ?? '')
            .replace(/\r\n?/g, '\n')
            .replace(/[ \t]+\n/g, '\n')
            // 统一为“最多一个空行”：连续三个及以上换行（中间允许有空格）压成两个。
            .replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n');
    }

    function collapseExtraBlankLines(value) {
        return String(value ?? '')
            .replace(/\r\n?/g, '\n')
            .replace(/(?:\n[ \t]*){3,}/g, '\n\n');
    }

    function messageName(message) {
        if (message?.name !== undefined && message?.name !== null && String(message.name)) return String(message.name);
        return isUserMessage(message) ? (host.SillyTavern?.name1 || '用户') : (host.SillyTavern?.name2 || '角色');
    }

    function isUserMessage(message) {
        return Boolean(message?.is_user || message?.role === 'user');
    }

    function isAssistantMessage(message) {
        return Boolean(message) && !isUserMessage(message) && !message.is_system && message.role !== 'system';
    }

    function currentChatName() {
        const context = getContext();
        const raw = context.chatMetadata?.title || host.SillyTavern?.chatMetadata?.title || context.chatId || host.SillyTavern?.getCurrentChatId?.() || '当前聊天';
        return String(raw).replace(/\.(jsonl?|txt)$/i, '').replace(/[\\/:*?"<>|]/g, '').trim() || '当前聊天';
    }

    function chatKey() {
        const context = getContext();
        return String(context.chatId || context.chatMetadata?.chat_id || context.chatMetadata?.title || currentChatName());
    }

    function getRows() {
        return getChat().map((raw, rawIndex) => ({
            raw,
            rawIndex,
            id: messageId(raw, rawIndex),
            name: messageName(raw),
            text: messageText(raw),
            isUser: isUserMessage(raw),
        }));
    }

    function maxFloor() {
        const rows = getRows();
        if (!rows.length) return 0;
        return rows.reduce((max, row) => Math.max(max, Number(row.id) || row.rawIndex), 0);
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
            for (const row of getRows()) {
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
        const row = root?.querySelector(`[data-result-index="${currentResultIndex}"]`);
        row?.scrollIntoView?.({ block: 'nearest' });
        if (jump) {
            jumpToFloor(selectedResult());
            closePanel();
        }
    }

    function jumpToFloor(resultOrFloor) {
        const result = typeof resultOrFloor === 'object' ? resultOrFloor : null;
        const floor = result ? result.id : resultOrFloor;
        if (floor === '' || floor === undefined || floor === null) return;…29701 tokens truncated…el{color:#74777c;font-size:10px;} #${ROOT_ID} .ctb-context-tags{margin-top:6px;} #${ROOT_ID} .ctb-rewrite-global{height:62px;margin-top:6px;}
            #${ROOT_ID} .ctb-primary-soft{border-color:#91aa98;background:#e0e9e3;color:#4d6755;} #${ROOT_ID} .ctb-world-picker-summary{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px;} #${ROOT_ID} .ctb-world-picker-summary .ctb-button:first-child{flex:1;justify-content:space-between;} #${ROOT_ID} .ctb-world-picker-summary .ctb-button span{color:#7a817c;font-size:10px;font-weight:400;}
            #${ROOT_ID} .ctb-world-selected-summary{display:flex;gap:4px;flex-wrap:wrap;margin-top:5px;} #${ROOT_ID} .ctb-world-selected-summary span{max-width:100%;overflow:hidden;padding:3px 6px;border:1px solid #c9d2cc;border-radius:3px;background:#e5ebe7;color:#5c6860;font-size:10px;text-overflow:ellipsis;white-space:nowrap;}
            #${ROOT_ID} .ctb-world-picker{margin-top:6px;overflow:hidden;border:1px solid #cbd0cc;border-radius:3px;background:#e9ebeb;} #${ROOT_ID} .ctb-world-book-row{padding:6px;border-bottom:1px solid #cfd3d0;} #${ROOT_ID} .ctb-world-book-row select{flex:1;} #${ROOT_ID} .ctb-world-bulk{justify-content:flex-end;padding:5px 6px;border-bottom:1px solid #d3d6d4;color:#6d716f;font-size:10px;} #${ROOT_ID} .ctb-world-bulk>span{margin-right:auto;}
            #${ROOT_ID} .ctb-world-entry-list{max-height:230px;overflow:auto;} #${ROOT_ID} .ctb-world-entry{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:start;gap:6px;padding:7px;border-bottom:1px solid #d4d7d5;color:#555b57;cursor:pointer;} #${ROOT_ID} .ctb-world-entry:last-child{border-bottom:0;} #${ROOT_ID} .ctb-world-entry.is-selected{background:#dfe8e1;} #${ROOT_ID} .ctb-world-entry-main{display:flex;min-width:0;flex-direction:column;gap:2px;} #${ROOT_ID} .ctb-world-entry-main strong{overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-world-entry-main small{overflow:hidden;color:#858a87;font-size:9px;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-world-entry-meta{color:#8a8d8b;font-size:9px;white-space:nowrap;} #${ROOT_ID} .ctb-world-empty{display:flex;align-items:center;justify-content:center;gap:7px;min-height:70px;padding:10px;color:#858a87;font-size:10px;} #${ROOT_ID} .ctb-world-error{color:#985957;}
            #${ROOT_ID} .ctb-rewrite-list{max-height:280px;overflow:auto;border:1px solid #cfd1d5;border-radius:3px;background:#ededf0;}
            #${ROOT_ID} .ctb-rewrite-paragraph{display:grid;grid-template-columns:42px minmax(0,1fr);gap:5px 8px;padding:7px 8px;border-bottom:1px solid #d5d6da;} #${ROOT_ID} .ctb-rewrite-paragraph:last-child{border-bottom:0;}
            #${ROOT_ID} .ctb-rewrite-select{grid-row:1/3;display:flex;align-items:flex-start;gap:4px;color:#6b6e73;font-size:10px;font-weight:700;} #${ROOT_ID} .ctb-rewrite-source{min-width:0;color:#4f5257;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word;}
            #${ROOT_ID} .ctb-rewrite-generate,#${ROOT_ID} .ctb-rewrite-final{justify-content:flex-end;flex-wrap:wrap;margin-top:7px;}
            #${ROOT_ID} .ctb-rewrite-reviews{display:grid;gap:6px;} #${ROOT_ID} .ctb-rewrite-review{overflow:hidden;border:1px solid #cfd1d5;border-radius:3px;background:#ececef;} #${ROOT_ID} .ctb-rewrite-review.is-accepted{border-color:#92b19a;} #${ROOT_ID} .ctb-rewrite-review.is-rejected{opacity:.68;}
            #${ROOT_ID} .ctb-rewrite-review-title{display:flex;justify-content:space-between;padding:5px 7px;border-bottom:1px solid #d3d5d8;color:#65696e;font-size:10px;font-weight:700;} #${ROOT_ID} .ctb-rewrite-compare{display:grid;grid-template-columns:1fr 1fr;} #${ROOT_ID} .ctb-rewrite-compare>div{min-width:0;padding:7px;} #${ROOT_ID} .ctb-rewrite-compare>div+div{border-left:1px solid #d3d5d8;background:#e5ebe7;} #${ROOT_ID} .ctb-rewrite-compare small{color:#85898e;} #${ROOT_ID} .ctb-rewrite-compare p{margin:3px 0 0;color:#4e5156;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;} #${ROOT_ID} .ctb-rewrite-review>.ctb-inline{padding:0 7px 7px;}
            #${ROOT_ID} .ctb-prompt-preview{padding:7px;border:1px solid #cfd3d6;border-radius:3px;background:#ececef;} #${ROOT_ID} .ctb-prompt-preview .ctb-section-title{justify-content:space-between;} #${ROOT_ID} .ctb-prompt-preview pre{max-height:320px;overflow:auto;margin:0;padding:8px;background:#f3f3f5;color:#50545a;font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word;}
            @media (max-width:560px){#${ROOT_ID} .ctb-tabs{padding:0 5px;}#${ROOT_ID} .ctb-tab{font-size:11px;}#${ROOT_ID} .ctb-post-grid,#${ROOT_ID} .ctb-post-preview,#${ROOT_ID} .ctb-channel-grid,#${ROOT_ID} .ctb-rewrite-compare{grid-template-columns:1fr;}#${ROOT_ID} .ctb-post-preview>.ctb-section-title{grid-column:auto;}#${ROOT_ID} .ctb-channel-grid>*{grid-column:1!important;}#${ROOT_ID} .ctb-preset-row{flex-wrap:wrap;}#${ROOT_ID} .ctb-preset-row select{max-width:none;flex-basis:100%;}#${ROOT_ID} .ctb-rewrite-compare>div+div{border-left:0;border-top:1px solid #d3d5d8;}#${ROOT_ID} .ctb-export-tag-options{grid-template-columns:1fr;}}
        `;
        doc.head.appendChild(style);

        root = doc.createElement('div');
        root.id = ROOT_ID;
        root.hidden = true;
        root.addEventListener('click', (event) => {
            if (event.target === root) closePanel();
        });
        root.addEventListener('input', handleInput);
        root.addEventListener('change', handleChange);
        root.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && event.target?.id === 'ctb-query') {
                event.preventDefault();
                executeSearch();
            }
        });
        root.addEventListener('click', (event) => {
            const button = event.target.closest('[data-action]');
            if (button) handleAction(button.dataset.action, button.dataset, event);
        });
        doc.body.appendChild(root);
    }

    function handleInput(event) {
        const target = event.target;
        if (!target) return;
        const id = target.id;
        if (id === 'ctb-query') ui.query = target.value;
        else if (id === 'ctb-replacement') ui.replacement = target.value;
        else if (id === 'ctb-floor') ui.floor = target.value;
        else if (id === 'ctb-bookmark-name') ui.bookmarkName = target.value;
        else if (id === 'ctb-export-filename') ui.exportFilename = target.value;
        else if (id === 'ctb-export-start') ui.exportStart = target.value;
        else if (id === 'ctb-export-end') ui.exportEnd = target.value;
        else if (id === 'ctb-export-tags') ui.exportTags = target.value;
        else if (id === 'ctb-post-edit-floor') settings.postEdit.floor = target.value;
        else if (id === 'ctb-post-edit-tag') settings.postEdit.tag = target.value;
        else if (id === 'ctb-post-edit-rules') settings.postEdit.rules = target.value;
        else if (id === 'ctb-post-edit-preset-name') settings.postEdit.presetName = target.value;
        else if (id === 'ctb-post-edit-revised') {
            if (postEditDraft) postEditDraft.revisedContent = target.value;
            return;
        }
        else if (id === 'ctb-rewrite-floor') settings.rewrite.floor = target.value;
        else if (id === 'ctb-rewrite-tag') settings.rewrite.tag = target.value;
        else if (id === 'ctb-rewrite-context-floors') settings.rewrite.contextFloors = target.value;
        else if (id === 'ctb-rewrite-context-tags') settings.rewrite.contextTags = target.value;
        else if (id === 'ctb-rewrite-global') settings.rewrite.globalInstruction = target.value;
        else if (target.dataset.channelId) {
            const channel = channelEditor?.draft?.id === target.dataset.channelId ? channelEditor.draft : null;
            if (!channel) return;
            if (id.endsWith('-channel-name')) channel.name = target.value;
            else if (id.endsWith('-channel-url')) channel.url = target.value;
            else if (id.endsWith('-channel-key')) channel.key = target.value;
            else if (id.endsWith('-channel-temperature')) channel.temperature = target.value;
            else if (id.endsWith('-channel-tokens')) channel.maxTokens = target.value;
            return;
        } else if (target.dataset.paragraphIndex !== undefined && target.dataset.action === 'rewrite-instruction') {
            const paragraph = rewriteDraft?.paragraphs?.[Number(target.dataset.paragraphIndex)];
            if (paragraph) paragraph.instruction = target.value;
            return;
        }
        if (id?.startsWith('ctb-post-edit-') || id?.startsWith('ctb-rewrite-')) saveSettings();
    }

    async function handleChange(event) {
        const target = event.target;
        if (!target) return;
        const id = target.id;
        if (id === 'ctb-regex') ui.regex = target.checked;
        else if (id === 'ctb-export-clean') ui.exportClean = target.checked;
        else if (id === 'ctb-export-user') ui.exportIncludeUser = target.checked;
        else if (id === 'ctb-export-name') ui.exportShowName = target.checked;
        else if (id === 'ctb-export-floor') ui.exportShowFloor = target.checked;
        else if (target.dataset.exportTag !== undefined) {
            setExportTagSelected(target.dataset.exportTag, target.checked);
            return;
        }
        else if (target.dataset.worldEntryUid !== undefined) {
            setRewriteWorldEntrySelected(target.dataset.worldName, target.dataset.worldEntryUid, target.checked);
            return;
        }
        else if (id === 'ctb-rewrite-world-book') {
            await chooseRewriteWorldBook(target.value);
            return;
        }
        else if (id === 'ctb-postEdit-channel') {
            settings.postEdit.channelId = target.value;
            channelEditor = null;
            saveSettings();
            renderPanel();
        } else if (id === 'ctb-rewrite-channel') {
            settings.rewrite.channelId = target.value;
            channelEditor = null;
            saveSettings();
            renderPanel();
        } else if (id === 'ctb-post-edit-preset') {
            settings.postEdit.selectedPresetId = target.value;
            const preset = settings.postEdit.presets.find((item) => item.id === target.value);
            if (preset) {
                settings.postEdit.presetName = preset.name;
                settings.postEdit.rules = preset.rules;
            } else {
                settings.postEdit.presetName = '';
            }
            saveSettings();
            renderPanel();
        } else if (id === 'ctb-rewrite-character') {
            settings.rewrite.includeCharacter = target.checked;
            saveSettings();
        } else if (id === 'ctb-rewrite-persona') {
            settings.rewrite.includePersona = target.checked;
            saveSettings();
        } else if (target.dataset.channelId && id.endsWith('-channel-model')) {
            const channel = channelEditor?.draft?.id === target.dataset.channelId ? channelEditor.draft : null;
            if (channel) channel.model = target.value;
        } else if (target.dataset.action === 'rewrite-selected') {
            const paragraph = rewriteDraft?.paragraphs?.[Number(target.dataset.paragraphIndex)];
            if (paragraph) paragraph.selected = target.checked;
        }
    }

    async function handleAction(action, data) {
        switch (action) {
            case 'close': return closePanel();
            case 'show-info': infoMessage = infoMessage === data.infoKey ? null : data.infoKey; return renderPanel();
            case 'close-info': infoMessage = null; return renderPanel();
            case 'tab': infoMessage = null; activeTab = data.tab; return renderPanel();
            case 'jump-floor': return jumpToFloor(ui.floor);
            case 'open-bookmark': ui.bookmarkEditing = true; ui.bookmarkName = ui.bookmarkName || (ui.floor !== '' ? `楼层 ${ui.floor}` : ''); return renderPanel();
            case 'cancel-bookmark': ui.bookmarkEditing = false; return renderPanel();
            case 'save-bookmark': return saveBookmark();
            case 'jump-bookmark': return jumpToFloor(data.floor);
            case 'remove-bookmark': return removeBookmark(Number(data.bookmarkIndex));
            case 'set-scope': ui.scope = data.scope; results = []; currentResultIndex = -1; return renderPanel();
            case 'remove-extra-blank-lines': return stageBlankLineCleanup();
            case 'find': return executeSearch();
            case 'previous-result': return selectResult(currentResultIndex - 1, false);
            case 'next-result': return selectResult(currentResultIndex + 1, false);
            case 'jump-result': return selectResult(Number(data.resultIndex), true);
            case 'replace-current': return replaceCurrent();
            case 'replace-all': return replaceAll();
            case 'save-search-changes': return saveSearchChanges();
            case 'undo': return undoLast();
            case 'export-txt': return exportTXT();
            case 'export-epub': return exportEPUB();
            case 'scan-export-tags': scanExportTags(); return renderPanel();
            case 'close-export-tags': ui.exportTagPickerOpen = false; return renderPanel();
            case 'add-channel': return beginNewChannel(data.feature);
            case 'edit-channel': return beginEditChannel(data.feature, data.channelId);
            case 'save-channel': return saveChannelEditor();
            case 'cancel-channel': return cancelChannelEditor();
            case 'delete-channel': {
                const index = settings.ai.channels.findIndex((channel) => channel.id === data.channelId);
                if (index < 0 || !host.confirm('确定删除这个生成渠道吗？词句修改和逐段改写中引用它的设置都会改为跟随酒馆主接口。')) return;
                settings.ai.channels.splice(index, 1);
                if (settings.postEdit.channelId === data.channelId) settings.postEdit.channelId = 'main';
                if (settings.rewrite.channelId === data.channelId) settings.rewrite.channelId = 'main';
                channelEditor = null;
                saveSettings();
                return renderPanel();
            }
            case 'fetch-models': return fetchChannelModels(data.channelId);
            case 'save-post-preset': return savePostEditPreset();
            case 'delete-post-preset': return deletePostEditPreset();
            case 'prepare-post-edit': return preparePostEditFloor();
            case 'run-post-edit': return runPostEdit();
            case 'apply-post-edit': return applyPostEdit();
            case 'toggle-post-edit-editor': postEditEditing = !postEditEditing; return renderPanel();
            case 'clear-post-edit': postEditDraft = null; postEditEditing = false; return renderPanel();
            case 'toggle-rewrite-world-picker':
                rewriteWorldPickerOpen = !rewriteWorldPickerOpen;
                if (rewriteWorldPickerOpen) return loadRewriteWorldBooks();
                return renderPanel();
            case 'refresh-rewrite-world-books': return loadRewriteWorldBooks({ force: true });
            case 'close-rewrite-world-picker': rewriteWorldPickerOpen = false; return renderPanel();
            case 'clear-rewrite-world-selection':
                settings.rewrite.worldEntries = [];
                saveSettings();
                return renderPanel();
            case 'select-rewrite-world-book-all': return setCurrentWorldBookSelection(true);
            case 'clear-rewrite-world-book': return setCurrentWorldBookSelection(false);
            case 'prepare-rewrite': return prepareRewriteFloor();
            case 'preview-rewrite-prompt': return previewRewritePrompt();
            case 'close-rewrite-preview': rewritePromptPreview = ''; return renderPanel();
            case 'run-rewrite': return runRewrite();
            case 'rewrite-select-all': {
                rewriteDraft?.paragraphs?.forEach((paragraph) => { paragraph.selected = data.selected === 'true'; });
                return renderPanel();
            }
            case 'rewrite-decision': {
                const review = rewriteReview[Number(data.reviewIndex)];
                if (review) review.decision = data.decision;
                return renderPanel();
            }
            case 'rewrite-all': rewriteReview.forEach((review) => { review.decision = data.decision; }); return renderPanel();
            case 'apply-rewrite': return applyRewrite();
            default: return undefined;
        }
    }

    function findMenuTarget() {
        const direct = doc.querySelector('#option_manage_chat_files, #option_select_chat_file, #option_select_chat');
        if (direct) return direct;
        const candidates = Array.from(doc.querySelectorAll('a, button, .list-group-item, .option_select'));
        return candidates.find((node) => {
            const text = String(node.textContent || '').trim();
            return /manage\s+chat\s+files|管理聊天文件/i.test(text);
        }) || null;
    }

    function findMenuRoot() {
        const selectors = ['#options', '#options_menu', '#options-menu', '#options-content', '#options-content-wrapper', '.options-content', '#option_list'];
        for (const selector of selectors) {
            const menu = doc.querySelector(selector);
            if (menu) return menu;
        }
        return null;
    }

    function injectMenuEntry() {
        if (destroyed || !doc.body) return false;
        const menu = doc.querySelector('#options .options-content') || findMenuRoot();
        if (!menu) return false;
        let entry = doc.getElementById(ENTRY_ID);
        if (!entry) {
            entry = doc.createElement('a');
            entry.id = ENTRY_ID;
            entry.href = '#';
            entry.className = 'list-group-item';
            entry.innerHTML = '<i class="fa-lg fa-solid fa-toolbox"></i><span>聊天工具箱</span>';
            entry.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); showPanel('search'); });
        }
        if (menu.lastElementChild !== entry) menu.appendChild(entry);
        return true;
    }

    function registerSlashCommand() {
        try {
            const parser = host.SillyTavern?.SlashCommandParser;
            const command = host.SillyTavern?.SlashCommand;
            if (parser && command?.fromProps) parser.addCommandObject(command.fromProps({ name: 'chat-toolbox', callback: () => showPanel('search'), helpString: '打开聊天工具箱' }));
        } catch (_) {}
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        stopSearchSaveClock();
        menuObserver?.disconnect();
        doc.getElementById(STYLE_ID)?.remove();
        doc.getElementById(ROOT_ID)?.remove();
        doc.getElementById(FLOAT_ID)?.remove();
        doc.getElementById(ENTRY_ID)?.remove();
        if (host[INSTANCE_KEY] === destroy) delete host[INSTANCE_KEY];
    }

    function init() {
        if (!doc.body) return host.setTimeout(init, 80);
        const context = getContext();
        if ((!context || !context.extensionSettings) && initAttempts++ < 30) return host.setTimeout(init, 100);
        settings = loadSettings();
        saveSettings();
        createUI();
        injectMenuEntry();
        host.setTimeout(injectMenuEntry, 800);
        host.setTimeout(injectMenuEntry, 2200);
        menuObserver = new MutationObserver(() => injectMenuEntry());
        menuObserver.observe(doc.body, { childList: true, subtree: true });
        registerSlashCommand();
        host.addEventListener('pagehide', destroy, { once: true });
        host.addEventListener('unload', destroy, { once: true });
        host[INSTANCE_KEY] = destroy;
        console.info(`[聊天工具箱] v${VERSION} 已加载`);
    }

    init();
})();

