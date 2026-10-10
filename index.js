// Cloudflare Worker + D1 — API cho POS xe đạp điện (bản đã sửa lỗi)
const json = (data, status = 200, origin = '*') =>
  new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ===== Helpers =====
const genCode = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
const str = (v) => String(v ?? '').trim();
const money = (v) => Math.max(0, Number(v) || 0);
const isUnique = (e) => /UNIQUE/i.test(String(e?.message));
const placeholders = (arr) => arr.map(() => '?').join(',');
const isoDate = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};
const idOf = (pathname) => Number(pathname.split('/')[3]);

async function hasTable(db, name) {
  return !!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").bind(name).first());
}

// Chuẩn hoá & kiểm tra dòng hàng từ client
function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Danh sách sản phẩm trống');
  return items.map((it) => {
    const product_id = Number(it.product_id);
    const quantity = Number(it.quantity);
    if (!Number.isInteger(product_id) || !Number.isInteger(quantity) || quantity <= 0)
      throw new HttpError(400, 'Sản phẩm hoặc số lượng không hợp lệ');
    const price = money(it.price);
    const discount = money(it.discount);
    const gross = quantity * price;
    if (discount > gross) throw new HttpError(400, 'Giảm giá không được lớn hơn thành tiền');
    return { product_id, quantity, price, discount, total: gross - discount };
  });
}
const sumTotal = (lines) => lines.reduce((s, l) => s + l.total, 0);

// Kiểm tra sản phẩm tồn tại (và đủ tồn kho nếu cần). Trả về danh sách id duy nhất.
async function loadProducts(db, lines, { checkStock }) {
  const need = new Map();
  for (const l of lines) need.set(l.product_id, (need.get(l.product_id) || 0) + l.quantity);
  const ids = [...need.keys()];
  const { results } = await db
    .prepare(`SELECT id, name, stock FROM products WHERE id IN (${placeholders(ids)})`)
    .bind(...ids).all();
  if (results.length !== ids.length) throw new HttpError(404, 'Có sản phẩm không tồn tại');
  if (checkStock) {
    for (const p of results) {
      if ((p.stock || 0) < need.get(p.id))
        throw new HttpError(409, `Sản phẩm "${p.name}" chỉ còn ${p.stock || 0} trong kho, không đủ bán!`);
    }
  }
  return ids;
}

// Statement "chốt chặn": nếu sau khi trừ/cộng kho mà có sản phẩm bị âm -> json() báo lỗi
// "malformed JSON" -> toàn bộ db.batch() bị rollback. Đảm bảo không bán lố kể cả khi 2 người bán cùng lúc.
const stockGuard = (db, ids) =>
  db.prepare(
    `SELECT json(CASE WHEN EXISTS (SELECT 1 FROM products WHERE id IN (${placeholders(ids)}) AND stock < 0) THEN 'ROLLBACK' ELSE '{}' END)`
  ).bind(...ids);

async function runBatch(db, stmts, stockMsg) {
  try {
    return await db.batch(stmts);
  } catch (e) {
    if (/malformed JSON|CHECK constraint failed/i.test(String(e?.message))) throw new HttpError(409, stockMsg);
    throw e;
  }
}

// Import hàng loạt: gom theo lô thay vì await từng dòng
async function runImport(db, stmts, size = 50) {
  let successCount = 0, errorCount = 0;
  for (let i = 0; i < stmts.length; i += size) {
    const chunk = stmts.slice(i, i + size);
    try { await db.batch(chunk); successCount += chunk.length; }
    catch (e) { errorCount += chunk.length; }
  }
  return { successCount, errorCount };
}

// Tự tạo khách hàng nếu tên chưa có trong danh sách (để công nợ/lịch sử khớp)
const ensureCustomer = (db, name, phone, address) =>
  db.prepare('INSERT INTO customers (code, name, phone, address) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM customers WHERE name = ?)')
    .bind(genCode('KH'), name, phone, address, name);

// ===== Nghiệp vụ =====
async function createInvoice(db, b) {
  const customer_name = str(b.customer_name);
  if (!customer_name) throw new HttpError(400, 'Thiếu tên khách hàng');
  const customer_phone = str(b.customer_phone) || null;
  const address = str(b.address) || null;

  const lines = normalizeItems(b.items);
  const ids = await loadProducts(db, lines, { checkStock: true });

  const total = sumTotal(lines);
  const paid_amount = Math.min(money(b.paid_amount), total);
  const debt = total - paid_amount;
  const code = genCode('BH');
  const created_at = isoDate(b.created_at);
  const payment_method = str(b.payment_method) || 'Tiền mặt';

  const stmts = [
    ensureCustomer(db, customer_name, customer_phone, address),
    db.prepare('INSERT INTO invoices (code, customer_name, customer_phone, total, paid_amount, debt, created_at, payment_method) VALUES (?,?,?,?,?,?,?,?)')
      .bind(code, customer_name, customer_phone, total, paid_amount, debt, created_at, payment_method),
    ...lines.map((l) =>
      db.prepare('INSERT INTO invoice_items (invoice_id, product_id, quantity, price, discount, total) VALUES ((SELECT id FROM invoices WHERE code = ?),?,?,?,?,?)')
        .bind(code, l.product_id, l.quantity, l.price, l.discount, l.total)),
    ...lines.map((l) =>
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(l.quantity, l.product_id)),
    stockGuard(db, ids),
  ];
  await runBatch(db, stmts, 'Tồn kho vừa thay đổi, không đủ hàng. Vui lòng tải lại và thử lại');
  return { code, total };
}

async function createOrder(db, b) {
  const customer_name = str(b.customer_name);
  if (!customer_name) throw new HttpError(400, 'Thiếu tên khách hàng');
  const customer_phone = str(b.customer_phone) || null;
  const address = str(b.address) || null;

  const lines = normalizeItems(b.items);
  await loadProducts(db, lines, { checkStock: false }); // đơn đặt hàng: không trừ kho

  const total = sumTotal(lines);
  const code = genCode('DH');
  const created_at = isoDate(b.created_at);

  await db.batch([
    ensureCustomer(db, customer_name, customer_phone, address),
    db.prepare('INSERT INTO orders (code, customer_name, customer_phone, total, created_at, status) VALUES (?,?,?,?,?,?)')
      .bind(code, customer_name, customer_phone, total, created_at, 'Pending'),
    ...lines.map((l) =>
      db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price, discount, total) VALUES ((SELECT id FROM orders WHERE code = ?),?,?,?,?,?)')
        .bind(code, l.product_id, l.quantity, l.price, l.discount, l.total)),
  ]);
  return { code, total };
}

// Dựng các statement cho 1 phiếu nhập (dùng chung cho POST và PUT)
async function buildPurchase(db, b) {
  const supplier_id = Number(b.supplier_id);
  if (!supplier_id) throw new HttpError(400, 'Vui lòng chọn nhà cung cấp');
  if (!(await db.prepare('SELECT id FROM suppliers WHERE id = ?').bind(supplier_id).first()))
    throw new HttpError(404, 'Nhà cung cấp không tồn tại');
  const lines = normalizeItems(b.items);
  const ids = await loadProducts(db, lines, { checkStock: false });
  const total = sumTotal(lines);
  const paid_amount = Math.min(money(b.paid_amount), total);
  return {
    supplier_id, lines, ids, total, paid_amount,
    debt: total - paid_amount,
    payment_method: str(b.payment_method) || 'Tiền mặt',
  };
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const { pathname } = new URL(request.url);
    const method = request.method;
    const db = env.DB;
    const is = (re, m) => re.test(pathname) && method === m;

    if (method === 'OPTIONS') return json(null, 204, origin);

    try {
      // ===== 1. SẢN PHẨM =====
      if (pathname === '/api/products' && method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM products ORDER BY id DESC').all();
        return json((results || []).map((p) => ({
          id: p.id,
          sku: p.sku || p.code || '',
          name: p.name || '',
          unit: p.unit || 'Cái',
          import_price: p.import_price || p.cost_price || 0,
          price: p.price || p.retail_price || 0,
          wholesale_price: p.wholesale_price || 0,
          stock: p.stock || p.quantity || 0,
        })), 200, origin);
      }

      if (pathname === '/api/products' && method === 'POST') {
        const b = await request.json();
        const name = str(b.name);
        if (!name) throw new HttpError(400, 'Thiếu tên sản phẩm');
        try {
          await db.prepare('INSERT INTO products (sku, name, unit, import_price, price, wholesale_price, stock) VALUES (?,?,?,?,?,?,?)')
            .bind(str(b.sku) || genCode('SP'), name, str(b.unit) || 'Cái', money(b.import_price), money(b.price), money(b.wholesale_price), money(b.stock)).run();
        } catch (err) {
          if (isUnique(err)) throw new HttpError(400, 'Trùng mã SKU sản phẩm');
          throw err;
        }
        return json({ success: true }, 201, origin);
      }

      if (pathname === '/api/products/import' && method === 'POST') {
        const { items = [] } = await request.json();
        const bySku = new Map(); // gộp trùng SKU trong cùng file (dòng sau đè dòng trước)
        let invalid = 0;
        for (const it of items) {
          const name = str(it.name);
          if (!name) { invalid++; continue; }
          const sku = str(it.sku) || genCode('SP');
          bySku.set(sku, { sku, name, unit: str(it.unit) || 'Cái', import_price: money(it.import_price), price: money(it.price), wholesale_price: money(it.wholesale_price), stock: money(it.stock) });
        }
        const stmts = [...bySku.values()].map((p) =>
          db.prepare(`INSERT INTO products (sku, name, unit, import_price, price, wholesale_price, stock) VALUES (?,?,?,?,?,?,?)
                      ON CONFLICT(sku) DO UPDATE SET name = excluded.name, unit = excluded.unit, import_price = excluded.import_price,
                      price = excluded.price, wholesale_price = excluded.wholesale_price, stock = excluded.stock`)
            .bind(p.sku, p.name, p.unit, p.import_price, p.price, p.wholesale_price, p.stock));
        const r = await runImport(db, stmts);
        return json({ success: true, successCount: r.successCount, errorCount: r.errorCount + invalid }, 200, origin);
      }

      if (is(/^\/api\/products\/\d+$/, 'PUT')) {
        const id = idOf(pathname);
        const b = await request.json();
        const name = str(b.name);
        if (!name) throw new HttpError(400, 'Thiếu tên sản phẩm');
        try {
          const r = await db.prepare('UPDATE products SET sku = ?, name = ?, unit = ?, import_price = ?, price = ?, wholesale_price = ?, stock = ? WHERE id = ?')
            .bind(str(b.sku) || `SP-${id}`, name, str(b.unit) || 'Cái', money(b.import_price), money(b.price), money(b.wholesale_price), money(b.stock), id).run();
          if (!r.meta?.changes) throw new HttpError(404, 'Không tìm thấy sản phẩm');
        } catch (err) {
          if (isUnique(err)) throw new HttpError(400, 'Trùng mã SKU sản phẩm');
          throw err;
        }
        return json({ success: true }, 200, origin);
      }

      if (is(/^\/api\/products\/\d+$/, 'DELETE')) {
        const id = idOf(pathname);
        const used = await db.prepare(
          `SELECT (SELECT COUNT(*) FROM invoice_items WHERE product_id = ?1)
                + (SELECT COUNT(*) FROM order_items WHERE product_id = ?1)
                + (SELECT COUNT(*) FROM purchase_order_items WHERE product_id = ?1) AS n`
        ).bind(id).first();
        if (used?.n > 0) throw new HttpError(409, 'Sản phẩm đã phát sinh giao dịch nên không thể xóa');
        await db.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
        return json({ success: true }, 200, origin);
      }

      // ===== 2. PHIẾU BÁN HÀNG / ĐƠN ĐẶT HÀNG =====
      if (pathname === '/api/invoices' && method === 'POST') {
        const r = await createInvoice(db, await request.json());
        return json({ success: true, ...r }, 201, origin);
      }
      if (pathname === '/api/orders' && method === 'POST') {
        const r = await createOrder(db, await request.json());
        return json({ success: true, ...r }, 201, origin);
      }

      // GET /api/invoices — Lấy danh sách phiếu bán hàng
      if (pathname === '/api/invoices' && request.method === 'GET') {
        const res = await db.prepare('SELECT * FROM invoices ORDER BY id DESC').all();
        return json(res.results || [], 200, origin);
      }

      // GET /api/orders — Lấy danh sách đơn đặt hàng
      if (pathname === '/api/orders' && request.method === 'GET') {
        const res = await db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
        return json(res.results || [], 200, origin);
      }

      // PUT /api/orders/:id — Cập nhật đơn đặt hàng
      if (pathname.match(/^\/api\/orders\/\d+$/) && request.method === 'PUT') {
        const id = pathname.split('/')[3];
        const b = await request.json();
        const customer_name = String(b.customer_name || '').trim();
        const customer_phone = String(b.customer_phone || '').trim() || null;
        const address = String(b.address || '').trim() || null;
        const created_at = b.created_at || new Date().toISOString();
        const items = b.items || [];
        const paid_amount = Number(b.paid_amount) || 0;
        const payment_method = b.payment_method || 'Tiền mặt';

        if (!customer_name) throw new HttpError(400, 'Thiếu tên khách hàng');
        if (items.length === 0) throw new HttpError(400, 'Giỏ hàng trống');

        let total = 0;
        for (const item of items) {
          total += (item.quantity * item.price) - (item.discount || 0);
        }
        const debt = total - paid_amount;

        const stmts = [
          db.prepare('UPDATE orders SET customer_name = ?, customer_phone = ?, total = ?, paid_amount = ?, debt = ?, payment_method = ?, created_at = ? WHERE id = ?')
            .bind(customer_name, customer_phone, total, paid_amount, debt, payment_method, created_at, id),
          db.prepare('DELETE FROM order_items WHERE order_id = ?').bind(id)
        ];

        for (const item of items) {
          const lineTotal = (item.quantity * item.price) - (item.discount || 0);
          stmts.push(
            db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price, discount, total) VALUES (?, ?, ?, ?, ?, ?)')
              .bind(id, item.product_id, item.quantity, item.price, item.discount || 0, lineTotal)
          );
        }

        await db.batch(stmts);
        return json({ success: true, total }, 200, origin);
      }

      // GET /api/orders/:id hoặc /api/invoices/:id (lấy chi tiết kèm items)
      if (pathname.match(/^\/api\/(orders|invoices)\/\d+$/) && request.method === 'GET') {
        const parts = pathname.split('/');
        const type = parts[2]; // 'orders' hoặc 'invoices'
        const id = parts[3];
        const itemTable = type === 'orders' ? 'order_items' : 'invoice_items';
        const foreignKey = type === 'orders' ? 'order_id' : 'invoice_id';

        const mainObj = await db.prepare(`SELECT * FROM ${type} WHERE id = ?`).bind(id).first();
        if (!mainObj) throw new HttpError(404, 'Không tìm thấy dữ liệu');

        const items = await db.prepare(`
          select i.*, p.name as product_name, p.sku 
          from ${itemTable} i 
          left join products p on i.product_id = p.id 
          where i.${foreignKey} = ?
        `).bind(id).all();

        return json({ ...mainObj, items: items.results || [] }, 200, origin);
      }

        // DELETE /api/orders/:id hoặc /api/invoices/:id
      if (pathname.match(/^\/api\/(orders|invoices)\/\d+$/) && request.method === 'DELETE') {
        const parts = pathname.split('/');
        const type = parts[2];
        const id = parts[3];
        const itemTable = type === 'orders' ? 'order_items' : 'invoice_items';
        const foreignKey = type === 'orders' ? 'order_id' : 'invoice_id';

        // Nếu là phiếu bán hàng (invoices), khi xóa cần hoàn lại tồn kho sản phẩm
        if (type === 'invoices') {
          const items = await db.prepare(`SELECT * FROM invoice_items WHERE invoice_id = ?`).bind(id).all();
          for (const item of (items.results || [])) {
            await db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').bind(item.quantity, item.product_id).run();
          }
        }

        await db.batch([
          db.prepare(`DELETE FROM ${itemTable} WHERE ${foreignKey} = ?`).bind(id),
          db.prepare(`DELETE FROM ${type} WHERE id = ?`).bind(id)
        ]);
        return json({ success: true }, 200, origin);
      }

        // ===== 7. QUẢN LÝ THU CHI =====
      if (pathname === '/api/cash-book' && method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM cash_books ORDER BY id DESC').all();
        
        // Tính toán Tổng thu, Tổng chi, Lợi nhuận và Số dư tích lũy
        let totalIn = 0;
        let totalOut = 0;
        (results || []).forEach(item => {
          if (item.type === 'IN') totalIn += Number(item.amount) || 0;
          if (item.type === 'OUT') totalOut += Number(item.amount) || 0;
        });
        const netProfit = totalIn - totalOut;

        return json({
          success: true,
          summary: { totalIn, totalOut, netProfit, balance: netProfit },
          items: results || []
        }, 200, origin);
      }

      if (pathname === '/api/cash-book' && method === 'POST') {
        const b = await request.json();
        const type = b.type; // 'IN' hoặc 'OUT'
        const amount = Number(b.amount) || 0;
        const category = str(b.category) || 'Khác';
        if (amount <= 0) throw new HttpError(400, 'Số tiền giao dịch phải lớn hơn 0');

        const code = genCode(type === 'IN' ? 'PT' : 'TC');
        await db.prepare(`
          INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          code, 
          type, 
          amount, 
          category, 
          str(b.payment_method) || 'Chuyển khoản', 
          str(b.reference_code) || '', 
          str(b.note) || '', 
          b.created_at || new Date().toISOString()
        ).run();

        return json({ success: true, code }, 201, origin);
      }

      if (is(/^\/api\/cash-book\/\d+$/, 'DELETE')) {
        const id = idOf(pathname);
        await db.prepare('DELETE FROM cash_books WHERE id = ?').bind(id).run();
        return json({ success: true }, 200, origin);
      }

      // Cập nhật phiếu thu / chi hiện có (không tạo mới)
      if (is(/^\/api\/cash-book\/\d+$/, 'PUT')) {
        const id = idOf(pathname);
        const existing = await db.prepare('SELECT id FROM cash_books WHERE id = ?').bind(id).first();
        if (!existing) throw new HttpError(404, 'Không tìm thấy phiếu thu chi');

        const b = await request.json();
        const type = b.type; // 'IN' hoặc 'OUT'
        const amount = Number(b.amount) || 0;
        const category = str(b.category) || 'Khác';
        if (amount <= 0) throw new HttpError(400, 'Số tiền giao dịch phải lớn hơn 0');

        await db.prepare(`
          UPDATE cash_books 
          SET type = ?, amount = ?, category = ?, payment_method = ?, reference_code = ?, note = ?
          WHERE id = ?
        `).bind(
          type,
          amount,
          category,
          str(b.payment_method) || 'Chuyển khoản',
          str(b.reference_code) || '',
          str(b.note) || '',
          id
        ).run();

        return json({ success: true }, 200, origin);
      }
      // ===== 3. NHÀ CUNG CẤP =====
      if (pathname === '/api/suppliers' && method === 'GET') {
        // Công nợ = tổng nhập - (tiền trả ngay trên phiếu nhập + các khoản thanh toán về sau)
        const { results } = await db.prepare(`
          SELECT s.*,
            COALESCE(p.total_purchase, 0) AS total_purchase,
            COALESCE(p.po_paid, 0) + COALESCE(pay.total_paid, 0) AS total_paid,
            COALESCE(p.total_purchase, 0) - COALESCE(p.po_paid, 0) - COALESCE(pay.total_paid, 0) AS total_debt
          FROM suppliers s
          LEFT JOIN (SELECT supplier_id, SUM(total) AS total_purchase, SUM(paid_amount) AS po_paid
                     FROM purchase_orders GROUP BY supplier_id) p ON s.id = p.supplier_id
          LEFT JOIN (SELECT supplier_id, SUM(amount) AS total_paid
                     FROM supplier_payments GROUP BY supplier_id) pay ON s.id = pay.supplier_id
          ORDER BY s.id DESC
        `).all();
        return json(results || [], 200, origin);
      }

      if (pathname === '/api/suppliers' && method === 'POST') {
        const b = await request.json();
        const name = str(b.name);
        if (!name) throw new HttpError(400, 'Thiếu tên nhà cung cấp');
        const code = str(b.code) || genCode('NCC');
        try {
          await db.prepare('INSERT INTO suppliers (code, name, phone, address, status) VALUES (?,?,?,?,?)')
            .bind(code, name, str(b.phone) || null, str(b.address) || null, b.status === 'inactive' ? 'inactive' : 'active').run();
        } catch (err) {
          if (isUnique(err)) throw new HttpError(400, 'Trùng mã NCC');
          throw err;
        }
        return json({ success: true, code }, 201, origin);
      }

      if (pathname === '/api/suppliers/import' && method === 'POST') {
        const { items = [] } = await request.json();
        let invalid = 0;
        const stmts = [];
        for (const it of items) {
          const name = str(it.name);
          if (!name) { invalid++; continue; }
          stmts.push(
            db.prepare(`INSERT INTO suppliers (code, name, phone, address, status) VALUES (?,?,?,?,?)
                        ON CONFLICT(code) DO UPDATE SET name = excluded.name, phone = excluded.phone, address = excluded.address, status = excluded.status`)
              .bind(str(it.code) || genCode('NCC'), name, str(it.phone) || null, str(it.address) || null, it.status === 'inactive' ? 'inactive' : 'active'));
        }
        const r = await runImport(db, stmts);
        return json({ success: true, successCount: r.successCount, errorCount: r.errorCount + invalid }, 200, origin);
      }

      if (is(/^\/api\/suppliers\/\d+$/, 'PUT')) {
        const id = idOf(pathname);
        const b = await request.json();
        const name = str(b.name);
        if (!name) throw new HttpError(400, 'Thiếu tên nhà cung cấp');
        try {
          // Để trống mã -> giữ nguyên mã cũ (trước đây bị ghi đè thành 'NCC-DEFAULT')
          const r = await db.prepare("UPDATE suppliers SET code = COALESCE(NULLIF(?, ''), code), name = ?, phone = ?, address = ?, status = ? WHERE id = ?")
            .bind(str(b.code), name, str(b.phone) || null, str(b.address) || null, b.status === 'inactive' ? 'inactive' : 'active', id).run();
          if (!r.meta?.changes) throw new HttpError(404, 'Không tìm thấy nhà cung cấp');
        } catch (err) {
          if (isUnique(err)) throw new HttpError(400, 'Trùng mã NCC');
          throw err;
        }
        return json({ success: true }, 200, origin);
      }

      if (is(/^\/api\/suppliers\/\d+$/, 'DELETE')) {
        const id = idOf(pathname);
        const used = await db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE supplier_id = ?').bind(id).first();
        if (used?.n > 0) throw new HttpError(409, 'Nhà cung cấp đã có phiếu nhập nên không thể xóa (hãy chuyển sang "Ngừng")');
        await db.prepare('DELETE FROM suppliers WHERE id = ?').bind(id).run();
        return json({ success: true }, 200, origin);
      }

      if (is(/^\/api\/suppliers\/\d+\/history$/, 'GET')) {
        const id = idOf(pathname);
        const safeAll = async (table) => {
          try { return (await db.prepare(`SELECT * FROM ${table} WHERE supplier_id = ? ORDER BY id DESC`).bind(id).all()).results || []; }
          catch (e) { return []; }
        };
        return json({
          purchases: await safeAll('purchase_orders'),
          payments: await safeAll('supplier_payments'),
          returns: await safeAll('supplier_returns'),
        }, 200, origin);
      }

      // ===== 4. PHIẾU NHẬP HÀNG =====
      if (pathname === '/api/purchase_orders' && method === 'GET') {
        const { results } = await db.prepare(`
          SELECT po.*, s.name AS supplier_name
          FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id
          ORDER BY po.id DESC
        `).all();
        return json(results || [], 200, origin);
      }

      if (pathname === '/api/purchase_orders' && method === 'POST') {
  const reqData = await request.json();
  const po = await buildPurchase(db, reqData);
  const code = genCode('PN');
  
  // 👉 Lấy chính xác ngày do người dùng chọn từ frontend gửi lên (nếu có), nếu không mới lấy ngày hiện tại
  const customDate = reqData.created_at || new Date().toISOString();

  await db.batch([
    db.prepare('INSERT INTO purchase_orders (code, supplier_id, total, paid_amount, debt, payment_method, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(code, po.supplier_id, po.total, po.paid_amount, po.debt, po.payment_method, customDate),
    ...po.lines.map((l) =>
      db.prepare('INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, price, discount, total) VALUES ((SELECT id FROM purchase_orders WHERE code = ?),?,?,?,?,?)')
        .bind(code, l.product_id, l.quantity, l.price, l.discount, l.total)),
    ...po.lines.map((l) =>
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').bind(l.quantity, l.product_id)),
  ]);
        // 2. 👉 TỰ ĐỘNG SINH PHIẾU CHI NẾU CÓ THANH TOÁN TIỀN NGAY TRÊN PHIẾU NHẬP
        if (Number(po.paid_amount) > 0) {
          const cashCode = genCode('TC');
          // Lấy tên nhà cung cấp để ghi chú chi tiết
          const sup = await db.prepare('SELECT name FROM suppliers WHERE id = ?').bind(po.supplier_id).first();
          const supName = sup ? sup.name : 'Nhà cung cấp';
          const noteText = `Thanh toán tiền mua hàng cho ${supName} theo phiếu ${code}`;

          batchStmts.push(
            db.prepare(`
              INSERT INTO cash_books (code, type, amount, category, payment_method, reference_code, note, created_at)
              VALUES (?, 'OUT', ?, 'Mua hàng / Trả nợ NCC', ?, ?, ?, ?)
            `).bind(cashCode, po.paid_amount, po.payment_method || 'Chuyển khoản', code, noteText, customDate)
          );
        }
  return json({ success: true, code, total: po.total }, 201, origin);
}

      if (is(/^\/api\/purchase_orders\/\d+$/, 'GET')) {
        const id = idOf(pathname);
        const po = await db.prepare(`
          SELECT po.*, s.name AS supplier_name
          FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id
          WHERE po.id = ?
        `).bind(id).first();
        if (!po) throw new HttpError(404, 'Không tìm thấy phiếu nhập');
        const itemsRes = await db.prepare(`
          SELECT poi.*, p.name AS product_name, p.sku, p.unit
          FROM purchase_order_items poi LEFT JOIN products p ON poi.product_id = p.id
          WHERE poi.purchase_order_id = ?
        `).bind(id).all();
        return json({ ...po, items: itemsRes.results || [] }, 200, origin);
      }

      // PUT: trước đây Worker KHÔNG có route này nên nút "Sửa phiếu nhập" không lưu được gì
      if (is(/^\/api\/purchase_orders\/\d+$/, 'PUT')) {
  const id = idOf(pathname);
  const existing = await db.prepare('SELECT id FROM purchase_orders WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Không tìm thấy phiếu nhập');

  const reqData = await request.json();
  const po = await buildPurchase(db, reqData);
  const customDate = reqData.created_at || new Date().toISOString();

  const oldItems = (await db.prepare('SELECT product_id, quantity FROM purchase_order_items WHERE purchase_order_id = ?').bind(id).all()).results || [];
  const ids = [...new Set([...oldItems.map((i) => i.product_id), ...po.ids])];

  await runBatch(db, [
    ...oldItems.map((i) => db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(i.quantity, i.product_id)),
    db.prepare('DELETE FROM purchase_order_items WHERE purchase_order_id = ?').bind(id),
    // 👉 Cập nhật thêm created_at vào câu lệnh UPDATE
    db.prepare('UPDATE purchase_orders SET supplier_id = ?, total = ?, paid_amount = ?, debt = ?, payment_method = ?, created_at = ? WHERE id = ?')
      .bind(po.supplier_id, po.total, po.paid_amount, po.debt, po.payment_method, customDate, id),
    ...po.lines.map((l) =>
      db.prepare('INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, price, discount, total) VALUES (?,?,?,?,?,?)')
        .bind(id, l.product_id, l.quantity, l.price, l.discount, l.total)),
    ...po.lines.map((l) => db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').bind(l.quantity, l.product_id)),
    stockGuard(db, ids),
  ], 'Không thể sửa phiếu...');
  return json({ success: true }, 200, origin);
}

      if (is(/^\/api\/purchase_orders\/\d+$/, 'DELETE')) {
        const id = idOf(pathname);
        const items = (await db.prepare('SELECT product_id, quantity FROM purchase_order_items WHERE purchase_order_id = ?').bind(id).all()).results || [];
        const ids = [...new Set(items.map((i) => i.product_id))];
        const stmts = [
          ...items.map((i) => db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(i.quantity, i.product_id)),
          db.prepare('DELETE FROM purchase_order_items WHERE purchase_order_id = ?').bind(id),
          db.prepare('DELETE FROM purchase_orders WHERE id = ?').bind(id),
        ];
        if (ids.length) stmts.push(stockGuard(db, ids));
        await runBatch(db, stmts, 'Không thể xóa phiếu: một số hàng đã bán nên tồn kho không đủ để hoàn lại');
        return json({ success: true }, 200, origin);
      }

      // ===== 5. KHÁCH HÀNG =====
      if (pathname === '/api/customers' && method === 'GET') {
        let results = [];
        try {
          // Công nợ = tổng mua - (tiền trả ngay trên phiếu bán + các khoản thanh toán về sau)
          const payJoin = (await hasTable(db, 'customer_payments'))
            ? `LEFT JOIN (SELECT customer_name, SUM(amount) AS total_paid FROM customer_payments GROUP BY customer_name) pay ON c.name = pay.customer_name`
            : `LEFT JOIN (SELECT NULL AS customer_name, 0 AS total_paid) pay ON 1 = 0`;
          const res = await db.prepare(`
            SELECT c.*,
              COALESCE(i.total_purchased, 0) AS total_purchased,
              COALESCE(i.inv_paid, 0) + COALESCE(pay.total_paid, 0) AS total_paid,
              COALESCE(i.total_purchased, 0) - COALESCE(i.inv_paid, 0) - COALESCE(pay.total_paid, 0) AS total_debt
            FROM customers c
            LEFT JOIN (SELECT customer_name, SUM(total) AS total_purchased, SUM(paid_amount) AS inv_paid
                       FROM invoices GROUP BY customer_name) i ON c.name = i.customer_name
            ${payJoin}
            ORDER BY c.id DESC
          `).all();
          results = res.results || [];
        } catch (e) {
          console.error('customers summary failed', e);
          results = (await db.prepare('SELECT *, 0 AS total_purchased, 0 AS total_paid, 0 AS total_debt FROM customers ORDER BY id DESC').all()).results || [];
        }
        return json(results, 200, origin);
      }

      if (pathname === '/api/customers' && method === 'POST') {
        const b = await request.json();
        const name = str(b.name);
        if (!name) throw new HttpError(400, 'Thiếu tên khách hàng');
        const code = str(b.code) || genCode('KH');
        try {
          await db.prepare('INSERT INTO customers (code, name, phone, address) VALUES (?,?,?,?)')
            .bind(code, name, str(b.phone) || null, str(b.address) || null).run();
        } catch (err) {
          if (isUnique(err)) throw new HttpError(400, 'Trùng mã khách hàng');
          throw err;
        }
        return json({ success: true, code }, 201, origin);
      }

      if (pathname === '/api/customers/import' && method === 'POST') {
        const { items = [] } = await request.json();
        let invalid = 0;
        const stmts = [];
        for (const it of items) {
          const name = str(it.name);
          if (!name) { invalid++; continue; }
          stmts.push(
            db.prepare(`INSERT INTO customers (code, name, phone, address) VALUES (?,?,?,?)
                        ON CONFLICT(code) DO UPDATE SET name = excluded.name, phone = excluded.phone, address = excluded.address`)
              .bind(str(it.code) || genCode('KH'), name, str(it.phone) || null, str(it.address) || null));
        }
        const r = await runImport(db, stmts);
        return json({ success: true, successCount: r.successCount, errorCount: r.errorCount + invalid }, 200, origin);
      }

      if (is(/^\/api\/customers\/\d+\/history$/, 'GET')) {
        const id = idOf(pathname);
        const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
        if (!customer) throw new HttpError(404, 'Không tìm thấy khách hàng');
        const invoices = (await db.prepare('SELECT * FROM invoices WHERE customer_name = ? ORDER BY id DESC').bind(customer.name).all()).results || [];
        let payments = [];
        if (await hasTable(db, 'customer_payments')) {
          payments = (await db.prepare('SELECT * FROM customer_payments WHERE customer_name = ? ORDER BY id DESC').bind(customer.name).all()).results || [];
        }
        return json({ customer, invoices, payments }, 200, origin);
      }

      if (is(/^\/api\/customers\/\d+$/, 'PUT')) {
        const id = idOf(pathname);
        const b = await request.json();
        const name = str(b.name);
        if (!name) throw new HttpError(400, 'Thiếu tên khách hàng');
        const current = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
        if (!current) throw new HttpError(404, 'Không tìm thấy khách hàng');

        const stmts = [
          db.prepare('UPDATE customers SET code = ?, name = ?, phone = ?, address = ? WHERE id = ?')
            .bind(str(b.code) || current.code, name, str(b.phone) || null, str(b.address) || null, id),
        ];
        // Lịch sử đang liên kết theo TÊN, nên đổi tên phải cập nhật theo để không mất công nợ/lịch sử
        if (name !== current.name) {
          stmts.push(db.prepare('UPDATE invoices SET customer_name = ? WHERE customer_name = ?').bind(name, current.name));
          stmts.push(db.prepare('UPDATE orders SET customer_name = ? WHERE customer_name = ?').bind(name, current.name));
          if (await hasTable(db, 'customer_payments'))
            stmts.push(db.prepare('UPDATE customer_payments SET customer_name = ? WHERE customer_name = ?').bind(name, current.name));
        }
        try { await db.batch(stmts); }
        catch (err) {
          if (isUnique(err)) throw new HttpError(400, 'Trùng mã khách hàng');
          throw err;
        }
        return json({ success: true }, 200, origin);
      }

      if (is(/^\/api\/customers\/\d+$/, 'DELETE')) {
        const id = idOf(pathname);
        const c = await db.prepare('SELECT name FROM customers WHERE id = ?').bind(id).first();
        if (!c) throw new HttpError(404, 'Không tìm thấy khách hàng');
        const used = await db.prepare('SELECT (SELECT COUNT(*) FROM invoices WHERE customer_name = ?1) + (SELECT COUNT(*) FROM orders WHERE customer_name = ?1) AS n').bind(c.name).first();
        if (used?.n > 0) throw new HttpError(409, 'Khách hàng đã có đơn hàng/phiếu bán nên không thể xóa');
        await db.prepare('DELETE FROM customers WHERE id = ?').bind(id).run();
        return json({ success: true }, 200, origin);
      }

      // GET /api/reports/inventory-summary — Báo cáo Xuất Nhập Tồn theo khoảng thời gian
      if (pathname === '/api/reports/inventory-summary' && method === 'GET') {
        const urlObj = new URL(request.url);
        const startDate = urlObj.searchParams.get('startDate') || '2025-01-01';
        const endDate = urlObj.searchParams.get('endDate') || '2030-12-31';
        const search = (urlObj.searchParams.get('search') || '').toLowerCase();

        // 1. Lấy toàn bộ sản phẩm (chọn các cột cơ bản an toàn tuyệt đối)
        const prodRes = await db.prepare('SELECT * FROM products').all();
        const products = prodRes.results || [];

        // 2. Lấy chi tiết lịch sử nhập kho
        const purchaseRes = await db.prepare(`
          SELECT poi.product_id, poi.quantity, poi.total, po.created_at
          FROM purchase_order_items poi
          JOIN purchase_orders po ON poi.purchase_order_id = po.id
        `).all();
        const purchaseItems = purchaseRes.results || [];

        // 3. Lấy chi tiết lịch sử xuất kho
        const invoiceRes = await db.prepare(`
          SELECT ii.product_id, ii.quantity, inv.created_at
          FROM invoice_items ii
          JOIN invoices inv ON ii.invoice_id = inv.id
        `).all();
        const invoiceItems = invoiceRes.results || [];

        const cleanStart = startDate.slice(0, 10);
        const cleanEnd = endDate.slice(0, 10);

        // 4. Tính toán số liệu cho từng sản phẩm
        const reportData = products.map(p => {
          const unitCost = Number(p.cost_price) || 0;
          const currentStock = Number(p.stock) || 0;
          const prodCode = String(p.code || p.product_code || p.sku || '---');
          const prodName = String(p.name || p.product_name || 'Không tên');
          const prodUnit = String(p.unit || 'Cái');

          // Lọc lượng nhập trong kỳ
          const pImports = purchaseItems.filter(i => {
            if (String(i.product_id) !== String(p.id)) return false;
            const itemDate = (i.created_at || '').slice(0, 10);
            if (!itemDate) return true; 
            return itemDate >= cleanStart && itemDate <= cleanEnd;
          });

          const importQty = pImports.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
          const importVal = pImports.reduce((sum, i) => sum + (Number(i.total) || (Number(i.quantity) * unitCost)), 0);

          // Lọc lượng xuất trong kỳ
          const pExports = invoiceItems.filter(i => {
            if (String(i.product_id) !== String(p.id)) return false;
            const itemDate = (i.created_at || '').slice(0, 10);
            if (!itemDate) return false;
            return itemDate >= cleanStart && itemDate <= cleanEnd;
          });

          const exportQty = pExports.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
          const exportVal = exportQty * unitCost;

          const closingQty = currentStock;
          const closingVal = closingQty * unitCost;
          const openingQty = closingQty - importQty + exportQty;
          const openingVal = openingQty * unitCost;

          return {
            id: p.id,
            code: prodCode,
            name: prodName,
            unit: prodUnit,
            openingQty,
            openingVal,
            importQty,
            importVal,
            exportQty,
            exportVal,
            closingQty,
            closingVal
          };
        });

        // 5. Chỉ hiển thị sản phẩm có phát sinh và khớp từ khóa tìm kiếm
        const activeItems = reportData.filter(item => {
          const hasActivity = item.openingQty !== 0 || item.importQty !== 0 || item.exportQty !== 0 || item.closingQty !== 0;
          const matchesSearch = item.code.toLowerCase().includes(search) || item.name.toLowerCase().includes(search);
          return hasActivity && matchesSearch;
        });

        // 6. Tính tổng cộng
        const totals = activeItems.reduce((acc, item) => {
          acc.openingQty += item.openingQty;
          acc.openingVal += item.openingVal;
          acc.importQty += item.importQty;
          acc.importVal += item.importVal;
          acc.exportQty += item.exportQty;
          acc.exportVal += item.exportVal;
          acc.closingQty += item.closingQty;
          acc.closingVal += item.closingVal;
          return acc;
        }, { openingQty: 0, openingVal: 0, importQty: 0, importVal: 0, exportQty: 0, exportVal: 0, closingQty: 0, closingVal: 0 });

        return json({
          success: true,
          summary: { 
            totalOpeningVal: totals.openingVal, 
            totalImportVal: totals.importVal, 
            totalExportVal: totals.exportVal, 
            totalClosingVal: totals.closingVal 
          },
          totals,
          items: activeItems
        }, 200, origin);
      }
      // ===== Route /api không tồn tại: trả 404 JSON, KHÔNG rơi xuống ASSETS =====
      // (trước đây request lạ như PUT /api/purchase_orders/1 nhận về index.html với status 200 -> frontend báo "thành công" giả)
      if (pathname.startsWith('/api/')) return json({ error: 'Không tìm thấy API' }, 404, origin);

      // Phục vụ giao diện Frontend
      if (env.ASSETS) return await env.ASSETS.fetch(request);
      return json({ error: 'Không tìm thấy' }, 404, origin);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, origin);
      console.error(e);
      return json({ error: 'Lỗi chi tiết: ' + e.message }, 500, origin);
    }
  },
};
