// Cloudflare Worker + D1 — API cho POS xe đạp điện (Full: Bán hàng, Nhập hàng & Phục vụ Static Assets)

const json = (data, status = 200, origin = '*') =>
  new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const genCode = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

// Gộp các dòng trùng sản phẩm + kiểm tra đầu vào
function parseItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Giỏ hàng trống');
  const map = new Map();
  for (const it of items) {
    const id = Number(it.product_id), qty = Number(it.quantity);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty <= 0)
      throw new HttpError(400, 'Sản phẩm hoặc số lượng không hợp lệ');
    map.set(id, (map.get(id) || 0) + qty);
  }
  return map;
}

// Lấy giá từ DB (không tin giá do client gửi lên)
async function loadLines(db, qtyMap, { checkStock }) {
  const ids = [...qtyMap.keys()];
  const { results } = await db
    .prepare(`SELECT id, name, price, stock FROM products WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids).all();
  if (results.length !== ids.length) throw new HttpError(404, 'Có sản phẩm không tồn tại');
  return results.map((p) => {
    const quantity = qtyMap.get(p.id);
    if (checkStock && p.stock < quantity)
      throw new HttpError(409, `"${p.name}" chỉ còn ${p.stock} trong kho`);
    return { product_id: p.id, quantity, unit_price: p.price };
  });
}

const totalOf = (lines) => lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);

// POST /api/orders — chỉ lưu, KHÔNG đụng tới tồn kho
async function createOrder(db, body) {
  const name = String(body.customer_name || '').trim();
  if (!name) throw new HttpError(400, 'Thiếu tên khách hàng');
  const lines = await loadLines(db, parseItems(body.items), { checkStock: false });
  const code = genCode('DH');

  await db.batch([
    db.prepare('INSERT INTO orders (code, customer_name, customer_phone, note, total) VALUES (?,?,?,?,?)')
      .bind(code, name, body.customer_phone || null, body.note || null, totalOf(lines)),
    ...lines.map((l) =>
      db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ((SELECT id FROM orders WHERE code = ?),?,?,?)')
        .bind(code, l.product_id, l.quantity, l.unit_price)),
  ]);
  return { code, total: totalOf(lines) };
}

// POST /api/invoices — tạo hóa đơn + trừ kho trong MỘT batch (D1 batch = transaction)
async function createInvoice(db, body) {
  const name = String(body.customer_name || '').trim();
  if (!name) throw new HttpError(400, 'Thiếu tên khách hàng');
  const lines = await loadLines(db, parseItems(body.items), { checkStock: true });
  const code = genCode('HD');
  const orderId = body.order_id ? Number(body.order_id) : null;

  const stmts = [
    db.prepare('INSERT INTO invoices (code, order_id, customer_name, customer_phone, note, total) VALUES (?,?,?,?,?,?)')
      .bind(code, orderId, name, body.customer_phone || null, body.note || null, totalOf(lines)),
    ...lines.map((l) =>
      db.prepare('INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price) VALUES ((SELECT id FROM invoices WHERE code = ?),?,?,?)')
        .bind(code, l.product_id, l.quantity, l.unit_price)),
    ...lines.map((l) =>
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').bind(l.quantity, l.product_id)),
  ];
  if (orderId)
    stmts.push(db.prepare("UPDATE orders SET status = 'invoiced' WHERE id = ? AND status = 'pending'").bind(orderId));

  try {
    await db.batch(stmts);
  } catch (e) {
    if (/CHECK constraint|constraint failed/i.test(String(e.message)))
      throw new HttpError(409, 'Tồn kho vừa thay đổi, không đủ hàng. Vui lòng tải lại và thử lại');
    throw e;
  }
  return { code, total: totalOf(lines) };
}

// POST /api/purchases — tạo phiếu nhập + cộng tồn kho
async function createPurchaseOrder(db, body) {
  const lines = await loadLines(db, parseItems(body.items), { checkStock: false });
  const code = genCode('NK');
  const supplierId = body.supplier_id ? Number(body.supplier_id) : null;

  const stmts = [
    db.prepare('INSERT INTO purchase_orders (code, supplier_id, note, total) VALUES (?,?,?,?)')
      .bind(code, supplierId, body.note || null, totalOf(lines)),
    ...lines.map((l) =>
      db.prepare('INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_price) VALUES ((SELECT id FROM purchase_orders WHERE code = ?),?,?,?)')
        .bind(code, l.product_id, l.quantity, l.unit_price)),
    ...lines.map((l) =>
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').bind(l.quantity, l.product_id)),
  ];

  await db.batch(stmts);
  return { code, total: totalOf(lines) };
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const url = new URL(request.url);
    const { pathname } = url;
    const db = env.DB;

    if (request.method === 'OPTIONS') return json(null, 204, origin);

    try {
      // --- CÁC API ROUTE ---
      if (pathname === '/api/products' && request.method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM products ORDER BY name').all();
        return json(results, 200, origin);
      }
      if (pathname === '/api/orders' && request.method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 50').all();
        return json(results, 200, origin);
      }
      if (pathname === '/api/invoices' && request.method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT 50').all();
        return json(results, 200, origin);
      }
      if (pathname === '/api/orders' && request.method === 'POST')
        return json(await createOrder(db, await request.json()), 201, origin);
      if (pathname === '/api/invoices' && request.method === 'POST')
        return json(await createInvoice(db, await request.json()), 201, origin);

      // Nhà cung cấp
      if (pathname === '/api/suppliers' && request.method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM suppliers ORDER BY name').all();
        return json(results, 200, origin);
      }
      if (pathname === '/api/suppliers' && request.method === 'POST') {
        const b = await request.json();
        const name = String(b.name || '').trim();
        if (!name) throw new HttpError(400, 'Thiếu tên nhà cung cấp');
        await db.prepare('INSERT INTO suppliers (name, phone, address) VALUES (?,?,?)')
          .bind(name, b.phone || null, b.address || null).run();
        return json({ success: true }, 201, origin);
      }

      // Thêm vào file index.js phần API cho suppliers
      // Lấy danh sách nhà cung cấp kèm theo tính toán Tổng nhập, Đã thanh toán, Công nợ
      if (pathname === '/api/suppliers' && request.method === 'GET') {
        const query = `
          SELECT 
            s.*,
            COALESCE(SUM(DISTINCT p.total), 0) as total_purchase,
            COALESCE(SUM(DISTINCT pay.amount), 0) as total_paid,
            (COALESCE(SUM(DISTINCT p.total), 0) - COALESCE(SUM(DISTINCT pay.amount), 0)) as total_debt
          FROM suppliers s
          LEFT JOIN purchase_orders p ON s.id = p.supplier_id
          LEFT JOIN supplier_payments pay ON s.id = pay.supplier_id
          GROUP BY s.id
          ORDER BY s.id DESC
        `;
        const { results } = await db.prepare(query).all();
        return json(results || [], 200, origin);
      }

      // POST /api/suppliers — Thêm nhà cung cấp mới
      
      if (pathname === '/api/suppliers' && request.method === 'POST') {
        const b = await request.json();
        const name = String(b.name || '').trim();
        if (!name) throw new HttpError(400, 'Thiếu tên nhà cung cấp');
        
        // Lấy mã do người dùng nhập, nếu để trống thì tự sinh mã
        const code = String(b.code || '').trim() || genCode('NCC');
        const phone = String(b.phone || '').trim() || null;
        const address = String(b.address || '').trim() || null;
        const status = b.status || 'active';

        try {
          await db.prepare('INSERT INTO suppliers (code, name, phone, address, status) VALUES (?, ?, ?, ?, ?)')
            .bind(code, name, phone, address, status).run();
        } catch (err) {
          if (err.message && err.message.includes('UNIQUE')) {
            throw new HttpError(400, 'Trùng mã NCC');
          }
          throw err;
        }
          
        return json({ success: true, code }, 201, origin);
      }

      // PUT /api/suppliers/:id — Sửa thông tin nhà cung cấp
      if (pathname.match(/^\/api\/suppliers\/\d+$/) && request.method === 'PUT') {
        const id = pathname.split('/')[3];
        const b = await request.json();
        const name = String(b.name || '').trim();
        if (!name) throw new HttpError(400, 'Thiếu tên nhà cung cấp');
        
        const code = String(b.code || '').trim() || 'NCC-DEFAULT';
        const phone = String(b.phone || '').trim() || null;
        const address = String(b.address || '').trim() || null;
        const status = b.status || 'active';

        try {
          await db.prepare('UPDATE suppliers SET code = ?, name = ?, phone = ?, address = ?, status = ? WHERE id = ?')
            .bind(code, name, phone, address, status, id).run();
        } catch (err) {
          if (err.message && err.message.includes('UNIQUE')) {
            throw new HttpError(400, 'Trùng mã NCC');
          }
          throw err;
        }

        return json({ success: true }, 200, origin);
      }

      // DELETE /api/suppliers/:id — Xóa nhà cung cấp
      if (pathname.match(/^\/api\/suppliers\/\d+$/) && request.method === 'DELETE') {
        const id = pathname.split('/')[3];
        await db.prepare('DELETE FROM suppliers WHERE id = ?').bind(id).run();
        return json({ success: true }, 200, origin);
      }

      // GET /api/suppliers/:id/history — Lấy chi tiết lịch sử (nhập hàng, thanh toán, trả hàng)
      if (pathname.match(/^\/api\/suppliers\/\d+\/history$/) && request.method === 'GET') {
        const id = pathname.split('/')[3];
        let purchases = { results: [] };
        let payments = { results: [] };
        let returns = { results: [] };

        try {
          purchases = await db.prepare('SELECT * FROM purchase_orders WHERE supplier_id = ? ORDER BY id DESC').bind(id).all();
        } catch (e) {}

        try {
          payments = await db.prepare('SELECT * FROM supplier_payments WHERE supplier_id = ? ORDER BY id DESC').bind(id).all();
        } catch (e) {}

        try {
          returns = await db.prepare('SELECT * FROM supplier_returns WHERE supplier_id = ? ORDER BY id DESC').bind(id).all();
        } catch (e) {}

        return json({ 
          purchases: purchases.results || [], 
          payments: payments.results || [], 
          returns: returns.results || [] 
        }, 200, origin);
      }
      // Nhập hàng
      if (pathname === '/api/purchases' && request.method === 'GET') {
        const { results } = await db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC LIMIT 50').all();
        return json(results, 200, origin);
      }
      if (pathname === '/api/purchases' && request.method === 'POST')
        return json(await createPurchaseOrder(db, await request.json()), 201, origin);

      // --- PHỤC VỤ GIAO DIỆN FRONTEND (REACT APP) ---
      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return json({ error: 'Không tìm thấy' }, 404, origin);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, origin);
      console.error(e);
      // TRẢ VẺ LỖI CHI TIẾT ĐỂ GIAO DIỆN HIỂN THỊ RÕ NGUYÊN NHÂN
      return json({ error: 'Lỗi chi tiết: ' + e.message }, 500, origin);
    }
  },
};
