/**
 * Hierarchical Cluster Endpoint for Bridge Server
 * 
 * Implements master-worker pattern:
 * 1. Master agent decomposes tasks
 * 2. Worker agents execute subtasks with custom system prompts
 * 3. Master agent synthesizes results
 */

const { runHierarchicalCluster } = require('./hierarchical-agent');

module.exports = function setupHierarchicalEndpoint(server, db, saveDb, generateTitleAsync, endStream, activeStreams) {
    
    server.post('/api/hierarchical-cluster', async (req, res) => {
        const { 
            conversation_id, 
            message,
            master_agent,      // User's selected model
            worker_agents,     // List of specialized agents
            conversation_id: sessionId
        } = req.body;

        const conv = db.conversations.find(c => c.id === conversation_id);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        if (!master_agent || !worker_agents || worker_agents.length === 0) {
            return res.status(400).json({ error: 'Invalid hierarchical configuration' });
        }

        // Set up SSE streaming
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        const sendSSE = (data) => {
            try { 
                res.write('data: ' + JSON.stringify(data) + '\n\n'); 
                // Force flush to ensure immediate delivery for real-time streaming
                if (res.flush) res.flush();
            } catch (_) {}
        };

        try {
            console.log('[Hierarchical] Starting hierarchical cluster with master:', master_agent.modelId);
            console.log('[Hierarchical] Worker agents:', worker_agents.map(a => a.name).join(', '));
            
            sendSSE({ 
                type: 'hierarchical_start', 
                master_model: master_agent.modelId,
                worker_count: worker_agents.length
            });

            // Phase 1: Task decomposition notification
            sendSSE({ type: 'phase_start', phase: 'decomposition' });

            // Execute hierarchical cluster
            const result = await runHierarchicalCluster({
                masterAgent: {
                    name: 'master',
                    modelId: master_agent.modelId
                },
                workerAgents: worker_agents.map(agent => ({
                    name: agent.name,
                    modelId: agent.modelId,
                    systemPrompt: agent.systemPrompt
                })),
                message: message,
                conversation_id: sessionId
            });

            // Send decomposition results
            sendSSE({ 
                type: 'phase_complete', 
                phase: 'decomposition',
                subtask_count: result.subtasks.length,
                subtasks: result.subtasks
            });

            // Send worker execution progress
            sendSSE({ type: 'phase_start', phase: 'execution' });
            for (let i = 0; i < result.workerResults.length; i++) {
                const workerResult = result.workerResults[i];
                sendSSE({
                    type: 'worker_complete',
                    worker_index: i + 1,
                    worker_name: workerResult.agent,
                    subtask: workerResult.subtask,
                    result_preview: workerResult.result.slice(0, 200)
                });
            }
            sendSSE({ 
                type: 'phase_complete', 
                phase: 'execution',
                worker_count: result.workerResults.length
            });

            // Send synthesis phase
            sendSSE({ type: 'phase_start', phase: 'synthesis' });

            // Send final answer
            console.log('[Hierarchical] Sending final synthesized answer');
            sendSSE({ 
                type: 'hierarchical_complete', 
                final_answer: result.finalAnswer,
                subtasks: result.subtasks,
                worker_results_count: result.workerResults.length
            });
            
            sendSSE({ type: 'content_block_delta', delta: { type: 'text_delta', text: result.finalAnswer } });
            sendSSE({ type: 'message_stop' });

            // Save to conversation
            const userMessageId = 'msg-' + Date.now();
            db.messages.push({
                id: userMessageId,
                role: 'user',
                content: message,
                conversation_id: conversation_id,
                created_at: new Date().toISOString(),
            });
            
            db.messages.push({
                id: 'msg-' + (Date.now() + 1),
                role: 'assistant',
                content: result.finalAnswer,
                conversation_id: conversation_id,
                created_at: new Date().toISOString(),
                metadata: {
                    hierarchical_mode: true,
                    master_model: master_agent.modelId,
                    worker_count: worker_agents.length,
                    subtask_count: result.subtasks.length
                }
            });
            saveDb();

            // Generate title if first message
            const userMessages = db.messages.filter(m => m.conversation_id === conversation_id && m.role === 'user');
            if (userMessages.length === 1) {
                console.log('[Hierarchical] First message detected, generating title...');
                // Note: Need to pass API credentials for title generation
                // For now, skip or implement separately
            }

            res.end();

        } catch (error) {
            console.error('[Hierarchical] Error:', error);
            sendSSE({ type: 'error', error: error.message });
            res.end();
        }
    });

    console.log('[Hierarchical] Endpoint registered at /api/hierarchical-cluster');
};
