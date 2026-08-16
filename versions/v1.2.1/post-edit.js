export function createPostEditModule(deps) {
    const {
        host, aiRequestTimeoutSec, getSettings, defaults, getContext, getChat,
        messageId, messageText, setMessageText, isAssistantMessage,
        escapeRegex, normalizeBlankLines, saveChat, verifySavedEntries,
        refreshVisibleMessage, emitMessageEdited, emitMessageUpdated,
        rememberUndo, saveSettings, scheduleSettingsSave, flushSettingsSave,
        notify, renderPanel, escapeHTML, infoButton, defaultPostEditSystemPrompt,
    } = deps;
    const AI_REQUEST_TIMEOUT_SEC = aiRequestTimeoutSec;

    let postEditDraft = null;
    let postEditLoading = false;
    let postEditEditing = false;
    let postEditReview = [];
    let postEditReviewEditingIndex = -1;
    let postEditPromptPreview = null;
    let postEditPreviewLoading = false;
    let channelLoadingId = '';
    let channelEditor = null;

    function latestAssistant() {
        const chat = getChat();
        for (let i = chat.length - 1; i >= 0; i--) {
            if (isAssistantMessage(chat[i])) return { raw: chat[i], rawIndex: i, id: messageId(chat[i], i), text: messageText(chat[i]) };
        }
        return null;
    }
    
    function assistantAtFloor(value) {
        const wanted = String(value ?? '').trim();
        if (!wanted) return latestAssistant();
        const chat = getChat();
        for (let rawIndex = 0; rawIndex < chat.length; rawIndex += 1) {
            const raw = chat[rawIndex];
            const id = messageId(raw, rawIndex);
            if (isAssistantMessage(raw) && (String(id) === wanted || String(rawIndex) === wanted)) {
                return { raw, rawIndex, id, text: messageText(raw) };
            }
        }
        return null;
    }
    
    function postEditTagMatch(text, rawTag) {
        const tag = String(rawTag || '').trim().replace(/^<|>$/g, '');
        if (!/^[A-Za-z][\w.-]*$/.test(tag)) throw new Error('正文标签名无效，请填写 content 这类单独标签名');
        const regex = new RegExp(`<${escapeRegex(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegex(tag)}\\s*>`, 'i');
        const match = regex.exec(String(text ?? ''));
        if (!match) return null;
        const openingLength = match[0].indexOf('>') + 1;
        const innerStart = match.index + openingLength;
        return {
            tag,
            innerStart,
            innerEnd: innerStart + match[1].length,
            content: match[1],
        };
    }
    
    function preparePostEditFloor({ silent = false } = {}) {
        const selected = assistantAtFloor(getSettings().postEdit.floor);
        if (!selected) {
            if (!silent) notify('没有找到该楼层的 AI 回复', 'warning');
            return false;
        }
        try {
            const match = postEditTagMatch(selected.text, getSettings().postEdit.tag);
            if (!match) {
                if (!silent) notify(`楼层 #${selected.id} 中没有找到 <${getSettings().postEdit.tag || 'content'}>…</${getSettings().postEdit.tag || 'content'}>`, 'warning');
                return false;
            }
            postEditDraft = {
                rawIndex: selected.rawIndex,
                floor: selected.id,
                originalFull: selected.text,
                originalContent: match.content,
                revisedContent: '',
                tag: match.tag,
            };
            postEditEditing = false;
            postEditReview = [];
            postEditReviewEditingIndex = -1;
            postEditPromptPreview = null;
            getSettings().postEdit.floor = String(selected.id);
            if (!silent) {
                renderPanel();
                notify(`已读取楼层 #${selected.id} 的 <${match.tag}> 正文`, 'success');
            }
            return true;
        } catch (error) {
            if (!silent) notify(error.message, 'error');
            return false;
        }
    }
    
    function textFromValue(value, seen = new Set(), depth = 0) {
        if (typeof value === 'string') return value;
        if (value === null || value === undefined || depth > 6) return '';
        if (typeof value !== 'object') return '';
        if (seen.has(value)) return '';
        seen.add(value);
        if (Array.isArray(value)) {
            return value.map((item) => textFromValue(item, seen, depth + 1)).filter(Boolean).join('\n');
        }
        const parts = [];
        // Covers SillyTavern generateRaw strings, OpenAI-compatible responses,
        // Anthropic/Gemini blocks, and proxy responses wrapped in data/result.
        for (const key of ['text', 'content', 'output_text', 'response', 'message', 'output', 'data', 'result']) {
            if (value[key] === undefined) continue;
            const text = textFromValue(value[key], seen, depth + 1);
            if (text) parts.push(text);
            if (parts.length) break;
        }
        if (!parts.length && Array.isArray(value.choices)) {
            const text = textFromValue(value.choices, seen, depth + 1);
            if (text) parts.push(text);
        }
        return parts.join('\n');
    }
    
    function contentBlockText(value) {
        return textFromValue(value);
    }
    
    function apiOutputText(json) {
        const text = textFromValue(json).trim();
        if (text) return text;
        throw new Error('API 响应中没有找到可用文本');
    }
    
    function makeChannel(name = '自定义渠道') {
        return {
            id: `channel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            name,
            url: '',
            key: '',
            model: '',
            models: [],
            temperature: 0.2,
            maxTokens: 4096,
            timeoutSec: AI_REQUEST_TIMEOUT_SEC,
        };
    }
    
    function channelById(id) {
        return getSettings().ai?.channels?.find((channel) => channel.id === id) || null;
    }
    
    function cloneChannel(channel) {
        return JSON.parse(JSON.stringify(channel));
    }
    
    function channelDraftById(id) {
        if (channelEditor?.draft?.id === id) return channelEditor.draft;
        return channelById(id);
    }
    
    function beginNewChannel(feature) {
        channelEditor = {
            feature,
            isNew: true,
            draft: makeChannel(`自定义渠道 ${getSettings().ai.channels.length + 1}`),
        };
        renderPanel();
    }
    
    function beginEditChannel(feature, channelId) {
        const channel = channelById(channelId);
        if (!channel) return;
        channelEditor = { feature, isNew: false, draft: cloneChannel(channel) };
        renderPanel();
    }
    
    function saveChannelEditor() {
        if (!channelEditor?.draft) return;
        const draft = channelEditor.draft;
        draft.name = String(draft.name || '').trim();
        draft.url = String(draft.url || '').trim();
        if (!draft.name) return notify('请填写渠道名称', 'warning');
        if (!draft.url) return notify('请填写 API 地址', 'warning');
        if (channelEditor.isNew) getSettings().ai.channels.push(cloneChannel(draft));
        else {
            const index = getSettings().ai.channels.findIndex((channel) => channel.id === draft.id);
            if (index < 0) return notify('要保存的渠道已经不存在', 'error');
            getSettings().ai.channels.splice(index, 1, cloneChannel(draft));
        }
        getSettings()[channelEditor.feature].channelId = draft.id;
        const name = draft.name;
        channelEditor = null;
        saveSettings();
        renderPanel();
        notify(`渠道“${name}”已保存`, 'success');
    }
    
    function cancelChannelEditor() {
        channelEditor = null;
        renderPanel();
    }
    
    function selectedChannel(feature) {
        const id = getSettings()[feature]?.channelId || 'main';
        return id === 'main' ? null : channelById(id);
    }
    
    function normalizeProxyUrl(value) {
        let url = String(value || '').trim().replace(/\/+$/, '');
        url = url.replace(/\/chat\/completions$/i, '');
        if (!url) throw new Error('请填写自定义渠道地址');
        try {
            const parsed = new URL(url);
            if (!parsed.pathname || parsed.pathname === '/') url = `${url}/v1`;
        } catch (_) {}
        return url;
    }
    
    function stRequestHeaders() {
        const context = getContext();
        try {
            if (typeof context.getRequestHeaders === 'function') return context.getRequestHeaders();
            if (typeof host.getRequestHeaders === 'function') return host.getRequestHeaders();
        } catch (_) {}
        return { 'Content-Type': 'application/json' };
    }
    
    function requestAbortError(message = '请求已取消') {
        const error = new Error(message);
        error.name = 'AbortError';
        return error;
    }
    
    function waitForAbortable(promise, { signal = null, timeoutSec = 0 } = {}) {
        if (!signal && !(Number(timeoutSec) > 0)) return promise;
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            const cleanup = () => {
                if (timer) host.clearTimeout(timer);
                signal?.removeEventListener?.('abort', onAbort);
            };
            const settle = (callback, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                callback(value);
            };
            const onAbort = () => settle(reject, requestAbortError());
            if (signal?.aborted) return onAbort();
            signal?.addEventListener?.('abort', onAbort, { once: true });
            const seconds = Number(timeoutSec);
            if (seconds > 0) {
                timer = host.setTimeout(
                    () => settle(reject, new Error(`请求超过 ${Math.round(seconds)} 秒，已自动取消`)),
                    seconds * 1000,
                );
            }
            Promise.resolve(promise).then(
                (value) => settle(resolve, value),
                (error) => settle(reject, error),
            );
        });
    }
    
    async function stProxyJson(path, body, { timeoutSec = AI_REQUEST_TIMEOUT_SEC, signal = null } = {}) {
        const Controller = host.AbortController || globalThis.AbortController;
        const controller = typeof Controller === 'function' ? new Controller() : null;
        const timeoutMs = Math.max(10, Math.min(600, Number(timeoutSec) || AI_REQUEST_TIMEOUT_SEC)) * 1000;
        let timedOut = false;
        let externallyAborted = false;
        const abortFromSignal = () => {
            externallyAborted = true;
            controller?.abort();
        };
        if (signal?.aborted) abortFromSignal();
        else signal?.addEventListener?.('abort', abortFromSignal, { once: true });
        const timer = controller ? host.setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs) : null;
        try {
            const response = await (host.fetch || fetch)(path, {
                method: 'POST',
                headers: stRequestHeaders(),
                body: JSON.stringify(body),
                ...(controller ? { signal: controller.signal } : signal ? { signal } : {}),
            });
            const raw = await response.text();
            let json = {};
            try { json = raw ? JSON.parse(raw) : {}; } catch (_) { json = raw; }
            if (!response.ok) {
                const detail = typeof json === 'string' ? json.slice(0, 300) : json?.error?.message || json?.message;
                throw new Error(detail || `酒馆代理请求失败（HTTP ${response.status}）`);
            }
            return json;
        } catch (error) {
            if (error?.name === 'AbortError' && externallyAborted) throw requestAbortError();
            if (error?.name === 'AbortError' && timedOut) throw new Error(`请求超过 ${Math.round(timeoutMs / 1000)} 秒，已自动取消`);
            throw error;
        } finally {
            if (timer) host.clearTimeout(timer);
            signal?.removeEventListener?.('abort', abortFromSignal);
        }
    }
    
    async function emitChatCompletionSettingsReady(requestBody) {
        const context = getContext();
        const readyType = context.eventTypes?.CHAT_COMPLETION_SETTINGS_READY || context.event_types?.CHAT_COMPLETION_SETTINGS_READY;
        if (readyType && typeof context.eventSource?.emit === 'function') {
            await context.eventSource.emit(readyType, requestBody);
        }
    }
    
    async function callAiText(feature, messages) {
        const channel = selectedChannel(feature);
        if (!channel) {
            const context = getContext();
            const generateRaw = context.generateRaw || host.generateRaw || host.SillyTavern?.generateRaw;
            if (typeof generateRaw !== 'function') throw new Error('酒馆没有提供可用的“跟随主接口”生成方法，请添加自定义渠道');
            const normalized = (Array.isArray(messages) ? messages : [])
                .map((message) => ({ role: String(message?.role || 'user'), content: contentBlockText(message?.content) }))
                .filter((message) => message.content.trim());
            const firstSystem = normalized[0]?.role === 'system' ? normalized[0].content : '';
            const conversation = firstSystem ? normalized.slice(1) : normalized;
            if (!conversation.length) throw new Error('没有可发送给模型的提示词');
            const generation = generateRaw.call(context, {
                prompt: conversation,
                systemPrompt: firstSystem,
                responseLength: 8192,
            });
            const output = await waitForAbortable(generation, { timeoutSec: AI_REQUEST_TIMEOUT_SEC });
            return apiOutputText(output);
        }
        if (!channel.model) throw new Error('请先拉取并选择模型');
        const requestBody = {
            chat_completion_source: 'openai',
            reverse_proxy: normalizeProxyUrl(channel.url),
            proxy_password: String(channel.key || ''),
            model: channel.model,
            messages,
            temperature: Math.max(0, Math.min(2, Number(channel.temperature) || 0)),
            max_tokens: Math.max(1, Math.round(Number(channel.maxTokens) || 4096)),
            presence_penalty: 0,
            frequency_penalty: 0,
            stream: false,
        };
        await emitChatCompletionSettingsReady(requestBody);
        const json = await stProxyJson('/api/backends/chat-completions/generate', requestBody, {
            timeoutSec: channel.timeoutSec || AI_REQUEST_TIMEOUT_SEC,
        });
        return apiOutputText(json);
    }
    
    async function fetchChannelModels(channelId) {
        const channel = channelDraftById(channelId);
        if (!channel || channelLoadingId) return;
        channelLoadingId = channelId;
        renderPanel();
        try {
            const json = await stProxyJson('/api/backends/chat-completions/status', {
                chat_completion_source: 'openai',
                reverse_proxy: normalizeProxyUrl(channel.url),
                proxy_password: String(channel.key || ''),
            });
            const source = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json?.data?.data) ? json.data.data : [];
            const models = source.map((item) => typeof item === 'string' ? item : item?.id || item?.name).filter(Boolean);
            channel.models = [...new Set(models.map(String))].sort((a, b) => a.localeCompare(b));
            if (!channel.models.length) throw new Error('接口没有返回可选模型');
            if (!channel.models.includes(channel.model)) channel.model = channel.models[0];
            notify(`已拉取 ${channel.models.length} 个模型`, 'success');
        } catch (error) {
            notify(`模型拉取失败：${error.message}`, 'error');
        } finally {
            channelLoadingId = '';
            renderPanel();
        }
    }
    
    function savePostEditPreset() {
        const config = getSettings().postEdit;
        const name = String(config.presetName || '').trim();
        const rules = String(config.rules || '').trim();
        if (!name) return notify('请先填写预设名称', 'warning');
        if (!rules) return notify('修改规则为空，不能保存预设', 'warning');
        let preset = config.presets.find((item) => item.id === config.selectedPresetId);
        if (!preset) {
            preset = { id: `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, name, rules };
            config.presets.push(preset);
            config.selectedPresetId = preset.id;
        } else {
            preset.name = name;
            preset.rules = rules;
        }
        saveSettings();
        renderPanel();
        notify(`规则预设“${name}”已保存`, 'success');
    }
    
    function deletePostEditPreset() {
        const config = getSettings().postEdit;
        const index = config.presets.findIndex((item) => item.id === config.selectedPresetId);
        if (index < 0) return;
        const name = config.presets[index].name;
        if (!host.confirm(`确定删除规则预设“${name}”吗？`)) return;
        config.presets.splice(index, 1);
        config.selectedPresetId = '';
        config.presetName = '';
        saveSettings();
        renderPanel();
    }
    
    function cleanPostEditOutput(value, tag) {
        let text = String(value ?? '').trim();
        text = text.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/, '').trim();
        try {
            const tagged = postEditTagMatch(text, tag);
            if (tagged) text = tagged.content;
        } catch (_) {}
        return normalizeBlankLines(text);
    }
    
    function postEditParagraphs(value) {
        return String(value ?? '')
            .replace(/\r\n?/g, '\n')
            .split(/\n[ \t]*\n+/)
            .map((paragraph) => paragraph.trim())
            .filter(Boolean);
    }
    
    function postEditParagraphId(number) {
        return `P${String(Math.max(1, Number(number) || 1)).padStart(4, '0')}`;
    }
    
    function postEditParagraphRecords(value) {
        return postEditParagraphs(value).map((text, index) => ({
            id: postEditParagraphId(index + 1),
            paragraph: index + 1,
            text,
        }));
    }
    
    function postEditComparableText(value) {
        return normalizeBlankLines(String(value ?? ''))
            .replace(/\u00a0/g, ' ')
            .trim();
    }
    
    function resolvePostEditParagraph(item, fallbackIndex, records) {
        const rawId = typeof item === 'object' && item
            ? item.id ?? item.paragraph_id ?? item.paragraphId
            : '';
        const idMatch = String(rawId ?? '').trim().match(/^P?0*(\d+)$/i);
        const byId = idMatch ? records[Number(idMatch[1]) - 1] : null;
        const suppliedOriginal = typeof item === 'object' && item
            ? item.original ?? item.before ?? item.source
            : '';
        const comparableOriginal = postEditComparableText(suppliedOriginal);
        if (comparableOriginal) {
            const exact = records.filter((record) => postEditComparableText(record.text) === comparableOriginal);
            // The copied source text is a stronger locator than a model-invented
            // paragraph number.  Only use it when the match is unique, so repeated
            // paragraphs can never silently redirect a patch.
            if (exact.length === 1) return exact[0];
            if (byId && postEditComparableText(byId.text) === comparableOriginal) return byId;
        }
        if (byId) return byId;
        const rawParagraph = typeof item === 'object' && item
            ? item.paragraph ?? item.index ?? item.paragraph_number
            : fallbackIndex + 1;
        const paragraphMatch = String(rawParagraph ?? '').trim().match(/^P?0*(\d+)$/i);
        const paragraph = paragraphMatch ? Number(paragraphMatch[1]) : Number(rawParagraph);
        return Number.isInteger(paragraph) ? records[paragraph - 1] || null : null;
    }
    
    function postEditParagraphRanges(value) {
        const source = String(value ?? '');
        const ranges = [];
        const separator = /\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/g;
        let segmentStart = 0;
        const append = (segmentEnd) => {
            const raw = source.slice(segmentStart, segmentEnd);
            const leading = raw.match(/^[ \t\r\n]*/)?.[0].length || 0;
            const trailing = raw.match(/[ \t\r\n]*$/)?.[0].length || 0;
            const start = segmentStart + leading;
            const end = Math.max(start, segmentEnd - trailing);
            const text = source.slice(start, end);
            if (text) ranges.push({ number: ranges.length + 1, start, end, text });
        };
        for (const match of source.matchAll(separator)) {
            append(match.index);
            segmentStart = match.index + match[0].length;
        }
        append(source.length);
        return { source, ranges };
    }
    
    function postEditReplacementForRange(review, originalParagraphs) {
        const paragraph = Number(review?.paragraph);
        const replacement = String(review?.replacement ?? '').replace(/\r\n?/g, '\n').trim();
        const pieces = postEditParagraphs(replacement);
        if (pieces.length <= 1) return replacement;
    
        // Some models ignore the requested schema and put a complete revised
        // body into one paragraph's replacement.  Extracting the matching
        // paragraph is safe only when all surrounding paragraphs are still
        // byte-for-byte identical; otherwise stop instead of inserting an
        // entire article into the source paragraph.
        const index = paragraph - 1;
        if (pieces.length === originalParagraphs.length
            && pieces.every((piece, pieceIndex) => pieceIndex === index || piece === originalParagraphs[pieceIndex])) {
            return pieces[index] || '';
        }
        throw new Error(`P${paragraph} 的修改结果包含 ${pieces.length} 个段落，已阻止写入；请把“修改后”编辑为单个完整段落后再采用`);
    }
    
    function parsePostEditResult(value, originalContent) {
        const records = postEditParagraphRecords(originalContent);
        const originalParagraphs = records.map((record) => record.text);
        const parsed = parseLooseJson(value);
        const rawItems = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.paragraphs)
            ? parsed.paragraphs
            : Array.isArray(parsed?.changes) ? parsed.changes : null;
        if (!rawItems && !parsed) {
            const revised = cleanPostEditOutput(value, '');
            const revisedParagraphs = postEditParagraphs(revised);
            if (revisedParagraphs.length !== originalParagraphs.length) {
                throw new Error(`模型返回了 ${revisedParagraphs.length} 段，但原正文有 ${originalParagraphs.length} 段`);
            }
            return {
                fullRevised: revised,
                reviews: revisedParagraphs.map((replacement, index) => ({
                    paragraph: index + 1,
                    original: originalParagraphs[index] || '',
                    reason: '模型未返回逐段原因；请人工核对。',
                    replacement,
                    decision: 'pending',
                })).filter((item) => item.original !== item.replacement),
            };
        }
        const reviewsByParagraph = new Map();
        for (const [index, item] of (rawItems || []).entries()) {
            const record = resolvePostEditParagraph(item, index, records);
            if (!record) continue;
            const paragraph = record.paragraph;
            const original = record.text;
            const replacement = cleanPostEditOutput(typeof item === 'string'
                ? item
                : item?.revised ?? item?.replacement ?? item?.after ?? '', '');
            if (!replacement || replacement === original) continue;
            const review = {
                id: record.id,
                paragraph,
                original,
                reason: String(item?.reason ?? item?.why ?? '未提供修改原因'),
                replacement,
                decision: 'pending',
            };
            const existing = reviewsByParagraph.get(paragraph);
            if (existing && existing.replacement !== review.replacement) {
                throw new Error(`模型对 ${record.id} 返回了两份不同修改，已阻止错位；请重新生成`);
            }
            reviewsByParagraph.set(paragraph, review);
        }
        const reviews = [...reviewsByParagraph.values()].sort((a, b) => a.paragraph - b.paragraph);
        const fullText = typeof parsed === 'string'
            ? parsed
            : parsed?.full_text ?? parsed?.fullText ?? parsed?.revised_text ?? parsed?.revisedText;
        const candidate = typeof fullText === 'string' && fullText.trim()
            ? cleanPostEditOutput(fullText, '')
            : '';
        const patched = originalParagraphs.map((paragraph, index) => {
            const review = reviews.find((item) => item.paragraph === index + 1);
            return review ? review.replacement : paragraph;
        }).join('\n\n');
        // Use a complete draft only when it keeps the same paragraph count.
        // Otherwise rebuild it from validated patches so one malformed field
        // cannot make the whole operation fail.
        // When validated paragraph patches exist, they are the only source of
        // truth for the full preview.  A model-provided full_text may look valid
        // while shifting one paragraph, so it must not override stable IDs.
        let fullRevised = reviews.length
            ? patched
            : candidate && postEditParagraphs(candidate).length === originalParagraphs.length
                ? candidate
                : patched;
        if (!reviews.length && candidate && candidate !== originalContent) {
            const candidateParagraphs = postEditParagraphs(candidate);
            if (candidateParagraphs.length === originalParagraphs.length) {
                candidateParagraphs.forEach((replacement, index) => {
                    if (replacement !== originalParagraphs[index]) {
                        reviews.push({
                            paragraph: index + 1,
                            original: originalParagraphs[index],
                            reason: '模型未返回逐段原因；请人工核对。',
                            replacement,
                            decision: 'pending',
                        });
                    }
                });
                fullRevised = candidateParagraphs.join('\n\n');
            }
        }
        return { fullRevised: normalizeBlankLines(fullRevised), reviews };
    }
    
    function buildPostEditRequest() {
        const config = getSettings().postEdit;
        const paragraphs = postEditParagraphRecords(postEditDraft?.originalContent || '');
        const paragraphPayload = paragraphs.map((record) => ({ id: record.id, text: record.text }));
        return [
            { role: 'system', content: String(typeof config.systemPrompt === 'string' ? config.systemPrompt : defaultPostEditSystemPrompt()).trim() },
            {
                role: 'user',
                content: `【修改规则】\n${String(config.rules || '').trim()}\n\n【正文段落】\n下面每段都有不可更改的稳定 ID。只修改段内词句，不得合并、拆分、调换或重新编号。\n${JSON.stringify({ paragraphs: paragraphPayload }, null, 2)}\n\n【返回要求】\n只输出一个合法 JSON 对象，不要 Markdown、解释或代码围栏。只返回确实修改的段落；每项必须原样复制对应 id 和 original。字符串中的换行必须使用 \\n。\n{"paragraphs":[{"id":"P0001","original":"原段落","reason":"修改原因","revised":"修改后的完整段落"}]}`,
            },
        ];
    }
    
    function countCharacters(value) {
        return Array.from(String(value ?? '')).length;
    }
    
    function buildPromptPreview(messages) {
        const items = Array.isArray(messages) ? messages : [];
        return {
            text: items.map((message) => contentBlockText(message?.content)).filter(Boolean).join('\n\n'),
            characters: items.reduce((total, message) => total + countCharacters(contentBlockText(message?.content)), 0),
            messages: items.length,
        };
    }
    
    // Models often wrap JSON in prose or a Markdown fence. Extract one
    // balanced JSON value before giving up so a harmless wrapper does not
    // turn a valid edit into an apparent API failure.
    function parseLooseJson(value) {
        const text = String(value ?? '').trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
        try { return JSON.parse(text); } catch (_) {}
        const start = [...text].findIndex((char) => char === '{' || char === '[');
        if (start < 0) return null;
        const stack = [];
        let quoted = false;
        let escaped = false;
        for (let index = start; index < text.length; index += 1) {
            const char = text[index];
            if (quoted) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') quoted = false;
                continue;
            }
            if (char === '"') {
                quoted = true;
                continue;
            }
            if (char === '{' || char === '[') stack.push(char);
            else if (char === '}' || char === ']') {
                const expected = char === '}' ? '{' : '[';
                if (stack.pop() !== expected) return null;
                if (!stack.length) {
                    try { return JSON.parse(text.slice(start, index + 1)); } catch (_) { return null; }
                }
            }
        }
        return null;
    }
    
    async function previewPostEditPrompt() {
        if (postEditPreviewLoading) return;
        if (!postEditDraft && !preparePostEditFloor({ silent: true })) return notify('请先读取要修改的 AI 楼层', 'warning');
        postEditPreviewLoading = true;
        renderPanel();
        try {
            postEditPromptPreview = buildPromptPreview(buildPostEditRequest());
        } catch (error) {
            postEditPromptPreview = null;
            notify(`无法生成发送预览：${error.message}`, 'error');
        } finally {
            postEditPreviewLoading = false;
            renderPanel();
        }
    }
    
    async function runPostEdit() {
        if (postEditLoading) return;
        if (!postEditDraft && !preparePostEditFloor({ silent: true })) {
            return notify(`所选 AI 回复中没有找到 <${getSettings().postEdit.tag || 'content'}> 正文`, 'warning');
        }
        const config = getSettings().postEdit;
        if (!String(config.rules || '').trim()) return notify('请填写词句修改规则', 'warning');
        postEditLoading = true;
        postEditReview = [];
        postEditPromptPreview = null;
        renderPanel();
        try {
            const messages = buildPostEditRequest();
            postEditPromptPreview = buildPromptPreview(messages);
            const output = await callAiText('postEdit', messages);
            const parsed = parsePostEditResult(output, postEditDraft.originalContent);
            if (!parsed.fullRevised) throw new Error('API 返回了空文本');
            postEditReview = parsed.reviews;
            postEditDraft.revisedContent = parsed.fullRevised;
            postEditEditing = false;
            postEditReviewEditingIndex = -1;
            if (!postEditReview.length) throw new Error('没有得到可审核的逐段修改，请检查 system 提示词或模型返回格式');
            notify(`API 修改完成，共 ${postEditReview.length} 段待审核`, 'success');
        } catch (error) {
            console.error('[聊天工具箱] 词句修改失败', error);
            notify(`AI 后修改失败：${error.message}`, 'error');
        } finally {
            postEditLoading = false;
            renderPanel();
        }
    }
    
    async function applyPostEdit() {
        if (!postEditDraft?.revisedContent || !postEditReview.length) return notify('请先调用 API 并审核至少一段修改', 'warning');
        const message = getChat()[postEditDraft.rawIndex];
        if (!message) return notify('原消息已经不存在', 'warning');
        const before = messageText(message);
        if (before !== postEditDraft.originalFull) return notify('原回复在读取后已经变化，请重新读取最新正文', 'warning');
        try {
            const match = postEditTagMatch(before, postEditDraft.tag);
            if (!match) throw new Error(`原回复中已经找不到 <${postEditDraft.tag}> 标签`);
            const accepted = postEditReview.filter((item) => item.decision === 'accept');
            if (!accepted.length) return notify('请先点击“采用这段”或“全部采用”', 'warning');
            const split = postEditParagraphRanges(match.content);
            const originalParagraphs = split.ranges.map((item) => item.text);
            const acceptedByParagraph = new Map(accepted.map((review) => [Number(review.paragraph), review]));
            const patches = [...acceptedByParagraph.values()].map((review) => {
                const range = split.ranges[Number(review.paragraph) - 1];
                if (!range) throw new Error(`P${review.paragraph} 已无法对应原正文，请重新读取该楼层`);
                return {
                    ...range,
                    replacement: postEditReplacementForRange(review, originalParagraphs),
                };
            }).sort((a, b) => b.start - a.start);
            let revisedContent = split.source;
            patches.forEach((patch) => {
                revisedContent = revisedContent.slice(0, patch.start) + patch.replacement + revisedContent.slice(patch.end);
            });
            // Only replace the exact inner range of the requested tag.  Do not
            // normalize or rebuild the rest of the message: unrelated text,
            // tags and whitespace must remain byte-for-byte unchanged.
            const after = before.slice(0, match.innerStart) + revisedContent + before.slice(match.innerEnd);
            if (after === before) return notify('采用后内容没有变化', 'info');
            setMessageText(message, after);
            const saved = await saveChat();
            if (!saved) {
                setMessageText(message, before);
                throw new Error('酒馆没有返回可用的保存结果');
            }
            const verified = await verifySavedEntries([{ rawIndex: postEditDraft.rawIndex, field: 'mes', after, normalize: false }]);
            if (verified === false) {
                setMessageText(message, before);
                throw new Error('聊天文件回读结果与修改内容不一致');
            }
            rememberUndo([{ rawIndex: postEditDraft.rawIndex, field: 'mes', before }], `AI 后修改 #${postEditDraft.floor}`, true);
            refreshVisibleMessage(postEditDraft.rawIndex);
            emitMessageEdited(postEditDraft.rawIndex);
            emitMessageUpdated(postEditDraft.rawIndex);
            postEditDraft.originalFull = after;
            postEditDraft.originalContent = revisedContent;
            postEditDraft.revisedContent = '';
            postEditReview = [];
            postEditPromptPreview = null;
            postEditEditing = false;
            renderPanel();
            notify(`已采用并保存楼层 #${postEditDraft.floor}`, 'success');
        } catch (error) {
            setMessageText(message, before);
            refreshVisibleMessage(postEditDraft.rawIndex);
            notify(error.message, 'error');
        }
    }
    
    function renderChannelSettings(feature) {
        const featureSettings = getSettings()[feature];
        const currentId = featureSettings.channelId || 'main';
        const current = channelById(currentId);
        const options = [`<option value="main"${currentId === 'main' || !current ? ' selected' : ''}>跟随酒馆主接口</option>`]
            .concat((getSettings().ai.channels || []).map((channel) => `<option value="${escapeHTML(channel.id)}"${currentId === channel.id ? ' selected' : ''}>${escapeHTML(channel.name || '未命名渠道')}</option>`))
            .join('');
        const editor = channelEditor?.feature === feature ? channelEditor : null;
        const editing = editor?.draft;
        const editorForm = editing ? `
            <div class="ctb-channel-grid">
                <input class="ctb-input" id="ctb-${feature}-channel-name" data-channel-id="${escapeHTML(editing.id)}" placeholder="渠道名称" value="${escapeHTML(editing.name || '')}">
                <input class="ctb-input" id="ctb-${feature}-channel-url" data-channel-id="${escapeHTML(editing.id)}" placeholder="OpenAI 兼容 API 地址" value="${escapeHTML(editing.url || '')}">
                <input class="ctb-input" id="ctb-${feature}-channel-key" data-channel-id="${escapeHTML(editing.id)}" type="password" autocomplete="off" placeholder="API Key" value="${escapeHTML(editing.key || '')}">
                <div class="ctb-inline ctb-model-row">
                    <select class="ctb-input" id="ctb-${feature}-channel-model" data-channel-id="${escapeHTML(editing.id)}">
                        ${editing.model && !(editing.models || []).includes(editing.model) ? `<option value="${escapeHTML(editing.model)}" selected>${escapeHTML(editing.model)}</option>` : ''}
                        ${(editing.models || []).map((model) => `<option value="${escapeHTML(model)}"${editing.model === model ? ' selected' : ''}>${escapeHTML(model)}</option>`).join('')}
                        ${!editing.model && !(editing.models || []).length ? '<option value="">先拉取模型</option>' : ''}
                    </select>
                    <button type="button" class="ctb-button" data-action="fetch-models" data-channel-id="${escapeHTML(editing.id)}"${channelLoadingId ? ' disabled' : ''}>${channelLoadingId === editing.id ? '拉取中…' : '拉取模型'}</button>
                </div>
                <div class="ctb-inline">
                    <label class="ctb-mini-field">温度 <input class="ctb-input" id="ctb-${feature}-channel-temperature" data-channel-id="${escapeHTML(editing.id)}" type="number" min="0" max="2" step="0.1" value="${escapeHTML(editing.temperature ?? 0.2)}"></label>
                    <label class="ctb-mini-field">最大输出 <input class="ctb-input" id="ctb-${feature}-channel-tokens" data-channel-id="${escapeHTML(editing.id)}" type="number" min="1" step="1" value="${escapeHTML(editing.maxTokens || 4096)}"></label>
                </div>
                <div class="ctb-channel-editor-actions"><button type="button" class="ctb-button ctb-primary" data-action="save-channel">保存渠道</button><button type="button" class="ctb-button" data-action="cancel-channel">取消</button>${editor.isNew ? '' : `<button type="button" class="ctb-button ctb-danger" data-action="delete-channel" data-channel-id="${escapeHTML(editing.id)}">删除渠道</button>`}</div>
            </div>` : '';
        const summary = current ? `<div class="ctb-channel-summary"><div><strong>${escapeHTML(current.name || '未命名渠道')}</strong><small>${escapeHTML([current.model || '未选择模型', (() => { try { return new URL(normalizeProxyUrl(current.url)).host; } catch (_) { return current.url || '未填写地址'; } })()].join(' · '))}</small></div><button type="button" class="ctb-button" data-action="edit-channel" data-feature="${feature}" data-channel-id="${escapeHTML(current.id)}"><i class="fa-solid fa-pen"></i> 编辑</button></div>` : '';
        return `
            <div class="ctb-inline ctb-channel-picker">
                <select class="ctb-input" id="ctb-${feature}-channel">${options}</select>
                <button type="button" class="ctb-button" data-action="add-channel" data-feature="${feature}"><i class="fa-solid fa-plus"></i> 新渠道</button>
            </div>
            ${editorForm || summary}`;
    }
    
    function renderPostEditParagraphPreview(value, changedParagraphs) {
        const paragraphs = postEditParagraphs(value);
        if (!paragraphs.length) return '<em>（空）</em>';
        return paragraphs.map((paragraph, index) => {
            const changed = changedParagraphs.has(index + 1) ? ' class="ctb-post-changed"' : '';
            return `<span${changed}>${escapeHTML(paragraph)}</span>`;
        }).join('\n\n');
    }
    
    function renderPostEditTab() {
        const config = getSettings().postEdit || defaults().postEdit;
        const draft = postEditDraft;
        const revised = draft?.revisedContent || '';
        const acceptedCount = postEditReview.filter((item) => item.decision === 'accept').length;
        const changedParagraphs = new Set(postEditReview.map((item) => Number(item.paragraph)).filter(Number.isInteger));
        if (draft && revised) {
            const originalParagraphs = postEditParagraphs(draft.originalContent);
            const revisedParagraphs = postEditParagraphs(revised);
            if (originalParagraphs.length === revisedParagraphs.length) {
                revisedParagraphs.forEach((paragraph, index) => {
                    if (paragraph !== originalParagraphs[index]) changedParagraphs.add(index + 1);
                });
            }
        }
        const presetOptions = [`<option value="">选择规则预设…</option>`].concat((config.presets || []).map((preset) => `<option value="${escapeHTML(preset.id)}"${config.selectedPresetId === preset.id ? ' selected' : ''}>${escapeHTML(preset.name)}</option>`)).join('');
        const reviewList = postEditReview.length ? `<section class="ctb-section">
            <div class="ctb-section-title">逐段审核 <span>${acceptedCount} / ${postEditReview.length} 段将采用</span></div>
            <div class="ctb-review-list">
                ${postEditReview.map((review, index) => `<div class="ctb-review-item${review.decision === 'accept' ? ' is-accepted' : review.decision === 'reject' ? ' is-rejected' : ''}">
                    <div class="ctb-review-title"><span>P${review.paragraph}</span><span>${review.decision === 'accept' ? '将采用' : review.decision === 'reject' ? '不采用' : '等待决定'}</span></div>
                    <div class="ctb-review-compare ctb-post-review-grid">
                        <div><small>原文</small><p>${escapeHTML(review.original)}</p></div>
                        <div><small>修改原因</small><p>${escapeHTML(review.reason || '未提供修改原因')}</p></div>
                        <div><small>修改后</small>${postEditReviewEditingIndex === index ? `<textarea class="ctb-input ctb-review-edit" id="ctb-post-edit-review-revised-${index}">${escapeHTML(review.replacement)}</textarea>` : `<p>${escapeHTML(review.replacement)}</p>`}</div>
                    </div>
                    <div class="ctb-inline"><button type="button" class="ctb-button ctb-primary" data-action="post-edit-decision" data-review-index="${index}" data-decision="accept">采用这段</button><button type="button" class="ctb-button" data-action="post-edit-decision" data-review-index="${index}" data-decision="reject">不采用</button><button type="button" class="ctb-button" data-action="toggle-post-edit-review-editor" data-review-index="${index}">${postEditReviewEditingIndex === index ? '完成编辑' : '编辑'}</button></div>
                </div>`).join('')}
            </div>
            <div class="ctb-inline ctb-review-actions"><button type="button" class="ctb-button" data-action="post-edit-all" data-decision="accept">全部采用</button><button type="button" class="ctb-button" data-action="post-edit-all" data-decision="reject">全部不采用</button><button type="button" class="ctb-button ctb-primary" data-action="apply-post-edit"${acceptedCount && !postEditLoading ? '' : ' disabled'}>${postEditLoading ? '保存中…' : `采用 ${acceptedCount} 段并保存`}</button></div>
        </section>` : '';
        return `
            <section class="ctb-section">
                <div class="ctb-section-title">AI 词句修改 ${infoButton('post-edit-overview')}</div>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">楼层与正文标签 ${infoButton('post-edit-scope')}</div>
                <div class="ctb-inline"><input class="ctb-input" id="ctb-post-edit-floor" type="number" min="0" placeholder="楼层号（留空=最新 AI）" value="${escapeHTML(config.floor || '')}"><input class="ctb-input" id="ctb-post-edit-tag" placeholder="content" value="${escapeHTML(config.tag || 'content')}"><button type="button" class="ctb-button" data-action="prepare-post-edit">读取楼层</button></div>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">生成渠道 ${infoButton('channel-main')}</div>
                ${renderChannelSettings('postEdit')}
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">内置 system 提示词 ${infoButton('system-cache')}</div>
                <textarea class="ctb-input ctb-textarea ctb-system-prompt" id="ctb-post-edit-system" placeholder="控制模型输出格式和修改边界">${escapeHTML(typeof config.systemPrompt === 'string' ? config.systemPrompt : defaultPostEditSystemPrompt())}</textarea>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">用户修改规则</div>
                <div class="ctb-inline ctb-preset-row"><select class="ctb-input" id="ctb-post-edit-preset">${presetOptions}</select><input class="ctb-input" id="ctb-post-edit-preset-name" placeholder="预设名称" value="${escapeHTML(config.presetName || '')}"><button type="button" class="ctb-button" data-action="save-post-preset">保存预设</button><button type="button" class="ctb-button ctb-danger" data-action="delete-post-preset"${config.selectedPresetId ? '' : ' disabled'}>删除</button></div>
                <textarea class="ctb-input ctb-textarea" id="ctb-post-edit-rules" placeholder="例如：减少套话和重复比喻，保持剧情、事实和段落顺序不变。">${escapeHTML(config.rules || '')}</textarea>
            </section>
            <section class="ctb-section">
                <div class="ctb-inline ctb-post-actions">
                    <button type="button" class="ctb-button" data-action="preview-post-edit-prompt"${postEditPreviewLoading ? ' disabled' : ''}><i class="fa-solid fa-eye"></i> ${postEditPreviewLoading ? '整理中…' : '预览发送内容'}</button>
                    <button type="button" class="ctb-button ctb-primary" data-action="run-post-edit" ${draft && !postEditLoading ? '' : 'disabled'}>${postEditLoading ? '修改中…' : '调用 API 修改'}</button>
                    <button type="button" class="ctb-button" data-action="clear-post-edit" ${draft ? '' : 'disabled'}>清空预览</button>
                </div>
            </section>
            ${postEditPromptPreview ? `<section class="ctb-section ctb-prompt-preview"><div class="ctb-section-title"><span>实际发送预览 · 总字数 ${postEditPromptPreview.characters}</span><button type="button" class="ctb-review-expand" data-action="close-post-edit-preview" title="关闭预览" aria-label="关闭预览">×</button></div><pre>${escapeHTML(postEditPromptPreview.text)}</pre></section>` : ''}
            ${draft ? `<section class="ctb-section ctb-post-preview">
                <div class="ctb-section-title">楼层 #${escapeHTML(draft.floor)} · 修改预览</div>
                <div class="ctb-post-column"><div class="ctb-post-label">原正文</div><pre class="ctb-post-text">${renderPostEditParagraphPreview(draft.originalContent, changedParagraphs)}</pre></div>
                <div class="ctb-post-column"><div class="ctb-post-label ctb-post-label-actions"><span>完整修改后（备用总稿）</span>${revised ? `<button type="button" class="ctb-review-expand" data-action="toggle-post-edit-editor" title="${postEditEditing ? '完成编辑' : '编辑修改后正文'}" aria-label="${postEditEditing ? '完成编辑' : '编辑修改后正文'}"><i class="fa-solid ${postEditEditing ? 'fa-check' : 'fa-pen'}"></i></button>` : ''}</div>${postEditEditing ? `<textarea class="ctb-input ctb-post-text ctb-post-edit-textarea" id="ctb-post-edit-revised">${escapeHTML(revised)}</textarea>` : `<pre class="ctb-post-text">${revised ? renderPostEditParagraphPreview(revised, changedParagraphs) : '点击“调用 API 修改”后显示结果。'}</pre>`}</div>
             </section>` : '<div class="ctb-results ctb-results-empty">先选择楼层并读取正文，再调用 API 生成修改预览。</div>'}
            ${reviewList}`;
    }

    function handleInput(target) {
        const id = target?.id;
        if (id === 'ctb-post-edit-floor') getSettings().postEdit.floor = target.value;
        else if (id === 'ctb-post-edit-tag') getSettings().postEdit.tag = target.value;
        else if (id === 'ctb-post-edit-system') getSettings().postEdit.systemPrompt = target.value;
        else if (id === 'ctb-post-edit-rules') getSettings().postEdit.rules = target.value;
        else if (id === 'ctb-post-edit-preset-name') getSettings().postEdit.presetName = target.value;
        else if (id === 'ctb-post-edit-revised') {
            if (postEditDraft) postEditDraft.revisedContent = target.value;
        } else if (id?.startsWith('ctb-post-edit-review-revised-')) {
            const index = Number(id.slice('ctb-post-edit-review-revised-'.length));
            if (postEditReview[index]) {
                postEditReview[index].replacement = target.value;
                if (postEditDraft) {
                    postEditDraft.revisedContent = postEditParagraphs(postEditDraft.originalContent).map((paragraph, paragraphIndex) => {
                        const item = postEditReview.find((review) => review.paragraph === paragraphIndex + 1);
                        return item ? item.replacement : paragraph;
                    }).join('\n\n');
                }
            }
        } else if (target?.dataset?.channelId) {
            const channel = channelEditor?.draft?.id === target.dataset.channelId ? channelEditor.draft : null;
            if (!channel) return true;
            if (id.endsWith('-channel-name')) channel.name = target.value;
            else if (id.endsWith('-channel-url')) channel.url = target.value;
            else if (id.endsWith('-channel-key')) channel.key = target.value;
            else if (id.endsWith('-channel-temperature')) channel.temperature = target.value;
            else if (id.endsWith('-channel-tokens')) channel.maxTokens = target.value;
        } else return false;
        if (id === 'ctb-post-edit-system' || id === 'ctb-post-edit-rules') scheduleSettingsSave();
        return true;
    }

    function handleChange(target) {
        const id = target?.id;
        if (id === 'ctb-post-edit-system' || id === 'ctb-post-edit-rules') {
            flushSettingsSave();
            return true;
        }
        if (id === 'ctb-postEdit-channel') {
            getSettings().postEdit.channelId = target.value;
            channelEditor = null;
            saveSettings();
            renderPanel();
        } else if (id === 'ctb-post-edit-preset') {
            getSettings().postEdit.selectedPresetId = target.value;
            const preset = getSettings().postEdit.presets.find((item) => item.id === target.value);
            if (preset) {
                getSettings().postEdit.presetName = preset.name;
                getSettings().postEdit.rules = preset.rules;
            } else getSettings().postEdit.presetName = '';
            saveSettings();
            renderPanel();
        } else if (target?.dataset?.channelId && id.endsWith('-channel-model')) {
            const channel = channelEditor?.draft?.id === target.dataset.channelId ? channelEditor.draft : null;
            if (channel) channel.model = target.value;
        } else return false;
        return true;
    }

    async function handleAction(action, data = {}) {
        switch (action) {
            case 'add-channel': beginNewChannel(data.feature); return true;
            case 'edit-channel': beginEditChannel(data.feature, data.channelId); return true;
            case 'save-channel': saveChannelEditor(); return true;
            case 'cancel-channel': cancelChannelEditor(); return true;
            case 'delete-channel': {
                const index = getSettings().ai.channels.findIndex((channel) => channel.id === data.channelId);
                if (index < 0 || !host.confirm('确定删除这个生成渠道吗？使用它的词句修改会改为跟随酒馆主接口。')) return true;
                getSettings().ai.channels.splice(index, 1);
                if (getSettings().postEdit.channelId === data.channelId) getSettings().postEdit.channelId = 'main';
                channelEditor = null;
                saveSettings();
                renderPanel();
                return true;
            }
            case 'fetch-models': await fetchChannelModels(data.channelId); return true;
            case 'save-post-preset': savePostEditPreset(); return true;
            case 'delete-post-preset': deletePostEditPreset(); return true;
            case 'prepare-post-edit': preparePostEditFloor(); return true;
            case 'preview-post-edit-prompt': await previewPostEditPrompt(); return true;
            case 'close-post-edit-preview': postEditPromptPreview = null; renderPanel(); return true;
            case 'run-post-edit': await runPostEdit(); return true;
            case 'apply-post-edit': await applyPostEdit(); return true;
            case 'post-edit-decision': {
                const review = postEditReview[Number(data.reviewIndex)];
                if (review) review.decision = data.decision;
                renderPanel();
                return true;
            }
            case 'post-edit-all': postEditReview.forEach((review) => { review.decision = data.decision; }); renderPanel(); return true;
            case 'toggle-post-edit-review-editor': postEditReviewEditingIndex = postEditReviewEditingIndex === Number(data.reviewIndex) ? -1 : Number(data.reviewIndex); renderPanel(); return true;
            case 'toggle-post-edit-editor': postEditEditing = !postEditEditing; renderPanel(); return true;
            case 'clear-post-edit': postEditDraft = null; postEditEditing = false; postEditReview = []; postEditPromptPreview = null; postEditReviewEditingIndex = -1; renderPanel(); return true;
            default: return false;
        }
    }

    return {
        renderTab: renderPostEditTab,
        handleInput,
        handleChange,
        handleAction,
        stProxyJson,
        requestHeaders: stRequestHeaders,
    };
}
