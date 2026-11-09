import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve('data');
const dbPath = path.join(dataDir, 'orderease.sqlite');
let db;
let inTransaction = false;

export async function initDb() {
  const SQL = await initSqlJs();
  fs.mkdirSync(dataDir, { recursive: true });
  db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  db.run(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('retailer','desk','salesman')), retailer_id INTEGER, password_hint TEXT);
    CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, price REAL NOT NULL, stock_cases INTEGER NOT NULL, image TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schemes(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, type TEXT NOT NULL, threshold INTEGER NOT NULL, value REAL NOT NULL, label TEXT NOT NULL, FOREIGN KEY(product_id) REFERENCES products(id));
    CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT, retailer_id INTEGER NOT NULL, created_by INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending_review', subtotal REAL NOT NULL, discount REAL NOT NULL, gst REAL NOT NULL, total REAL NOT NULL, source TEXT NOT NULL DEFAULT 'catalogue', credit_hold INTEGER NOT NULL DEFAULT 0, loaded INTEGER NOT NULL DEFAULT 0, client_order_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, free_quantity INTEGER NOT NULL DEFAULT 0, unit_price REAL NOT NULL, line_total REAL NOT NULL, original_text TEXT, FOREIGN KEY(order_id) REFERENCES orders(id), FOREIGN KEY(product_id) REFERENCES products(id));
    CREATE TABLE IF NOT EXISTS aliases(id INTEGER PRIMARY KEY AUTOINCREMENT, retailer_id INTEGER NOT NULL, phrase TEXT NOT NULL, product_id INTEGER NOT NULL, UNIQUE(retailer_id, phrase), FOREIGN KEY(product_id) REFERENCES products(id));
    CREATE TABLE IF NOT EXISTS salesman_assignments(salesman_id INTEGER NOT NULL, retailer_id INTEGER NOT NULL, PRIMARY KEY(salesman_id,retailer_id));`);
  try { db.run('ALTER TABLE orders ADD COLUMN loaded INTEGER NOT NULL DEFAULT 0'); } catch { /* existing database already migrated */ }
  try { db.run('ALTER TABLE orders ADD COLUMN client_order_id TEXT'); } catch { /* existing database already migrated */ }
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_order_id ON orders(client_order_id) WHERE client_order_id IS NOT NULL');
  try { db.run('ALTER TABLE order_items ADD COLUMN original_text TEXT'); } catch { /* existing database already migrated */ }
  const count = scalar('SELECT COUNT(*) FROM users');
  if (!count) seed();
  else {
    run('CREATE TABLE IF NOT EXISTS retailer_prices(retailer_id INTEGER NOT NULL, product_id INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY(retailer_id,product_id))');
    run('CREATE TABLE IF NOT EXISTS retailer_credit(retailer_id INTEGER PRIMARY KEY, limit_amount REAL NOT NULL, outstanding REAL NOT NULL)');
    run('CREATE TABLE IF NOT EXISTS salesman_assignments(salesman_id INTEGER NOT NULL, retailer_id INTEGER NOT NULL, PRIMARY KEY(salesman_id,retailer_id))');
    run('INSERT OR IGNORE INTO salesman_assignments VALUES(4,1),(4,2)');
  }
  run("UPDATE products SET image=CASE sku WHEN 'SKU-BS-075' THEN '/products/biscuit.svg' WHEN 'SKU-DT-1KG' THEN '/products/detergent.svg' WHEN 'SKU-TE-250' THEN '/products/tea.svg' ELSE image END");
  save();
}
function seed() {
  const users = [
    [1,'Ramesh Kirana','9000000001','retailer',1],
    [2,'Sita General Store','9000000002','retailer',2],
    [3,'Order Desk','9000000099','desk',null],
    [4,'Amit Salesman','9000000088','salesman',null]
  ];
  users.forEach(u=>run('INSERT INTO users(id,name,phone,role,retailer_id) VALUES(?,?,?,?,?)',u));
  const products = [
    [1,'SKU-BS-075','Glucose biscuit 75 g','Case of 96',8.10,340,'/products/biscuit.svg'],
    [2,'SKU-DT-1KG','Detergent powder 1 kg','Case of 20',101.50,85,'/products/detergent.svg'],
    [3,'SKU-TE-250','Tea leaf 250 g','Case of 40',118.00,0,'/products/tea.svg']
  ];
  products.forEach(p=>run('INSERT INTO products(id,sku,name,unit,price,stock_cases,image) VALUES(?,?,?,?,?,?,?)',p));
  run('INSERT INTO schemes(product_id,type,threshold,value,label) VALUES(1,\'free\',10,1,\'Buy 10 cases, get 1 free\')');
  run('INSERT INTO schemes(product_id,type,threshold,value,label) VALUES(2,\'discount\',5,3,\'3% off on 5 or more cases\')');
  // Personalised retailer pricing is stored separately from the public catalogue price.
  run('CREATE TABLE IF NOT EXISTS retailer_prices(retailer_id INTEGER NOT NULL, product_id INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY(retailer_id,product_id))');
  [[1,1,8.10],[1,2,101.50],[1,3,118],[2,1,8.25],[2,2,100.75],[2,3,117.5]].forEach(x=>run('INSERT INTO retailer_prices VALUES(?,?,?)',x));
  run('CREATE TABLE IF NOT EXISTS retailer_credit(retailer_id INTEGER PRIMARY KEY, limit_amount REAL NOT NULL, outstanding REAL NOT NULL)');
  run('INSERT INTO retailer_credit VALUES(1,50000,12500),(2,30000,28000)');
  run('INSERT INTO salesman_assignments VALUES(4,1),(4,2)');
  run('INSERT INTO aliases(retailer_id,phrase,product_id) VALUES(1,\'biscuit chhota\',1),(1,\'washing powder\',2),(1,\'chai patti\',3)');
}
export function all(sql, params=[]) { const st=db.prepare(sql); st.bind(params); const rows=[]; while(st.step()) rows.push(st.getAsObject()); st.free(); return rows; }
export function one(sql, params=[]) { return all(sql,params)[0] || null; }
export function run(sql, params=[]) { db.run(sql,params); if (!inTransaction) save(); }
export function transaction(fn) { db.run('BEGIN'); inTransaction=true; try { const result=fn(); db.run('COMMIT'); inTransaction=false; save(); return result; } catch(e) { db.run('ROLLBACK'); inTransaction=false; throw e; } }
function scalar(sql) { return one(sql)?.[Object.keys(one(sql))[0]] ?? 0; }
function save() { if(db) fs.writeFileSync(dbPath, Buffer.from(db.export())); }
