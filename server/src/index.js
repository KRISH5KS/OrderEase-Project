import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { initDb, all, one, run, transaction } from './db.js';
import { calculateLine } from './schemes.js';
import { extractOrder, extractOrderFromImage, transcribeOrderAudio, saveAlias } from './ai.js';

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '25mb' }));
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) throw new Error('Set a strong JWT_SECRET (at least 32 characters) in production.');
const secret = process.env.JWT_SECRET || 'local-demo-secret-change-me';
const twilioReady = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SERVICE_SID);
const twilioAuth = () => 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
const otpWindows = new Map();
function otpRateLimit(req,res,next){const key=`${req.ip}:${String(req.body.phone||'')}`;const now=Date.now();const recent=(otpWindows.get(key)||[]).filter(t=>now-t<15*60*1000);if(recent.length>=5)return res.status(429).json({error:'Too many OTP attempts. Wait 15 minutes and try again.'});recent.push(now);otpWindows.set(key,recent);next();}
const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const auth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { req.user = jwt.verify(token, secret); next(); }
  catch { res.status(401).json({ error: 'Please sign in again.' }); }
};
const roles = (...allowed) => (req, res, next) => allowed.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have permission to do this.' });
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function retailerFor(req, requested) {
  if (req.user.role === 'retailer') {
    if (requested && Number(requested) !== Number(req.user.retailer_id)) throw new Error('You can only access your own retailer account.');
    return Number(req.user.retailer_id);
  }
  if (req.user.role === 'salesman') {
    const id = Number(requested);
    if (!id || !one('SELECT 1 ok FROM salesman_assignments WHERE salesman_id=? AND retailer_id=?', [req.user.id, id])) throw new Error('Choose a retailer assigned to you.');
    return id;
  }
  return Number(requested || 1);
}
function productForRetailer(retailerId, sku) {
  return one(`SELECT p.*, COALESCE(rp.price,p.price) retailer_price, s.type scheme_type, s.threshold scheme_threshold, s.value scheme_value, s.label scheme_label
    FROM products p LEFT JOIN retailer_prices rp ON rp.product_id=p.id AND rp.retailer_id=?
    LEFT JOIN schemes s ON s.product_id=p.id WHERE p.sku=?`, [retailerId, sku]);
}
function createOrder({ retailerId, userId, items, source, clientOrderId }) {
  if (clientOrderId) { const existing = one('SELECT id,status,total,subtotal,discount,gst FROM orders WHERE client_order_id=? AND retailer_id=?', [clientOrderId, retailerId]); if (existing) return { orderId: existing.id, status: existing.status, total: existing.total, subtotal: existing.subtotal, discount: existing.discount, gst: existing.gst, duplicate: true }; }
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('Add between 1 and 100 order lines.');
  const credit = one('SELECT * FROM retailer_credit WHERE retailer_id=?', [retailerId]);
  let subtotal = 0, discount = 0;
  const calculated = items.map(line => {
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) throw new Error('Quantity must be a whole number between 1 and 500 cases.');
    const p = productForRetailer(retailerId, String(line.sku || ''));
    if (!p) throw new Error(`Unknown product ${line.sku || ''}.`);
    if (p.stock_cases <= 0) throw new Error(`${p.name} is out of stock.`);
    const calc = calculateLine({ quantity, price: p.retailer_price, scheme: p.scheme_type ? { type: p.scheme_type, threshold: p.scheme_threshold, value: p.scheme_value } : null });
    if (quantity + calc.freeQuantity > p.stock_cases) throw new Error(`${p.name}: ${p.stock_cases} cases in stock, but ${quantity + calc.freeQuantity} including free goods are required.`);
    subtotal += calc.gross; discount += calc.discount;
    return { p, quantity, calc, original: String(line.original || '') };
  });
  subtotal = money(subtotal); discount = money(discount);
  const total = money(subtotal - discount);
  const hold = Boolean(credit && Number(credit.outstanding) + total > Number(credit.limit_amount));
  const id = transaction(() => {
    run('INSERT INTO orders(retailer_id,created_by,status,subtotal,discount,gst,total,source,credit_hold,client_order_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [retailerId, userId, hold ? 'credit_hold' : 'pending_review', subtotal, discount, 0, total, source || 'catalogue', hold ? 1 : 0, clientOrderId || null]);
    const orderId = one('SELECT last_insert_rowid() id').id;
    for (const x of calculated) run('INSERT INTO order_items(order_id,product_id,quantity,free_quantity,unit_price,line_total,original_text) VALUES(?,?,?,?,?,?,?)',
      [orderId, x.p.id, x.quantity, x.calc.freeQuantity, x.p.retailer_price, x.calc.total, x.original]);
    return orderId;
  });
  return { orderId: id, status: hold ? 'credit_hold' : 'pending_review', subtotal, discount, gst: 0, total };
}

app.get('/api/health', (_, res) => res.json({ ok: true, service: 'OrderEase API' }));
app.post('/api/auth/otp', otpRateLimit, asyncRoute(async (req, res) => {
  const phone = String(req.body.phone || '').trim();
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit phone number.' });
  const user = one('SELECT id,name,phone,role,retailer_id FROM users WHERE phone=?', [phone]);
  if (!user) return res.status(404).json({ error: 'Phone not found in demo users.' });
  if (twilioReady) {
    const body = new URLSearchParams({ To: `${process.env.DEFAULT_COUNTRY_CODE || '+91'}${phone}`, Channel: 'sms' });
    const response = await fetch(`https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/Verifications`, { method: 'POST', headers: { Authorization: twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) return res.status(502).json({ error: 'Could not send OTP. Try again shortly.' });
    return res.json({ message: 'OTP sent by SMS.' });
  }
  if (process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'OTP provider is not configured.' });
  res.json({ message: 'Demo OTP generated. Use 123456.', demoOtp: process.env.DEMO_OTP || '123456' });
}));
app.post('/api/auth/verify', asyncRoute(async (req, res) => {
  const phone = String(req.body.phone || '').trim();
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit phone number.' });
  const user = one('SELECT id,name,phone,role,retailer_id FROM users WHERE phone=?', [phone]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (twilioReady) {
    const body = new URLSearchParams({ To: `${process.env.DEFAULT_COUNTRY_CODE || '+91'}${phone}`, Code: String(req.body.otp || '') });
    const response = await fetch(`https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`, { method: 'POST', headers: { Authorization: twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const result = await response.json(); if (!response.ok || result.status !== 'approved') return res.status(400).json({ error: 'Invalid or expired OTP.' });
  } else if (process.env.NODE_ENV === 'production' || String(req.body.otp || '') !== (process.env.DEMO_OTP || '123456')) return res.status(400).json({ error: 'Invalid demo OTP.' });
  res.json({ token: jwt.sign(user, secret, { expiresIn: '12h' }), user });
}));
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));
app.get('/api/retailers', auth, roles('salesman','desk'), (req, res) => {
  const retailers = req.user.role === 'desk'
    ? all("SELECT u.retailer_id id,u.name,u.phone FROM users u WHERE u.role='retailer' ORDER BY u.name")
    : all('SELECT u.retailer_id id,u.name,u.phone FROM users u JOIN salesman_assignments a ON a.retailer_id=u.retailer_id WHERE a.salesman_id=? ORDER BY u.name', [req.user.id]);
  res.json({ retailers });
});
app.get('/api/catalogue', auth, (req, res) => {
  try {
    const retailerId = req.user.role === 'desk' ? Number(req.query.retailerId || 1) : retailerFor(req, req.query.retailerId);
    const products = all(`SELECT p.*,s.type scheme_type,s.threshold scheme_threshold,s.value scheme_value,s.label scheme_label,COALESCE(rp.price,p.price) retailer_price
      FROM products p LEFT JOIN schemes s ON s.product_id=p.id LEFT JOIN retailer_prices rp ON rp.product_id=p.id AND rp.retailer_id=? ORDER BY p.id`, [retailerId]);
    res.json({ retailerId, products: products.map(p => ({ ...p, available: p.stock_cases > 0, gst_included: true })) });
  } catch (e) { res.status(403).json({ error: e.message }); }
});
app.get('/api/credit', auth, roles('retailer','salesman','desk'), (req, res) => {
  try {
    const id = retailerFor(req, req.query.retailerId);
    res.json(one('SELECT * FROM retailer_credit WHERE retailer_id=?', [id]) || { limit_amount: 0, outstanding: 0 });
  } catch (e) { res.status(403).json({ error: e.message }); }
});
app.get('/api/orders', auth, (req, res) => {
  if (req.user.role === 'desk') return res.status(403).json({ error: 'Use the order desk queue.' });
  try {
    const id = req.user.role === 'retailer' ? req.user.retailer_id : retailerFor(req, req.query.retailerId);
    res.json({ orders: all('SELECT * FROM orders WHERE retailer_id=? ORDER BY id DESC', [id]) });
  } catch (e) { res.status(403).json({ error: e.message }); }
});
app.post('/api/orders', auth, roles('retailer','salesman'), (req, res) => {
  try {
    const retailerId = retailerFor(req, req.body.retailerId);
    res.status(201).json(createOrder({ retailerId, userId: req.user.id, items: req.body.items, source: req.body.source || 'catalogue' }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/orders/:id/repeat', auth, roles('retailer','salesman'), (req, res) => {
  try {
    const retailerId = retailerFor(req, req.body.retailerId);
    const previous = one('SELECT * FROM orders WHERE id=? AND retailer_id=?', [Number(req.params.id), retailerId]);
    if (!previous) return res.status(404).json({ error: 'Order not found for this retailer.' });
    const items = all('SELECT p.sku,oi.quantity FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?', [previous.id]);
    res.status(201).json(createOrder({ retailerId, userId: req.user.id, items, source: 'repeat_order' }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/orders/sync', auth, roles('salesman'), (req, res) => {
  try {
    const queue = req.body.orders;
    if (!Array.isArray(queue) || queue.length > 50) throw new Error('Sync up to 50 offline orders at a time.');
    const results = queue.map((o, i) => {
      try { const retailerId = retailerFor(req, o.retailerId); return { localId: o.localId, ...createOrder({ retailerId, userId: req.user.id, items: o.items, source: 'offline_salesman', clientOrderId: o.localId }) }; }
      catch (e) { return { localId: o.localId, error: e.message }; }
    });
    res.json({ results });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/ai/parse', auth, roles('retailer','salesman'), asyncRoute(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text || text.length > 4000) return res.status(400).json({ error: 'Enter an order message up to 4,000 characters.' });
  const retailerId = req.user.role === 'retailer' ? req.user.retailer_id : retailerFor(req, req.body.retailerId);
  res.json(await extractOrder(text, retailerId));
}));
app.post('/api/ai/parse-image', auth, roles('retailer','salesman'), asyncRoute(async (req, res) => {
  const retailerId = req.user.role === 'retailer' ? req.user.retailer_id : retailerFor(req, req.body.retailerId);
  const dataUrl = String(req.body.imageDataUrl || ''); if (dataUrl.length > 12 * 1024 * 1024) return res.status(413).json({ error: 'Image is too large. Use an image under 8 MB.' });
  try { res.json(await extractOrderFromImage(dataUrl, retailerId)); } catch(e) { if (!process.env.AI_API_KEY) return res.status(503).json({error:e.message}); throw e; }
}));
app.post('/api/ai/parse-audio', auth, roles('retailer','salesman'), asyncRoute(async (req, res) => {
  const retailerId = req.user.role === 'retailer' ? req.user.retailer_id : retailerFor(req, req.body.retailerId);
  let text; try { text = await transcribeOrderAudio(String(req.body.audioBase64 || ''), String(req.body.mimeType || ''), String(req.body.filename || 'voice-note.webm')); } catch(e) { if (!process.env.AI_API_KEY) return res.status(503).json({error:e.message}); throw e; }
  res.json({ text, ...(await extractOrder(text, retailerId)) });
}));
app.post('/api/ai/confirm', auth, roles('retailer','salesman'), (req, res) => {
  try {
    const retailerId = req.user.role === 'retailer' ? req.user.retailer_id : retailerFor(req, req.body.retailerId);
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) throw new Error('No confirmed items.');
    for (const item of items) {
      if (!item.sku || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1 || item.unit !== 'case' || item.needs_clarification) throw new Error('Resolve every unclear item and confirm case units before placing the order.');
    }
    const result = createOrder({ retailerId, userId: req.user.id, items, source: 'ai' });
    for (const item of items) if (item.original && item.sku) saveAlias(retailerId, item.original, item.sku);
    res.status(201).json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/desk/retailer-credit', auth, roles('desk'), (req, res) => res.json({ accounts: all(`SELECT u.retailer_id id,u.name,u.phone,COALESCE(c.limit_amount,0) limit_amount,COALESCE(c.outstanding,0) outstanding FROM users u LEFT JOIN retailer_credit c ON c.retailer_id=u.retailer_id WHERE u.role='retailer' ORDER BY u.name`) }));
app.patch('/api/desk/retailers/:id/credit', auth, roles('desk'), (req, res) => {
  const id = Number(req.params.id), limit = Number(req.body.limit_amount), outstanding = Number(req.body.outstanding);
  if (!Number.isFinite(limit) || limit < 0 || !Number.isFinite(outstanding) || outstanding < 0 || outstanding > limit) return res.status(400).json({ error: 'Enter valid non-negative credit values; outstanding cannot exceed the limit.' });
  if (!one('SELECT 1 ok FROM users WHERE role=\'retailer\' AND retailer_id=?', [id])) return res.status(404).json({ error: 'Retailer not found.' });
  run('INSERT OR REPLACE INTO retailer_credit(retailer_id,limit_amount,outstanding) VALUES(?,?,?)', [id, limit, outstanding]);
  res.json({ ok: true });
});
app.get('/api/desk/orders', auth, roles('desk'), (req, res) => res.json({ orders: all(`SELECT o.*,u.name retailer_name,u.phone retailer_phone FROM orders o JOIN users u ON u.retailer_id=o.retailer_id ORDER BY o.id DESC`) }));
app.get('/api/desk/orders/:id/items', auth, roles('desk'), (req, res) => res.json({ items: all('SELECT oi.*,p.sku,p.name,p.unit FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?', [Number(req.params.id)]) }));
app.patch('/api/desk/orders/:id/items/:itemId', auth, roles('desk'), (req, res) => {
  try {
    const orderId=Number(req.params.id), itemId=Number(req.params.itemId), order=one('SELECT * FROM orders WHERE id=?',[orderId]);
    if(!order) return res.status(404).json({error:'Order not found.'});
    if(!['pending_review','credit_hold'].includes(order.status)) return res.status(409).json({error:'Only unconfirmed orders can be corrected.'});
    const old=one('SELECT * FROM order_items WHERE id=? AND order_id=?',[itemId,orderId]); if(!old) return res.status(404).json({error:'Order line not found.'});
    const sku=String(req.body.sku||''); const p=productForRetailer(order.retailer_id,sku); if(!p) throw new Error('Choose a valid SKU.');
    const quantity=Number(req.body.quantity??old.quantity); if(!Number.isInteger(quantity)||quantity<1||quantity>500) throw new Error('Quantity must be 1–500 cases.');
    const calc=calculateLine({quantity,price:p.retailer_price,scheme:p.scheme_type?{type:p.scheme_type,threshold:p.scheme_threshold,value:p.scheme_value}:null});
    if(p.stock_cases<quantity+calc.freeQuantity) throw new Error(`Insufficient stock; ${p.stock_cases} cases available.`);
    transaction(()=>{run('UPDATE order_items SET product_id=?,quantity=?,free_quantity=?,unit_price=?,line_total=? WHERE id=?',[p.id,quantity,calc.freeQuantity,p.retailer_price,calc.total,itemId]);
      const lines=all('SELECT quantity,unit_price,line_total FROM order_items WHERE order_id=?',[orderId]); const subtotal=money(lines.reduce((a,x)=>a+x.quantity*x.unit_price,0)); const total=money(lines.reduce((a,x)=>a+x.line_total,0));
      const hold=one('SELECT outstanding+? > limit_amount hold FROM retailer_credit WHERE retailer_id=?',[total,order.retailer_id])?.hold?1:0;
      run("UPDATE orders SET subtotal=?,discount=?,total=?,credit_hold=?,status=CASE WHEN ?=1 AND status='pending_review' THEN 'credit_hold' ELSE status END WHERE id=?",[subtotal,money(subtotal-total),total,hold,hold,orderId]);
      if(old.original_text) saveAlias(order.retailer_id,old.original_text,sku);
    });
    res.json({ok:true,sku,quantity,aliasSaved:Boolean(old.original_text)});
  } catch(e) { res.status(400).json({error:e.message}); }
});
app.patch('/api/desk/orders/:id/status', auth, roles('desk'), (req, res) => {
  const id = Number(req.params.id), status = String(req.body.status || '');
  const order = one('SELECT * FROM orders WHERE id=?', [id]);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (!['confirmed','rejected'].includes(status)) return res.status(400).json({ error: 'Desk can confirm or reject an order.' });
  if (order.status === 'confirmed') return res.status(409).json({ error: 'This order is already confirmed.' });
  if (order.status === 'rejected') return res.status(409).json({ error: 'This order was already rejected.' });
  try {
    transaction(() => {
      if (status === 'confirmed') {
        const credit = one('SELECT * FROM retailer_credit WHERE retailer_id=?', [order.retailer_id]);
        if (credit && Number(credit.outstanding) + Number(order.total) > Number(credit.limit_amount)) throw new Error('Credit limit still exceeded. Increase the limit or collect payment before confirming.');
        const lines = all('SELECT product_id,quantity,free_quantity FROM order_items WHERE order_id=?', [id]);
        for (const line of lines) {
          const p = one('SELECT stock_cases,name FROM products WHERE id=?', [line.product_id]);
          if (p.stock_cases < line.quantity + line.free_quantity) throw new Error(`${p.name}: insufficient stock for paid and free cases.`);
        }
        for (const line of lines) run('UPDATE products SET stock_cases=stock_cases-? WHERE id=?', [line.quantity + line.free_quantity, line.product_id]);
        if (credit) run('UPDATE retailer_credit SET outstanding=outstanding+? WHERE retailer_id=?', [order.total, order.retailer_id]);
      }
      run('UPDATE orders SET status=?,credit_hold=? WHERE id=?', [status, status === 'credit_hold' ? 1 : 0, id]);
    });
    res.json({ ok: true, status });
  } catch (e) { res.status(409).json({ error: e.message }); }
});
app.get('/api/desk/export.csv', auth, roles('desk'), (req, res) => {
  const rows = all(`SELECT o.id order_id,o.created_at,u.name retailer,p.sku,p.name product,oi.quantity,oi.free_quantity,oi.unit_price,oi.line_total,o.status
    FROM orders o JOIN users u ON u.retailer_id=o.retailer_id JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id WHERE o.status='confirmed' ORDER BY o.id`);
  const csv = ['Order ID,Created At,Retailer,SKU,Product,Qty Cases,Free Cases,Unit Price,Line Total,Status', ...rows.map(r => [r.order_id,r.created_at,r.retailer,r.sku,r.product,r.quantity,r.free_quantity,r.unit_price,r.line_total,r.status].map(v => `"${String(v ?? '').replaceAll('"','""')}"`).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="tally-orders-export.csv"'); res.send('\uFEFF' + csv);
});
app.get('/api/desk/van-loading', auth, roles('desk'), (req, res) => {
  const rows = all(`SELECT p.sku,p.name,p.unit,SUM(oi.quantity+oi.free_quantity) total_cases,SUM(oi.quantity) paid_cases,SUM(oi.free_quantity) free_cases,COUNT(DISTINCT o.id) order_count
    FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id WHERE o.status='confirmed' AND o.loaded=0 GROUP BY p.id ORDER BY p.name`);
  res.json({ items: rows });
});
app.post('/api/desk/van-loading/mark-loaded', auth, roles('desk'), (req, res) => {
  const ids = Array.isArray(req.body.orderIds) ? req.body.orderIds.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'Select at least one confirmed order.' });
  const placeholders = ids.map(() => '?').join(',');
  run(`UPDATE orders SET loaded=1 WHERE status='confirmed' AND id IN (${placeholders})`, ids);
  res.json({ ok: true, updated: ids.length });
});
app.get('/api/desk/inactive-retailers', auth, roles('desk'), (req, res) => res.json({ retailers: all(`SELECT u.retailer_id id,u.name,u.phone,MAX(o.created_at) last_order,
  CASE WHEN MAX(o.created_at) IS NULL THEN NULL ELSE CAST(julianday('now')-julianday(MAX(o.created_at)) AS INTEGER) END days_inactive
  FROM users u LEFT JOIN orders o ON o.retailer_id=u.retailer_id WHERE u.role='retailer' GROUP BY u.retailer_id
  HAVING last_order IS NULL OR julianday('now')-julianday(last_order)>=14 ORDER BY days_inactive DESC`) }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Unexpected server error. Please try again.' }); });
const port = Number(process.env.PORT || 5000);
await initDb();
app.listen(port, () => console.log(`OrderEase API running on http://localhost:${port}`));
