import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cron from 'node-cron';
import {
  buildObjectMemoryRouter,
  runDailyRecap as runObjectMemoryRecap,
} from './skills/object-memory/routes';
import { buildShoppingCartRouter } from './skills/shopping-cart/routes';
import { inventoryStatus } from './shared/inventory';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Per-skill config (fall back to legacy TRACE_* names to keep old .env files working).
const OBJECT_MEMORY = {
  slug: 'object-memory',
  hmacSecret:
    process.env.OBJECT_MEMORY_HMAC_SECRET || process.env.TRACE_HMAC_SECRET || '',
  skillId:
    process.env.OBJECT_MEMORY_SKILL_ID || process.env.TRACE_SKILL_ID || '',
};
const SHOPPING_CART = {
  slug: 'shopping-cart',
  hmacSecret: process.env.SHOPPING_CART_HMAC_SECRET || '',
  skillId: process.env.SHOPPING_CART_SKILL_ID || '',
};

app.use(bodyParser.json({ limit: '2mb' }));

// ─── Mount skills ─────────────────────────────────────────────────────────
app.use(`/${OBJECT_MEMORY.slug}`, buildObjectMemoryRouter(OBJECT_MEMORY));
app.use(`/${SHOPPING_CART.slug}`, buildShoppingCartRouter(SHOPPING_CART));

// ─── Cron registration ───────────────────────────────────────────────────
const DAILY_RECAP_CRON = process.env.DAILY_RECAP_CRON || '0 21 * * *';
const DAILY_RECAP_TZ = process.env.DAILY_RECAP_TZ || 'Asia/Kolkata';
const DAILY_RECAP_ENABLED = process.env.DAILY_RECAP_ENABLED !== '0';

if (DAILY_RECAP_ENABLED) {
  if (!cron.validate(DAILY_RECAP_CRON)) {
    console.warn(`[cron] invalid expression "${DAILY_RECAP_CRON}" — disabled`);
  } else {
    cron.schedule(
      DAILY_RECAP_CRON,
      () => {
        runObjectMemoryRecap(OBJECT_MEMORY.skillId, OBJECT_MEMORY.hmacSecret).catch((e) =>
          console.error('[cron:object-memory-recap] failed:', e),
        );
      },
      { timezone: DAILY_RECAP_TZ },
    );
    console.log(`[cron] object-memory recap scheduled "${DAILY_RECAP_CRON}" tz=${DAILY_RECAP_TZ}`);
  }
}

// ─── Admin (manual recap trigger, used for demo + QA) ────────────────────
app.post('/admin/run-recap/object-memory', (req: Request, res: Response) => {
  if (req.headers['x-admin-secret'] !== OBJECT_MEMORY.hmacSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  runObjectMemoryRecap(OBJECT_MEMORY.skillId, OBJECT_MEMORY.hmacSecret).catch((e) =>
    console.error('[recap] failed:', e),
  );
  res.json({ ok: true, queued: true });
});

// ─── Health / root ───────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    skills: ['object-memory', 'shopping-cart'],
    semantic: process.env.DISABLE_SEMANTIC !== '1',
    inventory: inventoryStatus(),
  });
});

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    [
      'Trace Skills host',
      '',
      'Mounted skills:',
      '  - POST /object-memory/webhook',
      '  - POST /object-memory/mcp',
      '  - POST /object-memory/delete-user',
      '  - POST /shopping-cart/webhook',
      '  - POST /shopping-cart/mcp',
      '  - POST /shopping-cart/delete-user',
      '',
    ].join('\n'),
  );
});

app.listen(PORT, () => {
  console.log(`🚀 Trace skills host on :${PORT}`);
  console.log(`   mounted: /${OBJECT_MEMORY.slug}, /${SHOPPING_CART.slug}`);
});
