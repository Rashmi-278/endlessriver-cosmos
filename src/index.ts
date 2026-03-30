import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { verifyTraceSignature } from './hmac';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const HMAC_SECRET = process.env.TRACE_HMAC_SECRET || '';

app.use(bodyParser.json());

// ─── 🟢 Webhook Endpoint ──────────────────────────────────────────────────────
// Used for processing background events like photos or audio.
app.post('/webhook', verifyTraceSignature(HMAC_SECRET), async (req: Request, res: Response) => {
  const { event, user, request_id } = req.body;
  console.log(`[Webhook] Received ${event.channel} for user ${user.id}`);

  // Example: Respond immediately (Sync)
  res.status(200).json({
    status: 'success',
    responses: [
      {
        type: 'notification',
        content: {
          title: 'Hello from Template!',
          body: `I received your ${event.channel} event.`
        }
      }
    ]
  });
});

// ─── 🔵 MCP (JSON-RPC) Endpoint ──────────────────────────────────────────────
// Used for dialog turns (voice queries).
app.post('/mcp', async (req: Request, res: Response) => {
  const { jsonrpc, method, params, id } = req.body;
  if (jsonrpc !== '2.0') return res.status(400).send('Invalid JSON-RPC');

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'handle_dialog',
            description: 'My main dialog tool.',
            inputSchema: {
              type: 'object',
              properties: {
                utterance: { type: 'string' }
              }
            }
          }
        ]
      }
    });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'handle_dialog') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            { type: 'text', text: `You said: ${args.utterance}` },
            {
              type: 'embedded_responses',
              responses: [
                { type: 'feed_item', content: { title: 'Dialog Handled', story: args.utterance } }
              ]
            }
          ]
        }
      });
    }
  }

  res.status(404).json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

// ─── Lifecycle / Deletion ────────────────────────────────────────────────────
app.post('/delete-user', (req: Request, res: Response) => {
  const { user_id } = req.body;
  console.log(`[Cleanup] Deleting data for user ${user_id}`);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Skill template running at http://localhost:${PORT}`);
});
