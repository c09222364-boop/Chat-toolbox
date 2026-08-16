const IF_BRANCH_META_KEY = 'chat_toolbox_if_branch';
const IF_BRANCH_MESSAGE_KEY = 'chat_toolbox_if_branch_id';

export function createIfBranchModule(deps) {
    const {
        host,
        doc,
        getSettings,
        getContext,
        getChat,
        currentCharacterCard,
        currentChatName,
        messageId,
        messageText,
        messageName,
        isUserMessage,
        deepClone,
        normalizeIfPrompt,
        normalizeIfFavorite,
        saveSettings,
        saveChat,
        notify,
        download,
        escapeHTML,
        infoButton,
        requestDialog,
        renderPanel,
        isPanelTabActive,
        isDestroyed,
    } = deps;

    let ifBranchLibraryView = 'prompts';
    let ifPromptEditor = null;
    let ifBranchReader = null;
    let ifBranchEventBindings = [];
    let ifBranchStarting = false;

    function ifPrompts() {
        return Array.isArray(getSettings().ifBranch?.prompts) ? getSettings().ifBranch.prompts : [];
    }
    
    function ifFavorites() {
        return Array.isArray(getSettings().ifBranch?.favorites) ? getSettings().ifBranch.favorites : [];
    }
    
    function ifPromptById(id) {
        return ifPrompts().find((item) => item.id === String(id || '')) || null;
    }
    
    function ifFavoriteById(id) {
        return ifFavorites().find((item) => item.id === String(id || '')) || null;
    }
    
    function ifBranchCharacterName() {
        const card = currentCharacterCard();
        return String(card?.name || host.SillyTavern?.name2 || '角色');
    }
    
    function ifBranchCharacterCount(value) {
        return Array.from(String(value || '').replace(/\s/g, '')).length;
    }
    
    function ifBranchMessageRole(message) {
        if (isUserMessage(message)) return 'user';
        if (message?.is_system || message?.role === 'system') return 'system';
        return 'assistant';
    }
    
    function ifBranchStoredMessage(message) {
        return {
            role: ifBranchMessageRole(message),
            name: messageName(message),
            text: messageText(message),
        };
    }
    
    function ifBranchMetadata() {
        const metadata = getContext().chatMetadata;
        const branch = metadata?.[IF_BRANCH_META_KEY];
        return branch && typeof branch === 'object' ? branch : null;
    }
    
    function replaceObjectContents(target, source) {
        if (!target || typeof target !== 'object') return;
        Object.keys(target).forEach((key) => delete target[key]);
        Object.assign(target, deepClone(source && typeof source === 'object' ? source : {}));
    }
    
    function ifBranchStartIndex(branch, chat = getChat()) {
        if (!branch) return -1;
        const exact = chat.findIndex((message) => message?.extra?.[IF_BRANCH_MESSAGE_KEY] === branch.id
            && message?.extra?.chat_toolbox_if_branch_start === true);
        if (exact >= 0) return exact;
        const tagged = chat.findIndex((message) => message?.extra?.[IF_BRANCH_MESSAGE_KEY] === branch.id);
        if (tagged >= 0) return tagged;
        const stored = Number(branch.startIndex);
        return Number.isInteger(stored) && stored >= 0 && stored <= chat.length ? stored : -1;
    }
    
    function currentIfBranchSnapshot() {
        const branch = ifBranchMetadata();
        if (!branch) return null;
        const chat = getChat();
        const startIndex = ifBranchStartIndex(branch, chat);
        const messages = startIndex >= 0 ? chat.slice(startIndex) : [];
        return {
            branch,
            startIndex,
            messages,
            layers: messages.length,
            characters: messages.reduce((sum, message) => sum + ifBranchCharacterCount(messageText(message)), 0),
        };
    }
    
    function isHostGenerationBusy() {
        const stop = doc.querySelector('#mes_stop,.mes_stop');
        if (!stop) return false;
        try {
            const style = host.getComputedStyle(stop);
            return !stop.hidden && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && stop.getClientRects().length > 0;
        } catch (_) {
            return !stop.hidden;
        }
    }
    
    function branchWait(milliseconds) {
        return new Promise((resolve) => host.setTimeout(resolve, milliseconds));
    }
    
    async function saveIfBranchMetadata() {
        const context = getContext();
        if (typeof context.saveMetadata === 'function') await context.saveMetadata();
        else context.saveMetadataDebounced?.();
    }
    
    function setHostChatInput(value, { focus = true } = {}) {
        const input = doc.querySelector('#send_textarea');
        if (!input) return null;
        input.value = String(value || '');
        input.dispatchEvent(new host.Event('input', { bubbles: true }));
        input.dispatchEvent(new host.Event('change', { bubbles: true }));
        if (focus) input.focus?.();
        return input;
    }
    
    function beginNewIfPrompt() {
        ifPromptEditor = {
            isNew: true,
            draft: { id: '', name: '', tags: '', content: '' },
        };
        renderPanel();
    }
    
    function beginEditIfPrompt(id) {
        const prompt = ifPromptById(id);
        if (!prompt) return notify('找不到这条 IF 开场词', 'error');
        ifPromptEditor = { isNew: false, draft: deepClone(prompt) };
        renderPanel();
    }
    
    function cancelIfPromptEditor() {
        ifPromptEditor = null;
        renderPanel();
    }
    
    function saveIfPromptEditor() {
        const draft = normalizeIfPrompt(ifPromptEditor?.draft);
        if (!draft) return notify('请填写开场词名称和完整指令', 'warning');
        const prompts = ifPrompts();
        if (ifPromptEditor.isNew) {
            prompts.unshift(draft);
        } else {
            const index = prompts.findIndex((item) => item.id === ifPromptEditor.draft.id);
            if (index < 0) return notify('原开场词已经不存在', 'error');
            draft.id = ifPromptEditor.draft.id;
            prompts[index] = draft;
        }
        ifPromptEditor = null;
        saveSettings();
        renderPanel();
        notify('IF 开场词已保存', 'success');
    }
    
    async function deleteIfPrompt(id) {
        const prompt = ifPromptById(id);
        if (!prompt) return;
        const confirmed = await requestDialog({
            title: '删除 IF 开场词',
            message: `确定删除开场词“${prompt.name}”吗？`,
            confirmLabel: '删除',
            danger: true,
        });
        if (!confirmed) return;
        getSettings().ifBranch.prompts = ifPrompts().filter((item) => item.id !== prompt.id);
        if (ifPromptEditor?.draft?.id === prompt.id) ifPromptEditor = null;
        saveSettings();
        renderPanel();
    }
    
    function fillIfPrompt(id) {
        const prompt = ifPromptById(id);
        if (!prompt) return notify('找不到这条 IF 开场词', 'error');
        if (!setHostChatInput(prompt.content)) return notify('当前页面没有找到酒馆聊天输入框', 'error');
        notify('开场词已填入酒馆聊天框，你可以继续修改后自行发送', 'success');
    }
    
    function snapshotIfBranchCheckpoint() {
        const context = getContext();
        const metadata = deepClone(context.chatMetadata || {});
        delete metadata[IF_BRANCH_META_KEY];
        return {
            chatMetadata: metadata,
            globalVariables: deepClone(context.extensionSettings?.variables?.global || {}),
        };
    }
    
    async function restoreIfBranchCheckpoint(branch) {
        const context = getContext();
        const checkpoint = branch?.checkpoint;
        if (!checkpoint || typeof checkpoint !== 'object') throw new Error('支线缺少开始前的状态快照，无法安全还原变量');
        if (!context.chatMetadata || typeof context.chatMetadata !== 'object') throw new Error('当前聊天元数据不可用');
        replaceObjectContents(context.chatMetadata, checkpoint.chatMetadata || {});
        if (context.extensionSettings && typeof context.extensionSettings === 'object') {
            if (!context.extensionSettings.variables || typeof context.extensionSettings.variables !== 'object') context.extensionSettings.variables = {};
            if (!context.extensionSettings.variables.global || typeof context.extensionSettings.variables.global !== 'object') context.extensionSettings.variables.global = {};
            replaceObjectContents(context.extensionSettings.variables.global, checkpoint.globalVariables || {});
            context.saveSettingsDebounced?.();
        }
        await saveIfBranchMetadata();
    }
    
    async function startIfBranch(promptId) {
        if (ifBranchStarting) return;
        if (ifBranchMetadata()) return notify('当前聊天已有一条进行中的 IF 支线，请先处理它', 'warning');
        if (isHostGenerationBusy()) return notify('酒馆正在生成回复，请等待本轮完成后再开始 IF 支线', 'warning');
        const prompt = ifPromptById(promptId);
        if (!prompt) return notify('找不到这条 IF 开场词', 'error');
        const input = doc.querySelector('#send_textarea');
        const send = doc.querySelector('#send_but');
        if (!input || !send) return notify('当前页面没有找到酒馆聊天输入框或发送按钮', 'error');
        if (String(input.value || '').trim()) {
            const confirmed = await requestDialog({
                title: '替换聊天框内容',
                message: '酒馆聊天框里已有文字。开始支线会用所选开场词替换它，确定继续吗？',
                confirmLabel: '替换并开始',
            });
            if (!confirmed) return;
        }
    
        ifBranchStarting = true;
        const context = getContext();
        const chat = getChat();
        const baseLength = chat.length;
        const branch = {
            version: 1,
            id: `if-branch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            promptId: prompt.id,
            title: prompt.name,
            tags: prompt.tags || '',
            character: ifBranchCharacterName(),
            chat: currentChatName(),
            startedAt: new Date().toISOString(),
            startIndex: baseLength,
            checkpoint: snapshotIfBranchCheckpoint(),
        };
    
        try {
            context.chatMetadata[IF_BRANCH_META_KEY] = branch;
            await saveIfBranchMetadata();
            setHostChatInput(prompt.content, { focus: false });
            send.click();
    
            let firstIndex = -1;
            for (let attempt = 0; attempt < 50; attempt += 1) {
                const current = getChat();
                if (current.length > baseLength) {
                    firstIndex = current.findIndex((message, index) => index >= baseLength && isUserMessage(message));
                    if (firstIndex >= 0) break;
                }
                await branchWait(100);
            }
            if (firstIndex < 0) throw new Error('酒馆没有建立用户楼层；开场词仍保留在聊天框中，可以检查后重试');
            const first = getChat()[firstIndex];
            if (!first.extra || typeof first.extra !== 'object') first.extra = {};
            first.extra[IF_BRANCH_MESSAGE_KEY] = branch.id;
            first.extra.chat_toolbox_if_branch_start = true;
            branch.startIndex = firstIndex;
            await saveIfBranchMetadata();
            await saveChat();
            renderPanel();
            notify('IF 支线已开始；接下来直接使用酒馆聊天框继续多轮对话', 'success');
        } catch (error) {
            try { await restoreIfBranchCheckpoint(branch); } catch (_) {
                delete context.chatMetadata?.[IF_BRANCH_META_KEY];
                try { await saveIfBranchMetadata(); } catch (_) {}
            }
            notify(error.message || String(error), 'error');
        } finally {
            ifBranchStarting = false;
            renderPanel();
        }
    }
    
    function branchMessageIndex(messageRef) {
        const chat = getChat();
        const direct = Number(messageRef);
        if (Number.isInteger(direct) && direct >= 0 && direct < chat.length) return direct;
        if (messageRef && typeof messageRef === 'object') {
            const objectIndex = chat.indexOf(messageRef);
            if (objectIndex >= 0) return objectIndex;
            const nested = Number(messageRef.messageId ?? messageRef.message_id ?? messageRef.id);
            if (Number.isFinite(nested)) {
                const found = chat.findIndex((message, index) => String(messageId(message, index)) === String(nested));
                if (found >= 0) return found;
            }
        }
        return chat.length - 1;
    }
    
    function markLatestIfBranchMessage(messageRef) {
        const branch = ifBranchMetadata();
        if (!branch) return;
        const chat = getChat();
        const index = branchMessageIndex(messageRef);
        const startIndex = ifBranchStartIndex(branch, chat);
        if (index < 0 || (startIndex >= 0 && index < startIndex) || !chat[index]) return;
        const message = chat[index];
        if (!message.extra || typeof message.extra !== 'object') message.extra = {};
        message.extra[IF_BRANCH_MESSAGE_KEY] = branch.id;
        const hasStart = chat.some((item) => item?.extra?.[IF_BRANCH_MESSAGE_KEY] === branch.id && item?.extra?.chat_toolbox_if_branch_start === true);
        if (!hasStart) message.extra.chat_toolbox_if_branch_start = true;
        host.setTimeout(() => saveChat(), 0);
        host.setTimeout(() => {
            if (isPanelTabActive('if-branch')) renderPanel();
        }, 120);
    }
    
    function unbindIfBranchEvents() {
        const source = getContext().eventSource;
        for (const binding of ifBranchEventBindings) {
            try {
                if (typeof source?.off === 'function') source.off(binding.type, binding.handler);
                else source?.removeListener?.(binding.type, binding.handler);
            } catch (_) {}
        }
        ifBranchEventBindings = [];
    }
    
    function bindIfBranchEvents() {
        unbindIfBranchEvents();
        const context = getContext();
        const source = context.eventSource;
        const types = context.eventTypes || {};
        if (!source?.on) return;
        const bind = (type, handler) => {
            if (!type) return;
            source.on(type, handler);
            ifBranchEventBindings.push({ type, handler });
        };
        bind(types.MESSAGE_SENT, (messageRef) => markLatestIfBranchMessage(messageRef));
        bind(types.MESSAGE_RECEIVED, (messageRef) => markLatestIfBranchMessage(messageRef));
        bind(types.MESSAGE_DELETED, () => {
            if (isPanelTabActive('if-branch')) host.setTimeout(renderPanel, 80);
        });
        bind(types.CHAT_CHANGED, () => {
            ifBranchReader = null;
            ifPromptEditor = null;
            if (isPanelTabActive('if-branch')) host.setTimeout(renderPanel, 80);
        });
    }
    
    function createIfBranchFavorite(snapshot) {
        return normalizeIfFavorite({
            id: `if-favorite-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            title: snapshot.branch.title || '未命名 IF 支线',
            tags: snapshot.branch.tags || '',
            character: snapshot.branch.character || ifBranchCharacterName(),
            chat: snapshot.branch.chat || currentChatName(),
            createdAt: new Date().toISOString(),
            messages: snapshot.messages.map(ifBranchStoredMessage),
        });
    }
    
    async function finishIfBranch(mode) {
        const snapshot = currentIfBranchSnapshot();
        if (!snapshot) return notify('当前聊天没有进行中的 IF 支线', 'info');
        if (isHostGenerationBusy()) return notify('酒馆仍在生成回复，请先停止或等待本轮完成', 'warning');
        if (snapshot.startIndex < 0) return notify('找不到支线起点，请使用“清除异常标记”后检查聊天', 'error');
        if (mode !== 'keep' && !snapshot.layers) return notify('支线还没有任何楼层', 'warning');
        const actionText = mode === 'collect' ? '收藏并删除' : mode === 'discard' ? '仅删除' : '保留为主线';
        const confirmation = mode === 'keep'
            ? `确定把当前 ${snapshot.layers} 层 IF 支线保留为正式主线吗？`
            : `确定${actionText}当前 IF 支线吗？这会从聊天末尾移除 ${snapshot.layers} 层。`;
        const confirmed = await requestDialog({
            title: actionText,
            message: confirmation,
            confirmLabel: actionText,
            danger: mode === 'discard',
        });
        if (!confirmed) return;
    
        const favorite = mode === 'collect' ? createIfBranchFavorite(snapshot) : null;
        try {
            if (mode === 'keep') {
                snapshot.messages.forEach((message) => {
                    if (!message?.extra) return;
                    delete message.extra[IF_BRANCH_MESSAGE_KEY];
                    delete message.extra.chat_toolbox_if_branch_start;
                });
                delete getContext().chatMetadata[IF_BRANCH_META_KEY];
                await saveIfBranchMetadata();
                await saveChat();
            } else {
                const context = getContext();
                while (getChat().length > snapshot.startIndex) {
                    if (typeof context.deleteLastMessage === 'function') await context.deleteLastMessage();
                    else getChat().pop();
                }
                await restoreIfBranchCheckpoint(snapshot.branch);
                await saveChat();
                if (favorite) {
                    getSettings().ifBranch.favorites.unshift(favorite);
                    saveSettings();
                }
            }
            ifBranchReader = null;
            renderPanel();
            notify(mode === 'collect' ? '支线已完整收藏并从聊天移除' : mode === 'discard' ? '支线已从聊天移除，开始前变量已还原' : '支线已保留为正式主线', 'success');
        } catch (error) {
            notify(`处理支线失败：${error.message || error}`, 'error');
        }
    }
    
    async function clearBrokenIfBranchState() {
        const branch = ifBranchMetadata();
        if (!branch) return;
        const confirmed = await requestDialog({
            title: '清除异常标记',
            message: '只清除工具箱的异常支线标记吗？聊天楼层和当前变量都不会改动。',
            confirmLabel: '清除标记',
            danger: true,
        });
        if (!confirmed) return;
        delete getContext().chatMetadata[IF_BRANCH_META_KEY];
        await saveIfBranchMetadata();
        renderPanel();
        notify('异常支线标记已清除', 'success');
    }
    
    function ifFavoriteTranscript(favorite) {
        return favorite.messages.map((message, index) => {
            const role = message.role === 'user' ? 'USER' : message.role === 'system' ? 'SYSTEM' : 'ASSISTANT';
            const name = message.name ? ` · ${message.name}` : '';
            return `${index + 1}. ${role}${name}\n${message.text}`;
        }).join('\n\n');
    }
    
    function ifFavoriteCharacters(favorite) {
        return favorite.messages.reduce((sum, message) => sum + ifBranchCharacterCount(message.text), 0);
    }
    
    async function copyIfFavorite(id) {
        const favorite = ifFavoriteById(id);
        if (!favorite) return notify('找不到这条收藏', 'error');
        try {
            await (host.navigator?.clipboard || navigator.clipboard).writeText(ifFavoriteTranscript(favorite));
            notify('支线全文已复制', 'success');
        } catch (_) {
            notify('复制失败，请在阅读界面手动选择文字', 'error');
        }
    }
    
    function exportIfFavorite(id) {
        const favorite = ifFavoriteById(id);
        if (!favorite) return notify('找不到这条收藏', 'error');
        const safe = String(favorite.title || 'IF支线').replace(/[\\/:*?"<>|]/g, '').trim() || 'IF支线';
        const header = `${favorite.title}\n角色：${favorite.character || '未记录'}\n原聊天：${favorite.chat || '未记录'}\n收藏时间：${favorite.createdAt || ''}\n楼层：${favorite.messages.length}\n正文字数：${ifFavoriteCharacters(favorite)}\n\n`;
        download(header + ifFavoriteTranscript(favorite), `${safe}.txt`);
    }
    
    async function renameIfFavorite(id) {
        const favorite = ifFavoriteById(id);
        if (!favorite) return notify('找不到这条收藏', 'error');
        const title = await requestDialog({
            kind: 'prompt',
            title: '重命名 IF 收藏',
            label: '收藏名称',
            value: favorite.title,
            placeholder: '输入收藏名称',
            confirmLabel: '保存',
        });
        if (title === null) return;
        const trimmed = String(title).trim();
        if (!trimmed) return notify('收藏名称不能为空', 'warning');
        favorite.title = trimmed;
        saveSettings();
        renderPanel();
    }
    
    async function deleteIfFavorite(id) {
        const favorite = ifFavoriteById(id);
        if (!favorite) return;
        const confirmed = await requestDialog({
            title: '删除 IF 收藏',
            message: `确定删除收藏“${favorite.title}”吗？`,
            confirmLabel: '删除',
            danger: true,
        });
        if (!confirmed) return;
        getSettings().ifBranch.favorites = ifFavorites().filter((item) => item.id !== favorite.id);
        if (ifBranchReader?.favoriteId === favorite.id) ifBranchReader = null;
        saveSettings();
        renderPanel();
    }
    
    function renderIfBranchReader() {
        const favorite = ifFavoriteById(ifBranchReader?.favoriteId);
        if (!favorite) return '';
        const messages = favorite.messages.map((message, index) => {
            const role = message.role === 'user' ? '用户' : message.role === 'system' ? '系统' : '角色';
            let content = '';
            if (typeof host.messageFormatting === 'function') {
                try {
                    content = host.messageFormatting(String(message.text || ''), String(message.name || ''), message.role === 'system', message.role === 'user', -1, {}, false);
                } catch (_) {}
            }
            if (!content) content = escapeHTML(message.text).replace(/\n/g, '<br>');
            return `<article class="ctb-if-reader-message is-${message.role}"><div class="ctb-if-reader-meta"><strong>${index + 1}. ${role}${message.name ? ` · ${escapeHTML(message.name)}` : ''}</strong><span>${ifBranchCharacterCount(message.text)} 字</span></div><div class="ctb-if-reader-rendered mes_text">${content}</div></article>`;
        }).join('');
        return `<div class="ctb-reader-overlay" role="dialog" aria-modal="true">
            <div class="ctb-reader-card">
                <div class="ctb-reader-header"><span>${escapeHTML(favorite.title)} · ${favorite.messages.length} 层 · ${ifFavoriteCharacters(favorite)} 字</span><button type="button" class="ctb-review-expand" data-action="close-if-reader" aria-label="关闭阅读">×</button></div>
                <div class="ctb-reader-content ctb-if-reader-content">${messages}</div>
            </div>
        </div>`;
    }
    
    function renderIfPromptEditor() {
        const editor = ifPromptEditor;
        if (!editor) return '';
        const draft = editor.draft;
        return `<section class="ctb-section ctb-if-editor">
            <div class="ctb-section-title">${editor.isNew ? '新建 IF 开场词' : '编辑 IF 开场词'}</div>
            <label class="ctb-field">名称<input class="ctb-input" id="ctb-if-prompt-name" value="${escapeHTML(draft.name || '')}" placeholder="例如：角色做了另一个选择"></label>
            <label class="ctb-field">标签<input class="ctb-input" id="ctb-if-prompt-tags" value="${escapeHTML(draft.tags || '')}" placeholder="例如 if, 日常, 轻松"></label>
            <label class="ctb-field">发送给酒馆的 user 指令<textarea class="ctb-input ctb-textarea ctb-if-prompt-content" id="ctb-if-prompt-content" placeholder="完整写出这条 IF 支线的开场要求">${escapeHTML(draft.content || '')}</textarea></label>
            <div class="ctb-inline ctb-if-editor-actions"><button type="button" class="ctb-button ctb-primary" data-action="save-if-prompt">保存</button><button type="button" class="ctb-button" data-action="cancel-if-prompt">取消</button></div>
        </section>`;
    }
    
    function renderActiveIfBranch() {
        const snapshot = currentIfBranchSnapshot();
        if (!snapshot) return '';
        if (snapshot.startIndex < 0) {
            return `<section class="ctb-section ctb-if-active is-error"><div class="ctb-section-title">IF 支线标记异常</div><p>当前聊天保留了支线状态，但找不到支线起点。请先检查聊天，再只清除工具箱标记。</p><button type="button" class="ctb-button ctb-danger" data-action="clear-broken-if-branch">清除异常标记</button></section>`;
        }
        const started = snapshot.branch.startedAt ? new Date(snapshot.branch.startedAt).toLocaleString() : '';
        return `<section class="ctb-section ctb-if-active">
            <div class="ctb-section-title"><span>进行中的 IF 支线</span><span>${snapshot.layers} 层 · ${snapshot.characters} 字</span></div>
            <div class="ctb-if-active-summary"><strong>${escapeHTML(snapshot.branch.title || '未命名 IF 支线')}</strong><small>${escapeHTML([snapshot.branch.character, started].filter(Boolean).join(' · '))}</small><p>继续直接使用酒馆主聊天框对话；之后新增的楼层都会属于这条支线。删除支线会恢复开始前的聊天变量和全局变量。</p></div>
            <div class="ctb-if-finish-actions"><button type="button" class="ctb-button ctb-primary" data-action="finish-if-collect"${snapshot.layers ? '' : ' disabled'}>收藏并删除支线</button><button type="button" class="ctb-button ctb-danger" data-action="finish-if-discard"${snapshot.layers ? '' : ' disabled'}>仅删除支线</button><button type="button" class="ctb-button" data-action="finish-if-keep">保留为主线</button></div>
        </section>`;
    }
    
    function renderIfPrompts() {
        const active = Boolean(ifBranchMetadata());
        const rows = ifPrompts().map((prompt) => `<article class="ctb-if-prompt-card">
            <div class="ctb-if-card-head"><div><strong>${escapeHTML(prompt.name)}</strong>${prompt.tags ? `<small>${escapeHTML(prompt.tags)}</small>` : ''}</div><span>${ifBranchCharacterCount(prompt.content)} 字</span></div>
            <p>${escapeHTML(prompt.content)}</p>
            <div class="ctb-inline ctb-if-card-actions"><button type="button" class="ctb-button ctb-primary" data-action="start-if-branch" data-if-prompt-id="${escapeHTML(prompt.id)}"${active || ifBranchStarting ? ' disabled' : ''}>开始支线</button><button type="button" class="ctb-button" data-action="fill-if-prompt" data-if-prompt-id="${escapeHTML(prompt.id)}">填入聊天框</button><button type="button" class="ctb-button" data-action="edit-if-prompt" data-if-prompt-id="${escapeHTML(prompt.id)}">编辑</button><button type="button" class="ctb-button ctb-danger" data-action="delete-if-prompt" data-if-prompt-id="${escapeHTML(prompt.id)}">删除</button></div>
        </article>`).join('');
        return `${renderIfPromptEditor()}<section class="ctb-section"><div class="ctb-section-title"><span>IF 开场词库</span><button type="button" class="ctb-button ctb-primary" data-action="new-if-prompt"><i class="fa-solid fa-plus"></i> 新建</button></div><div class="ctb-if-list">${rows || '<div class="ctb-results ctb-results-empty">还没有开场词。先新建一条完整的 user 指令。</div>'}</div></section>`;
    }
    
    function renderIfFavorites() {
        const rows = ifFavorites().map((favorite) => {
            const date = favorite.createdAt ? new Date(favorite.createdAt).toLocaleString() : '';
            return `<article class="ctb-if-favorite-card"><div class="ctb-if-card-head"><div><strong>${escapeHTML(favorite.title)}</strong><small>${escapeHTML([favorite.character, favorite.chat, date].filter(Boolean).join(' · '))}</small></div><span>${favorite.messages.length} 层 · ${ifFavoriteCharacters(favorite)} 字</span></div>${favorite.tags ? `<div class="ctb-if-tags">${escapeHTML(favorite.tags)}</div>` : ''}<div class="ctb-inline ctb-if-card-actions"><button type="button" class="ctb-button ctb-primary" data-action="open-if-favorite" data-if-favorite-id="${escapeHTML(favorite.id)}">阅读</button><button type="button" class="ctb-button" data-action="copy-if-favorite" data-if-favorite-id="${escapeHTML(favorite.id)}">复制</button><button type="button" class="ctb-button" data-action="export-if-favorite" data-if-favorite-id="${escapeHTML(favorite.id)}">导出</button><button type="button" class="ctb-button" data-action="rename-if-favorite" data-if-favorite-id="${escapeHTML(favorite.id)}">改名</button><button type="button" class="ctb-button ctb-danger" data-action="delete-if-favorite" data-if-favorite-id="${escapeHTML(favorite.id)}">删除</button></div></article>`;
        }).join('');
        return `<section class="ctb-section"><div class="ctb-section-title"><span>支线收藏夹</span><span>${ifFavorites().length} 条</span></div><div class="ctb-if-list">${rows || '<div class="ctb-results ctb-results-empty">还没有收藏的 IF 支线。</div>'}</div></section>`;
    }
    
    function renderIfBranchTab() {
        return `<section class="ctb-section"><div class="ctb-section-title">临时 IF 支线 ${infoButton('if-branch-scope')}</div></section>
            ${renderActiveIfBranch()}
            <div class="ctb-inline ctb-if-tabs"><button type="button" class="ctb-scope${ifBranchLibraryView === 'prompts' ? ' is-active' : ''}" data-action="set-if-library-view" data-if-view="prompts">开场词库</button><button type="button" class="ctb-scope${ifBranchLibraryView === 'favorites' ? ' is-active' : ''}" data-action="set-if-library-view" data-if-view="favorites">收藏夹</button></div>
            ${ifBranchLibraryView === 'favorites' ? renderIfFavorites() : renderIfPrompts()}`;
    }

    function handleInput(target) {
        const id = target?.id;
        if (id === 'ctb-if-prompt-name' && ifPromptEditor) ifPromptEditor.draft.name = target.value;
        else if (id === 'ctb-if-prompt-tags' && ifPromptEditor) ifPromptEditor.draft.tags = target.value;
        else if (id === 'ctb-if-prompt-content' && ifPromptEditor) ifPromptEditor.draft.content = target.value;
        else return false;
        return true;
    }

    async function handleAction(action, data = {}) {
        switch (action) {
            case 'set-if-library-view': ifBranchLibraryView = data.ifView === 'favorites' ? 'favorites' : 'prompts'; ifPromptEditor = null; renderPanel(); return true;
            case 'new-if-prompt': beginNewIfPrompt(); return true;
            case 'edit-if-prompt': beginEditIfPrompt(data.ifPromptId); return true;
            case 'save-if-prompt': saveIfPromptEditor(); return true;
            case 'cancel-if-prompt': cancelIfPromptEditor(); return true;
            case 'delete-if-prompt': await deleteIfPrompt(data.ifPromptId); return true;
            case 'fill-if-prompt': fillIfPrompt(data.ifPromptId); return true;
            case 'start-if-branch': await startIfBranch(data.ifPromptId); return true;
            case 'finish-if-collect': await finishIfBranch('collect'); return true;
            case 'finish-if-discard': await finishIfBranch('discard'); return true;
            case 'finish-if-keep': await finishIfBranch('keep'); return true;
            case 'clear-broken-if-branch': await clearBrokenIfBranchState(); return true;
            case 'open-if-favorite': ifBranchReader = { favoriteId: data.ifFavoriteId }; renderPanel(); return true;
            case 'copy-if-favorite': await copyIfFavorite(data.ifFavoriteId); return true;
            case 'export-if-favorite': exportIfFavorite(data.ifFavoriteId); return true;
            case 'rename-if-favorite': await renameIfFavorite(data.ifFavoriteId); return true;
            case 'delete-if-favorite': await deleteIfFavorite(data.ifFavoriteId); return true;
            case 'close-if-reader': closeReader(); return true;
            default: return false;
        }
    }

    function closeReader() {
        if (!ifBranchReader) return false;
        ifBranchReader = null;
        renderPanel();
        return true;
    }

    function handleGlobalKeydown(event) {
        if (event.key !== 'Escape' || !ifBranchReader || isDestroyed()) return;
        event.preventDefault();
        event.stopPropagation();
        closeReader();
    }

    function destroy() {
        ifBranchReader = null;
        ifPromptEditor = null;
        unbindIfBranchEvents();
    }

    return {
        renderTab: renderIfBranchTab,
        renderReader: renderIfBranchReader,
        handleInput,
        handleAction,
        handleGlobalKeydown,
        bindEvents: bindIfBranchEvents,
        closeReader,
        hasReader: () => Boolean(ifBranchReader),
        destroy,
    };
}
