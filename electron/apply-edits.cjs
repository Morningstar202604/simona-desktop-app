const fs = require('fs');
const path = 'D:/Python work/软件包/客户端/electron/bridge-server.cjs';
let content = fs.readFileSync(path, 'utf8');

// ===== Change 1: Insert compactConversation helper function after endStream =====
const endStreamEnd = [
    '        setTimeout(() => { if (activeStreams.get(conversationId) === stream) activeStreams.delete(conversationId); }, 30000);',
    '    }'
].join('\n');

const afterEndStream = '\n\n    // Setup paths';

const helperFn = `

    // -- Shared compaction helper --
    async function compactConversation(conversationId, options = {}) {
        const conv = db.conversations.find(c => c.id === conversationId);
        if (!conv) throw new Error('Conversation not found');
        if (!conv.simona_session_id) throw new Error('No engine session to compact');

        const apiKey = options.apiKey || engineEnvVars.SIMONA_API_KEY || process.env.SIMONA_API_KEY;
        const baseUrl = options.baseUrl || engineEnvVars.SIMONA_BASE_URL || process.env.SIMONA_BASE_URL;
        const modelId = (conv.model || 'simona-sonnet-4-6').replace(/-thinking$/, '');
        const instruction = options.instruction || '';

        const messagesBeforeCompact = db.messages.filter(m => m.conversation_id === conversationId).length;

        const compactPrompt = instruction ? '/compact ' + instruction : '/compact';
        const cliArgs = [
            '--preload', enginePreload,
            '--env-file=' + engineEnv, engineCli,
            '-p', compactPrompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--permission-mode', 'bypassPermissions',
            '--model', modelId,
            '--resume', conv.simona_session_id,
        ];

        const envVars = Object.assign({}, process.env);
        envVars.BUN_DISABLE_GLOBAL_CACHE = '1';
        const engineDir = path.dirname(path.dirname(engineCli));
        envVars.NODE_PATH = path.join(engineDir, 'node_modules');
        if (apiKey) envVars.SIMONA_API_KEY = apiKey;
        if (baseUrl) envVars.SIMONA_BASE_URL = baseUrl;

        console.log('[Compact] Spawning engine /compact, session=' + conv.simona_session_id + ' model=' + modelId);

        const child = spawn(bunExePath, cliArgs, {
            cwd: conv.workspace_path, env: envVars,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdin.end();

        let compactSummary = '';
        let compactMetadata = null;
        let buf = '';

        child.stdout.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            const lines = buf.split('\\n');
            buf = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                let evt;
                try { evt = JSON.parse(line); } catch { continue; }

                if (evt.type === 'system' && evt.subtype === 'compact_boundary') {
                    compactMetadata = evt.compact_metadata || {};
                    console.log('[Compact] Engine compact_boundary:', JSON.stringify(compactMetadata));
                }
                if (evt.type === 'assistant' && evt.message && evt.message.content) {
                    for (const block of evt.message.content) {
                        if (block.type === 'text' && block.text) {
                            compactSummary += block.text;
                        }
                    }
                }
                if (evt.type === 'stream_event' && evt.event) {
                    const se = evt.event;
                    if (se.type === 'content_block_delta' && se.delta && se.delta.type === 'text_delta') {
                        compactSummary += se.delta.text;
                    }
                }
                if (evt.type === 'result' && evt.result && !compactSummary) {
                    compactSummary = typeof evt.result === 'string' ? evt.result : '';
                }
            }
        });

        let stderrBuf = '';
        child.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });

        await new Promise((resolve, reject) => {
            child.on('close', (code) => {
                if (buf.trim()) {
                    try {
                        const e = JSON.parse(buf);
                        if (e.type === 'system' && e.subtype === 'compact_boundary') {
                            compactMetadata = e.compact_metadata || {};
                        }
                        if (!compactSummary && e.result) compactSummary = typeof e.result === 'string' ? e.result : '';
                    } catch (_) {}
                }
                if (code !== 0 && !compactMetadata) {
                    reject(new Error(stderrBuf || 'Engine compact failed with exit code ' + code));
                } else {
                    resolve();
                }
            });
            child.on('error', reject);
        });

        const tokensSaved = compactMetadata && compactMetadata.pre_tokens
            ? Math.round(compactMetadata.pre_tokens * 0.7)
            : Math.round(messagesBeforeCompact * 500);

        db.messages.push({
            id: uuidv4(),
            conversation_id: conversationId,
            role: 'system',
            content: JSON.stringify([{ type: 'text', text: compactSummary || 'Conversation compacted.' }]),
            created_at: new Date().toISOString(),
            is_compact_boundary: true,
        });
        saveDb();

        // Reset token tracking so context-size endpoint returns 0
        conversationUsage.set(conversationId, { inputTokens: 0, outputTokens: 0 });

        console.log('[Compact] Done: ' + messagesBeforeCompact + ' messages compacted, ~' + tokensSaved + ' tokens saved');
        return { summary: compactSummary || 'Conversation compacted.', tokensSaved, messagesCompacted: messagesBeforeCompact };
    }
`;

// Check if function already exists
if (content.includes('compactConversation')) {
    console.log('Edit 1: compactConversation already exists, skipping');
} else {
    const insertPoint = content.indexOf(endStreamEnd + afterEndStream);
    if (insertPoint === -1) {
        console.log('ERROR: Could not find insertion point for Edit 1');
        process.exit(1);
    }
    const insertion = endStreamEnd + helperFn + afterEndStream;
    content = content.substring(0, insertPoint) + insertion + content.substring(insertPoint + endStreamEnd.length + afterEndStream.length);
    console.log('Edit 1: compactConversation helper inserted');
}

// ===== Change 2: Refactor compact endpoint to use compactConversation =====
const oldEndpointFull = [
    '    // Compact conversation \u2014 delegates to Simona Code engine\'s /compact command',
    '    server.post(\'/api/conversations/:id/compact\', async (req, res) => {',
    '        const conv = db.conversations.find(c => c.id === req.params.id);',
    '        if (!conv) return res.status(404).json({ error: \'Conversation not found\' });',
    '',
    '        if (!conv.simona_session_id) {',
    '            return res.status(400).json({ error: \'No engine session to compact (conversation has no history in engine)\' });',
    '        }',
    '',
    '        const env_token = req.body.env_token;',
    '        const env_base_url = req.body.env_base_url;',
    '        const instruction = req.body.instruction || \'\';',
    '        const apiKey = env_token || engineEnvVars.SIMONA_API_KEY || process.env.SIMONA_API_KEY;',
    '        const baseUrl = engineEnvVars.SIMONA_BASE_URL || env_base_url || process.env.SIMONA_BASE_URL;',
    '        const modelId = (conv.model || \'simona-sonnet-4-6\').replace(/-thinking$/, \'\');',
    '',
    '        // Count messages before compaction for reporting',
    '        const messagesBeforeCompact = db.messages.filter(m => m.conversation_id === req.params.id).length;',
    '',
    '        try {',
    '            // Spawn engine CLI with /compact as the prompt \u2014 engine handles the full compaction internally',
    '            const compactPrompt = instruction ? `/compact ${instruction}` : \'/compact\';',
    '            const cliArgs = [',
    '                \'--preload\', enginePreload,',
    '                \'--env-file=\' + engineEnv, engineCli,',
    '                \'-p\', compactPrompt,',
    '                \'--output-format\', \'stream-json\',',
    '                \'--verbose\',',
    '                \'--permission-mode\', \'bypassPermissions\',',
    '                \'--model\', modelId,',
    '                \'--resume\', conv.simona_session_id,',
    '            ];',
    '',
    '            const envVars = Object.assign({}, process.env);',
    '            // Disable Bun global cache to force using local node_modules',
    '            envVars.BUN_DISABLE_GLOBAL_CACHE = \'1\';',
    '            // Set NODE_PATH to ensure Bun can find local dependencies',
    '            const engineDir = path.dirname(path.dirname(engineCli));',
    '            envVars.NODE_PATH = path.join(engineDir, \'node_modules\');',
    '            if (apiKey) envVars.SIMONA_API_KEY = apiKey;',
    '            if (baseUrl) envVars.SIMONA_BASE_URL = baseUrl;',
    '',
    '            console.log(\'[Compact] Spawning engine /compact, session=\' + conv.simona_session_id + \' model=\' + modelId);',
    '',
    '            const child = spawn(bunExePath, cliArgs, {',
    '                cwd: conv.workspace_path, env: envVars,',
    '                stdio: [\'pipe\', \'pipe\', \'pipe\'],',
    '            });',
    '            child.stdin.end();',
    '',
    '            let compactSummary = \'\';',
    '            let compactMetadata = null;',
    '            let buf = \'\';',
    '',
    '            child.stdout.on(\'data\', (chunk) => {',
    '                buf += chunk.toString(\'utf8\');',
    '                const lines = buf.split(\'\\n\');',
    '                buf = lines.pop() || \'\';',
    '',
    '                for (const line of lines) {',
    '                    if (!line.trim()) continue;',
    '                    let evt;',
    '                    try { evt = JSON.parse(line); } catch { continue; }',
    '',
    '                    // Capture the compact_boundary event from engine',
    '                    if (evt.type === \'system\' && evt.subtype === \'compact_boundary\') {',
    '                        compactMetadata = evt.compact_metadata || {};',
    '                        console.log(\'[Compact] Engine compact_boundary:\', JSON.stringify(compactMetadata));',
    '                    }',
    '                    // Capture any text output (the compact summary display)',
    '                    if (evt.type === \'assistant\' && evt.message && evt.message.content) {',
    '                        for (const block of evt.message.content) {',
    '                            if (block.type === \'text\' && block.text) {',
    '                                compactSummary += block.text;',
    '                            }',
    '                        }',
    '                    }',
    '                    // Also capture from stream events',
    '                    if (evt.type === \'stream_event\' && evt.event) {',
    '                        const se = evt.event;',
    '                        if (se.type === \'content_block_delta\' && se.delta && se.delta.type === \'text_delta\') {',
    '                            compactSummary += se.delta.text;',
    '                        }',
    '                    }',
    '                    // Result fallback',
    '                    if (evt.type === \'result\' && evt.result && !compactSummary) {',
    '                        compactSummary = typeof evt.result === \'string\' ? evt.result : \'\';',
    '                    }',
    '                }',
    '            });',
    '',
    '            let stderrBuf = \'\';',
    '            child.stderr.on(\'data\', (c) => { stderrBuf += c.toString(\'utf8\'); });',
    '',
    '            await new Promise((resolve, reject) => {',
    '                child.on(\'close\', (code) => {',
    '                    // Process remaining buffer',
    '                    if (buf.trim()) {',
    '                        try {',
    '                            const e = JSON.parse(buf);',
    '                            if (e.type === \'system\' && e.subtype === \'compact_boundary\') {',
    '                                compactMetadata = e.compact_metadata || {};',
    '                            }',
    '                            if (!compactSummary && e.result) compactSummary = typeof e.result === \'string\' ? e.result : \'\';',
    '                        } catch (_) {}',
    '                    }',
    '                    if (code !== 0 && !compactMetadata) {',
    '                        reject(new Error(stderrBuf || \'Engine compact failed with exit code \' + code));',
    '                    } else {',
    '                        resolve();',
    '                    }',
    '                });',
    '                child.on(\'error\', reject);',
    '            });',
    '',
    '            // Engine has compacted its internal session \u2014 keep all old messages',
    '            // in local db for UI display, just append a compact boundary marker',
    '            const tokensSaved = compactMetadata && compactMetadata.pre_tokens',
    '                ? Math.round(compactMetadata.pre_tokens * 0.7)',
    '                : Math.round(messagesBeforeCompact * 500); // rough estimate',
    '',
    '            db.messages.push({',
    '                id: uuidv4(),',
    '                conversation_id: req.params.id,',
    '                role: \'system\',',
    '                content: JSON.stringify([{ type: \'text\', text: compactSummary || \'Conversation compacted.\' }]),',
    '                created_at: new Date().toISOString(),',
    '                is_compact_boundary: true,',
    '            });',
    '            saveDb();',
    '',
    '            console.log(`[Compact] Done: ${messagesBeforeCompact} messages compacted, ~${tokensSaved} tokens saved`);',
    '            res.json({ summary: compactSummary || \'Conversation compacted.\', tokensSaved, messagesCompacted: messagesBeforeCompact });',
    '        } catch (err) {',
    '            console.error(\'[Compact] Error:\', err);',
    '            res.status(500).json({ error: err.message || \'Compaction failed\' });',
    '        }',
    '    });',
].join('\n');

const newEndpoint = [
    '    // Compact conversation \u2014 delegates to shared compactConversation helper',
    '    server.post(\'/api/conversations/:id/compact\', async (req, res) => {',
    '        try {',
    '            const result = await compactConversation(req.params.id, {',
    '                apiKey: req.body.env_token,',
    '                baseUrl: req.body.env_base_url,',
    '                instruction: req.body.instruction,',
    '            });',
    '            res.json(result);',
    '        } catch (err) {',
    '            console.error(\'[Compact] Error:\', err);',
    '            res.status(500).json({ error: err.message || \'Compaction failed\' });',
    '        }',
    '    });',
].join('\n');

const oldEndpointIdx = content.indexOf(oldEndpointFull);
if (oldEndpointIdx === -1) {
    console.log('ERROR: Could not find compact endpoint for Edit 2');
    process.exit(1);
}
content = content.substring(0, oldEndpointIdx) + newEndpoint + content.substring(oldEndpointIdx + oldEndpointFull.length);
console.log('Edit 2: Compact endpoint refactored to thin wrapper');

// ===== Change 3: Add auto-compaction check after endStream in chat endpoint =====
const endStreamCall = '            endStream(conversation_id);\n        } catch (err) {';

const autoCompactInsert = [
    '            endStream(conversation_id);',
    '            // -- Auto-compaction check --',
    '            if (conv && conv.simona_session_id) {',
    '                // Estimate total tokens for this conversation',
    '                const convMessages = db.messages.filter(m => m.conversation_id === conversation_id);',
    '                let totalTokens = 0;',
    '                for (const msg of convMessages) {',
    '                    try {',
    '                        const c = typeof msg.content === \'string\' ? msg.content : JSON.stringify(msg.content);',
    '                        totalTokens += Math.ceil(c.length / 4);',
    '                    } catch (_) {}',
    '                }',
    '                if (totalTokens >= 1000000) {',
    '                    console.log(\'[AutoCompact] Token threshold reached (\' + totalTokens + \' >= 1000000), auto-compacting conversation \' + conversation_id);',
    '                    compactConversation(conversation_id, { apiKey: apiKey, baseUrl: baseUrl }).catch(err => {',
    '                        console.error(\'[AutoCompact] Error:\', err.message);',
    '                    });',
    '                }',
    '            }',
    '        } catch (err) {',
].join('\n');

if (content.includes('Auto-compaction check')) {
    console.log('Edit 3: Auto-compaction already exists, skipping');
} else {
    const autoIdx = content.indexOf(endStreamCall);
    if (autoIdx === -1) {
        console.log('ERROR: Could not find endStream call for Edit 3');
        process.exit(1);
    }
    content = content.substring(0, autoIdx) + autoCompactInsert + content.substring(autoIdx + endStreamCall.length);
    console.log('Edit 3: Auto-compaction check added');
}

// Write the modified file
fs.writeFileSync(path, content, 'utf8');
console.log('All edits applied successfully!');