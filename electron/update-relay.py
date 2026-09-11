# relay-server Hotfix (upload to server and run when relay code changes)
import re

with open('/opt/relay-server.js', 'r') as f:
    c = f.read()

# 1. Crash protection
if 'uncaughtException' not in c:
    ph = """process.on('uncaughtException', (err) => { console.error('[Relay] UNCAUGHT:', err.message); });
process.on('unhandledRejection', (err) => { console.error('[Relay] UNHANDLED REJECTION:', err.message); });
"""
    c = c.replace('const RELAY_PORT = 30090;', ph + 'const RELAY_PORT = 30090;')

# 2. Path fix (preserve /api/ prefix)
c = c.replace(
    "return proxyRequest(req, res, uid, did, '/' + nonAgentApi[1]);",
    'return proxyRequest(req, res, uid, did, req.url);'
)

# 3. Streaming support (backward compat with streaming:true flag)
old_hr = """    case 'http_response': {
      const pending = session.pendingRequests.get(message.reqId);
      if (pending) {
        clearTimeout(pending.timer);
        session.pendingRequests.delete(message.reqId);
        const headers = { ...(message.headers || {}), 'Access-Control-Allow-Origin': '*' };
        delete headers['transfer-encoding'];
        if (!pending.res.writableEnded) {
          pending.res.writeHead(message.status || 200, headers);
          pending.res.end(message.body || '');
        }
      }
      break;
    }"""

new_hr = """    case 'http_response': {
      const p = session.pendingRequests.get(message.reqId);
      if (p) {
        clearTimeout(p.timer);
        const headers = { ...(message.headers || {}), 'Access-Control-Allow-Origin': '*' };
        delete headers['transfer-encoding'];
        if (message.streaming) {
          try { if (!p.res.writableEnded) { p.res.writeHead(message.status || 200, headers); p.res.write(message.body || ''); } } catch(e) { console.error('[Relay] write err:', e.message); session.pendingRequests.delete(message.reqId); }
        } else {
          session.pendingRequests.delete(message.reqId);
          try { if (!p.res.writableEnded) { p.res.writeHead(message.status || 200, headers); p.res.end(message.body || ''); } } catch(e) { console.error('[Relay] write err:', e.message); }
        }
      }
      break;
    }
    case 'http_response_chunk': {
      const p2 = session.pendingRequests.get(message.reqId);
      if (p2) {
        clearTimeout(p2.timer);
        p2.timer = setTimeout(() => { const p3 = session.pendingRequests.get(message.reqId); if (p3) { session.pendingRequests.delete(message.reqId); try { if (!p3.res.writableEnded) { p3.res.writeHead(504,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); p3.res.end(JSON.stringify({error:'Agent response timeout'})); } } catch(e) {} } }, HTTP_TIMEOUT);
        try { if (!p2.res.writableEnded) p2.res.write(message.body || ''); } catch(e) { console.error('[Relay] chunk write err:', e.message); }
      }
      break;
    }
    case 'http_response_end': {
      const p4 = session.pendingRequests.get(message.reqId);
      if (p4) {
        clearTimeout(p4.timer);
        session.pendingRequests.delete(message.reqId);
        try { if (!p4.res.writableEnded) p4.res.end(); } catch(e) { console.error('[Relay] end err:', e.message); }
      }
      break;
    }"""

c = c.replace(old_hr, new_hr)

# 4. Add res.on('error') in proxyRequest
old_pr = """  res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Agent not connected', deviceId })); return;
  }

  const reqId = generateId();"""

new_pr = """  res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Agent not connected', deviceId })); return;
  }
  res.on('error', (e) => { console.error('[Relay] res error:', e.message); });
  const reqId = generateId();"""

c = c.replace(old_pr, new_pr)

# 5. Add SIGTERM handler if not present
if 'SIGTERM' not in c:
    sigterm = """
process.on('SIGTERM', () => {
  wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
  server.close(() => process.exit(0));
});"""
    c = c.replace("console.log('Relay server running on port ' + RELAY_PORT);", "console.log('Relay server running on port ' + RELAY_PORT);" + sigterm)

with open('/opt/relay-server.js', 'w') as f:
    f.write(c)
print('relay-server.js updated OK')
